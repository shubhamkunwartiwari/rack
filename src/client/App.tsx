import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { TEMPLATES } from '../shared/templates'
import type {
  Block,
  Edge,
  Eval,
  GraphPayload,
  PlanPayload,
  Project,
  ProjectSettings,
  ProjectStage,
  ProjectSummary,
  Role,
  Session,
  Stage,
  TemplateId,
} from '../shared/types'
import { Canvas } from './Canvas'
import { Dashboard, StagePill } from './Dashboard'
import { clearDraft, readDraft, storeDraft } from './drafts'
import { Evals } from './Evals'
import { Pipeline } from './Pipeline'
import { Team } from './Team'
import { estimateProject } from '../shared/estimate'
import { download, projectMarkdown, safeFilename } from './exportSpec'
import {
  formatDate,
  formatParams,
  jsonInit,
  relativeDate,
  request,
} from './lib'
import {
  Field,
  Icon,
  Modal,
  Segmented,
  Skeleton,
  Toasts,
  type Toast,
} from './ui'

type View = 'model' | 'pipeline' | 'team' | 'evals'
type Route = { kind: 'dashboard' } | { kind: 'project'; id: string; view: View }
type SaveState = 'saved' | 'saving' | 'offline' | 'error'

const VIEWS: { id: View; label: string }[] = [
  { id: 'model', label: 'Model' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'team', label: 'Team' },
  { id: 'evals', label: 'Evals' },
]

const STAGES: ProjectStage[] = ['scoping', 'design', 'training', 'evaluating', 'shipping']

function parsePath(path: string): Route {
  const match = path.match(/^\/p\/([^/]+)(?:\/(model|pipeline|team|evals))?\/?$/)
  if (match)
    return { kind: 'project', id: match[1]!, view: (match[2] as View | undefined) ?? 'model' }
  return { kind: 'dashboard' }
}

function toDateInput(ts: number): string {
  const date = new Date(ts)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [sessionError, setSessionError] = useState('')
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [project, setProject] = useState<Project | null>(null)
  const [projectLoading, setProjectLoading] = useState(false)
  const [projectError, setProjectError] = useState('')
  const [route, setRoute] = useState<Route>(() => parsePath(window.location.pathname))
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [toasts, setToasts] = useState<Toast[]>([])
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const [newTemplate, setNewTemplate] = useState<TemplateId>('dense')
  const [newName, setNewName] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [avatarOpen, setAvatarOpen] = useState(false)
  const [creating, setCreating] = useState(false)

  const queue = useRef<{
    id?: string
    graph?: GraphPayload
    plan?: PlanPayload
    settings?: ProjectSettings
  }>({})
  const timer = useRef<number | undefined>(undefined)
  const projectRef = useRef<Project | null>(null)
  projectRef.current = project
  const flushRef = useRef<() => Promise<void>>(async () => {})

  const notify = useCallback((message: string, action?: Toast['action']) => {
    const id = crypto.randomUUID()
    setToasts((previous) => [...previous, { id, message, action }].slice(-3))
    window.setTimeout(() => {
      setToasts((previous) => previous.filter((toast) => toast.id !== id))
    }, 4600)
  }, [])

  const navigate = useCallback((path: string) => {
    window.history.pushState({}, '', path)
    setRoute(parsePath(path))
  }, [])

  useEffect(() => {
    const onPop = () => setRoute(parsePath(window.location.pathname))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true)
    try {
      const result = await request<{ projects: ProjectSummary[] }>('/api/projects')
      setProjects(result.projects)
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not load plans.')
    } finally {
      setProjectsLoading(false)
    }
  }, [notify])

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const current = await request<Session>('/api/session')
        if (!live) return
        setSession(current)
        if (current.user && current.database) await loadProjects()
      } catch (error) {
        if (live)
          setSessionError(
            error instanceof Error ? error.message : 'Could not start the workspace.',
          )
      }
    })()
    return () => {
      live = false
    }
  }, [loadProjects])

  const projectId = route.kind === 'project' ? route.id : null

  useEffect(() => {
    if (!projectId) {
      setProject(null)
      setProjectError('')
      return
    }
    let live = true
    setProjectLoading(true)
    setProjectError('')
    void (async () => {
      try {
        const result = await request<{ project: Project }>(`/api/projects/${projectId}`)
        if (!live) return
        const server = result.project
        // A draft from this browser that the server never received wins over the
        // stored copy, then goes back through the normal save path.
        const draft = readDraft(projectId)
        if (draft && draft.at > server.updatedAt) {
          setProject({
            ...server,
            settings: draft.settings ?? server.settings,
            blocks: draft.graph?.blocks ?? server.blocks,
            edges: draft.graph?.edges ?? server.edges,
            stages: draft.plan?.stages ?? server.stages,
            roles: draft.plan?.roles ?? server.roles,
            evals: draft.plan?.evals ?? server.evals,
          })
          queue.current = {
            id: projectId,
            graph: draft.graph,
            plan: draft.plan,
            settings: draft.settings,
          }
          setSaveState('saving')
          timer.current = window.setTimeout(() => void flushRef.current(), 800)
          notify('Recovered unsaved changes from this browser.')
        } else {
          if (draft) clearDraft(projectId)
          setProject(server)
        }
      } catch (error) {
        if (!live) return
        setProjectError(error instanceof Error ? error.message : 'Could not load that plan.')
      } finally {
        if (live) setProjectLoading(false)
      }
    })()
    return () => {
      live = false
    }
  }, [projectId])

  useEffect(() => {
    if (route.kind === 'dashboard' && session?.user && session.database) void loadProjects()
    // Refetching summaries whenever the dashboard is opened keeps counts current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route])

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current)
    const pending = queue.current
    queue.current = {}
    if (!pending.id) return
    try {
      if (pending.graph)
        await request(`/api/projects/${pending.id}/graph`, jsonInit('PUT', pending.graph))
      if (pending.plan)
        await request(`/api/projects/${pending.id}/plan`, jsonInit('PUT', pending.plan))
      if (pending.settings)
        await request(`/api/projects/${pending.id}/settings`, jsonInit('PUT', pending.settings))
      setSaveState('saved')
      // Edits queued while this save was in flight keep their own draft.
      if (!queue.current.id) clearDraft(pending.id)
    } catch (error) {
      // Put the draft back so a failed save can never silently drop an edit.
      queue.current = {
        id: pending.id,
        graph: pending.graph ?? queue.current.graph,
        plan: pending.plan ?? queue.current.plan,
        settings: pending.settings ?? queue.current.settings,
      }
      storeDraft({ ...queue.current, id: pending.id, at: Date.now() })
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setSaveState('offline')
        notify('You are offline. Changes are kept and saved when the connection returns.')
      } else {
        setSaveState('error')
        notify(error instanceof Error ? error.message : 'Could not save the plan.')
      }
    }
  }, [notify])
  flushRef.current = flush

  const queueSave = useCallback(
    (patch: { graph?: GraphPayload; plan?: PlanPayload; settings?: ProjectSettings }) => {
      const id = projectRef.current?.id
      if (!id) return
      queue.current = { ...queue.current, ...patch, id }
      // Mirror the pending edit immediately so a refresh inside the debounce
      // window cannot lose it; the key is cleared once the save lands.
      storeDraft({ ...queue.current, id, at: Date.now() })
      setSaveState('saving')
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => void flush(), 800)
    },
    [flush],
  )

  useEffect(() => {
    const goOffline = () => {
      if (queue.current.id) setSaveState('offline')
    }
    const goOnline = () => {
      if (!queue.current.id) return
      setSaveState('saving')
      void flush()
    }
    window.addEventListener('offline', goOffline)
    window.addEventListener('online', goOnline)
    return () => {
      window.removeEventListener('offline', goOffline)
      window.removeEventListener('online', goOnline)
    }
  }, [flush])

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (queue.current.id) {
        event.preventDefault()
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  const updateGraph = useCallback(
    (blocks: Block[], edges: Edge[]) => {
      setProject((current) => (current ? { ...current, blocks, edges } : current))
      queueSave({ graph: { blocks, edges } })
    },
    [queueSave],
  )

  const updatePlan = useCallback(
    (stages: Stage[], roles: Role[], evals: Eval[]) => {
      setProject((current) => (current ? { ...current, stages, roles, evals } : current))
      queueSave({ plan: { stages, roles, evals } })
    },
    [queueSave],
  )

  const updateSettings = useCallback(
    (settings: ProjectSettings) => {
      setProject((current) => (current ? { ...current, settings } : current))
      queueSave({ settings })
    },
    [queueSave],
  )

  const openProject = useCallback(
    (id: string, view: View = 'model') => {
      void flush()
      navigate(`/p/${id}/${view}`)
    },
    [flush, navigate],
  )

  const goDashboard = useCallback(() => {
    void flush()
    navigate('/')
  }, [flush, navigate])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey
      const target = event.target
      const typing =
        target instanceof HTMLElement &&
        (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
          target.isContentEditable ||
          Boolean(target.closest('.overlay')))
      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen(true)
      } else if (event.key === '?' && !typing) {
        event.preventDefault()
        setShortcutsOpen(true)
      } else if (event.key === 'Escape') {
        setSwitcherOpen(false)
        setAvatarOpen(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  async function createProject() {
    if (creating) return
    setCreating(true)
    try {
      const result = await request<{ project: Project }>(
        '/api/projects',
        jsonInit('POST', { name: newName.trim() || undefined, template: newTemplate }),
      )
      setNewOpen(false)
      setNewName('')
      await loadProjects()
      openProject(result.project.id, 'model')
      notify(`${result.project.name} created`)
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not create that plan.')
    } finally {
      setCreating(false)
    }
  }

  async function deleteProject(id: string) {
    try {
      await request(`/api/projects/${id}`, { method: 'DELETE' })
      setProjects((previous) => previous.filter((item) => item.id !== id))
      if (project?.id === id) navigate('/')
      notify('Plan deleted')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not delete that plan.')
    }
  }

  async function saveSettings(patch: {
    name: string
    brief: string
    stage: ProjectStage
    startDate: number
  }) {
    if (!project) return
    try {
      const result = await request<{ project: Project }>(
        `/api/projects/${project.id}`,
        jsonInit('PATCH', patch),
      )
      setProject(result.project)
      setProjects((previous) =>
        previous.map((item) =>
          item.id === result.project.id
            ? {
                ...item,
                name: result.project.name,
                brief: result.project.brief,
                stage: result.project.stage,
              }
            : item,
        ),
      )
      setSettingsOpen(false)
      notify('Plan details saved')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not save plan details.')
    }
  }

  function exportMarkdown() {
    if (!project) return
    download(`${safeFilename(project.name)}.md`, projectMarkdown(project), 'text/markdown')
    setExportOpen(false)
    notify('Markdown spec downloaded')
  }

  function exportJson() {
    if (!project) return
    download(
      `${safeFilename(project.name)}.json`,
      JSON.stringify(project, null, 2),
      'application/json',
    )
    setExportOpen(false)
    notify('Plan JSON downloaded')
  }

  if (sessionError) {
    return (
      <div className="boot">
        <div className="boot-card">
          <span className="mark">Rack</span>
          <h1>The workspace did not start.</h1>
          <p>{sessionError}</p>
          <button className="primary" onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  if (!session) {
    return (
      <div className="boot">
        <div className="boot-card">
          <span className="mark">Rack</span>
          <Skeleton rows={3} />
        </div>
      </div>
    )
  }

  if (!session.user) {
    return (
      <div className="boot">
        <div className="boot-card signin">
          <span className="mark">Rack</span>
          <h1>Plan the run before you run it.</h1>
          <p>
            Map a model architecture, timeline the training stages and staff the
            team. Every plan is private to your account.
          </p>
          {session.mode === 'freebuff' ? (
            <a className="primary" href="/auth/freebuff/signin?returnTo=%2F">
              Sign in with Freebuff
            </a>
          ) : (
            <p className="notice">
              This app is still being set up. Please try again later.
            </p>
          )}
        </div>
      </div>
    )
  }

  if (!session.database) {
    return (
      <div className="boot">
        <div className="boot-card">
          <span className="mark">Rack</span>
          <h1>Storage is not attached yet.</h1>
          <p>
            The workspace needs its database before plans can be saved. Please try
            again once setup finishes.
          </p>
        </div>
      </div>
    )
  }

  const enabled = Boolean(project)
  const view = route.kind === 'project' ? route.view : 'model'
  // Remounting the main region replays the 320ms view-enter transition.
  const viewKey = route.kind === 'dashboard' ? 'dashboard' : `${route.id}:${route.view}`

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <button className="brand" onClick={goDashboard} aria-label="Rack, all plans">
            <span className="brand-mark" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="2" y="3" width="5" height="5" rx="1" />
                <rect x="11" y="3" width="5" height="5" rx="1" />
                <rect x="2" y="10" width="5" height="5" rx="1" />
                <rect x="11" y="10" width="5" height="5" rx="1" />
              </svg>
            </span>
            Rack
          </button>
          <span className="topbar-sep" />
          <div className="switcher-wrap">
            <button
              className="switcher"
              onClick={() => setSwitcherOpen((open) => !open)}
              aria-expanded={switcherOpen}
            >
              <span className="switcher-name">{project?.name ?? 'All plans'}</span>
              <Icon name="chevron" size={12} />
            </button>
            {switcherOpen && (
              <>
                <div className="scrim" onClick={() => setSwitcherOpen(false)} />
                <div className="dropdown switcher-menu">
                  <button className="dropdown-item" onClick={() => { setSwitcherOpen(false); goDashboard() }}>
                    <Icon name="projects" size={13} /> All plans
                    <span className="mono muted">{projects.length}</span>
                  </button>
                  <div className="dropdown-rule" />
                  {projects.map((item) => (
                    <button
                      key={item.id}
                      className={`dropdown-item${item.id === project?.id ? ' on' : ''}`}
                      onClick={() => {
                        setSwitcherOpen(false)
                        openProject(item.id, view === 'model' ? 'model' : view)
                      }}
                    >
                      <span className="swatch" data-stage={item.stage} />
                      <span className="dropdown-name">{item.name}</span>
                      <span className="mono muted">{formatParams(item.params)}</span>
                    </button>
                  ))}
                  <div className="dropdown-rule" />
                  <button className="dropdown-item" onClick={() => { setSwitcherOpen(false); setNewOpen(true) }}>
                    <Icon name="plus" size={13} /> New plan
                  </button>
                  {project && (
                    <button className="dropdown-item" onClick={() => { setSwitcherOpen(false); setSettingsOpen(true) }}>
                      <Icon name="settings" size={13} /> Plan details
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        <nav className="view-tabs" aria-label="Plan views">
          {enabled &&
            VIEWS.map((item) => (
              <button
                key={item.id}
                className={view === item.id ? 'on' : ''}
                aria-current={view === item.id}
                onClick={() => project && navigate(`/p/${project.id}/${item.id}`)}
              >
                {item.label}
              </button>
            ))}
        </nav>

        <div className="topbar-right">
          {session.mode === 'local' && <span className="local-chip mono">local</span>}
          {project && (
            <span className="save-indicator mono" data-state={saveState} title="Autosave state">
              {saveState === 'saved'
                ? 'saved'
                : saveState === 'saving'
                  ? 'saving…'
                  : saveState === 'offline'
                    ? 'offline'
                    : 'save failed'}
            </span>
          )}
          {project && (
            <button className="icon-btn" aria-label="Export plan" title="Export" onClick={() => setExportOpen(true)}>
              <Icon name="export" />
            </button>
          )}
          <button className="kbd-btn" onClick={() => setPaletteOpen(true)}>
            <Icon name="search" size={13} />
            <span>Search</span>
            <kbd>⌘K</kbd>
          </button>
          <div className="switcher-wrap">
            <button
              className="avatar"
              aria-label="Account"
              onClick={() => setAvatarOpen((open) => !open)}
            >
              {(session.user.name || session.user.email || 'R').slice(0, 1).toUpperCase()}
            </button>
            {avatarOpen && (
              <>
                <div className="scrim" onClick={() => setAvatarOpen(false)} />
                <div className="dropdown avatar-menu">
                  <div className="avatar-id">
                    <strong>{session.user.name || 'Signed in'}</strong>
                    <span className="muted">{session.user.email || session.user.sub}</span>
                  </div>
                  <div className="dropdown-rule" />
                  <button className="dropdown-item" onClick={() => { setAvatarOpen(false); setShortcutsOpen(true) }}>
                    <Icon name="help" size={13} /> Keyboard shortcuts
                  </button>
                  {session.mode === 'freebuff' && (
                    <form method="post" action="/auth/freebuff/signout">
                      <button className="dropdown-item" type="submit">
                        Sign out
                      </button>
                    </form>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="shell">
        <nav className="rail" aria-label="Workspace">
          <button className="rail-btn" aria-label="All plans" title="All plans" onClick={goDashboard}>
            <Icon name="projects" size={17} />
          </button>
          <button
            className="rail-btn"
            aria-label="New plan"
            title="New plan"
            onClick={() => setNewOpen(true)}
          >
            <Icon name="plus" size={17} />
          </button>
          <div className="rail-spacer" />
          <button
            className="rail-btn"
            aria-label="Plan details"
            title="Plan details"
            disabled={!project}
            onClick={() => setSettingsOpen(true)}
          >
            <Icon name="settings" size={17} />
          </button>
          <button
            className="rail-btn"
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
            onClick={() => setShortcutsOpen(true)}
          >
            <Icon name="help" size={17} />
          </button>
        </nav>

        <main className="main" key={viewKey}>
          {route.kind === 'dashboard' ? (
            <Dashboard
              projects={projects}
              loading={projectsLoading}
              onOpen={openProject}
              onNew={(template) => {
                setNewTemplate(template ?? 'dense')
                setNewOpen(true)
              }}
              onDelete={deleteProject}
            />
          ) : projectLoading || !project ? (
            <div className="page">
              {projectError ? (
                <div className="empty-state bordered">
                  <span className="empty-mark">⌗</span>
                  <h3>That plan could not be opened</h3>
                  <p>{projectError}</p>
                  <button className="secondary" onClick={goDashboard}>
                    Back to all plans
                  </button>
                </div>
              ) : (
                <>
                  <Skeleton rows={2} />
                  <div className="canvas-skeleton">
                    <Skeleton rows={5} />
                  </div>
                </>
              )}
            </div>
          ) : (
            <>
              {view === 'model' && (
                <Canvas
                  project={project}
                  saveState={saveState}
                  onGraph={updateGraph}
                  onSettings={updateSettings}
                  notify={notify}
                />
              )}
              {view === 'pipeline' && (
                <Pipeline project={project} onPlan={updatePlan} notify={notify} />
              )}
              {view === 'team' && <Team project={project} onPlan={updatePlan} notify={notify} />}
              {view === 'evals' && <Evals project={project} onPlan={updatePlan} notify={notify} />}
            </>
          )}
        </main>
      </div>

      <Toasts
        toasts={toasts}
        dismiss={(id) => setToasts((previous) => previous.filter((toast) => toast.id !== id))}
      />

      {newOpen && (
        <Modal
          wide
          title="New plan"
          subtitle="Start from a seed, then change anything."
          onClose={() => setNewOpen(false)}
          footer={
            <>
              <button className="quiet" onClick={() => setNewOpen(false)}>
                Cancel
              </button>
              <button className="primary" disabled={creating} onClick={() => void createProject()}>
                {creating ? 'Creating…' : 'Create plan'}
              </button>
            </>
          }
        >
          <Field label="Plan name" hint="optional">
            <input
              className="input"
              value={newName}
              maxLength={80}
              placeholder={TEMPLATES.find((item) => item.id === newTemplate)?.projectName}
              onChange={(event) => setNewName(event.target.value)}
            />
          </Field>
          <div className="template-choices">
            {TEMPLATES.map((template) => (
              <button
                key={template.id}
                className={`template-choice${newTemplate === template.id ? ' on' : ''}`}
                aria-pressed={newTemplate === template.id}
                onClick={() => setNewTemplate(template.id)}
              >
                <span className="template-tag">{template.tag}</span>
                <strong>{template.name}</strong>
                <span>{template.blurb}</span>
              </button>
            ))}
          </div>
        </Modal>
      )}

      {settingsOpen && project && (
        <PlanSettings
          project={project}
          onClose={() => setSettingsOpen(false)}
          onSave={saveSettings}
        />
      )}

      {exportOpen && project && (
        <Modal
          title="Export plan"
          subtitle={`${project.name} · ${formatParams(
            estimateProject(project.blocks, project.settings).params,
          )} estimated parameters`}
          onClose={() => setExportOpen(false)}
        >
          <div className="export-actions">
            <button className="export-card" onClick={exportMarkdown}>
              <strong>Markdown spec</strong>
              <span>
                Architecture table, parameter math, pipeline, roster and eval gates
                in one readable document.
              </span>
              <span className="mono muted">.md</span>
            </button>
            <button className="export-card" onClick={exportJson}>
              <strong>Plan JSON</strong>
              <span>
                The complete plan — blocks, edges, stages, roles and evals — for
                backup or another tool.
              </span>
              <span className="mono muted">.json</span>
            </button>
          </div>
        </Modal>
      )}

      {paletteOpen && (
        <Palette
          projects={projects}
          project={project}
          view={view}
          onClose={() => setPaletteOpen(false)}
          actions={[
            ...(project
              ? VIEWS.map((item) => ({
                  label: `Go to ${item.label}`,
                  hint: item.id,
                  run: () => navigate(`/p/${project.id}/${item.id}`),
                }))
              : []),
            {
              label: 'New plan',
              hint: 'create',
              run: () => setNewOpen(true),
            },
            ...(project
              ? [
                  {
                    label: 'Plan details',
                    hint: 'settings',
                    run: () => setSettingsOpen(true),
                  },
                  { label: 'Export Markdown spec', hint: 'export', run: exportMarkdown },
                  { label: 'Export plan JSON', hint: 'export', run: exportJson },
                ]
              : []),
            {
              label: 'Keyboard shortcuts',
              hint: '?',
              run: () => setShortcutsOpen(true),
            },
            ...projects
              .filter((item) => item.id !== project?.id)
              .map((item) => ({
                label: `Open ${item.name}`,
                hint: 'plan',
                run: () => openProject(item.id),
              })),
          ]}
        />
      )}

      {shortcutsOpen && <Shortcuts onClose={() => setShortcutsOpen(false)} />}
    </div>
  )
}

function PlanSettings({
  project,
  onClose,
  onSave,
}: {
  project: Project
  onClose: () => void
  onSave: (patch: {
    name: string
    brief: string
    stage: ProjectStage
    startDate: number
  }) => void
}) {
  const [name, setName] = useState(project.name)
  const [brief, setBrief] = useState(project.brief)
  const [stage, setStage] = useState<ProjectStage>(project.stage)
  const [start, setStart] = useState(toDateInput(project.startDate))
  return (
    <Modal
      title="Plan details"
      subtitle={`Created ${formatDate(project.createdAt)} · edited ${relativeDate(project.updatedAt)}`}
      onClose={onClose}
      footer={
        <>
          <button className="quiet" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={!name.trim()}
            onClick={() =>
              onSave({
                name: name.trim(),
                brief,
                stage,
                startDate: new Date(`${start}T00:00:00`).getTime() || project.startDate,
              })
            }
          >
            Save details
          </button>
        </>
      }
    >
      <Field label="Name">
        <input
          className="input"
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field label="Brief" hint="one line">
        <input
          className="input"
          value={brief}
          maxLength={280}
          placeholder="What is this model for?"
          onChange={(event) => setBrief(event.target.value)}
        />
      </Field>
      <Field label="Stage">
        <Segmented<ProjectStage>
          label="Plan stage"
          value={stage}
          options={STAGES.map((value) => ({
            value,
            label: value.charAt(0).toUpperCase() + value.slice(1),
          }))}
          onChange={setStage}
        />
      </Field>
      <Field label="Plan start" hint="drives the timeline">
        <input
          className="input"
          type="date"
          value={start}
          onChange={(event) => setStart(event.target.value)}
        />
      </Field>
      <div className="plan-meta">
        <StagePill stage={stage} />
        <span className="mono muted">
          {project.blocks.length} blocks · {project.stages.length} stages ·{' '}
          {project.evals.length} gates
        </span>
      </div>
    </Modal>
  )
}

function Palette({
  actions,
  onClose,
}: {
  projects: ProjectSummary[]
  project: Project | null
  view: View
  onClose: () => void
  actions: { label: string; hint: string; run: () => void }[]
}) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const filtered = actions.filter((action) =>
    action.label.toLowerCase().includes(query.toLowerCase()),
  )
  useEffect(() => {
    setIndex(0)
  }, [query])
  const run = (position: number) => {
    const action = filtered[position]
    if (!action) return
    onClose()
    action.run()
  }
  return (
    <div className="overlay palette" role="presentation" onPointerDown={onClose}>
      <div
        className="palette-box"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="palette-input">
          <Icon name="search" size={15} />
          <input
            autoFocus
            value={query}
            placeholder="Jump to a view, plan or export…"
            aria-label="Search commands"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setIndex((current) => Math.min(current + 1, filtered.length - 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setIndex((current) => Math.max(current - 1, 0))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                run(index)
              } else if (event.key === 'Escape') {
                onClose()
              }
            }}
          />
          <kbd>esc</kbd>
        </div>
        <ul className="palette-list">
          {filtered.length === 0 && <li className="palette-empty">Nothing matches that.</li>}
          {filtered.map((action, position) => (
            <li key={`${action.label}-${position}`}>
              <button
                className={position === index ? 'on' : ''}
                onMouseEnter={() => setIndex(position)}
                onClick={() => run(position)}
              >
                <span>{action.label}</span>
                <span className="mono muted">{action.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function Shortcuts({ onClose }: { onClose: () => void }) {
  const groups = [
    {
      title: 'Everywhere',
      items: [
        ['⌘K', 'Command palette'],
        ['?', 'This sheet'],
        ['Esc', 'Close menus'],
      ],
    },
    {
      title: 'Canvas',
      items: [
        ['V / C / H', 'Select, connect, pan'],
        ['Drag port', 'Connect blocks'],
        ['⌘Z / ⇧⌘Z', 'Undo / redo'],
        ['⌘D', 'Duplicate selection'],
        ['Delete', 'Remove selection'],
        ['Arrows', 'Nudge (⇧ for 10px)'],
        ['F', 'Fit graph'],
        ['Wheel', 'Zoom'],
        ['Space + drag', 'Pan'],
      ],
    },
  ]
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <div className="shortcut-groups">
        {groups.map((group) => (
          <div key={group.title}>
            <h3 className="eyebrow">{group.title}</h3>
            <dl className="shortcut-list">
              {group.items.map(([keys, label]) => (
                <div key={keys}>
                  <dt>
                    <kbd>{keys}</kbd>
                  </dt>
                  <dd>{label}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </Modal>
  )
}

class AppBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' }
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : 'Unexpected error' }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="boot">
          <div className="boot-card">
            <span className="mark">Rack</span>
            <h1>Something broke in the editor.</h1>
            <p>{this.state.error}</p>
            <button className="primary" onClick={() => this.setState({ error: '' })}>
              Retry view
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export function AppWithBoundary() {
  return (
    <AppBoundary>
      <App />
    </AppBoundary>
  )
}
