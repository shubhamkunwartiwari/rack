import { useState } from 'react'
import { TEMPLATES } from '../shared/templates'
import type { ProjectStage, ProjectSummary, TemplateId } from '../shared/types'
import {
  formatDate,
  formatParams,
  relativeDate,
} from './lib'
import { EmptyState, Icon, Modal, Sparkbars } from './ui'

const STAGE_LABEL: Record<ProjectStage, string> = {
  scoping: 'Scoping',
  design: 'Design',
  training: 'Training',
  evaluating: 'Evaluating',
  shipping: 'Shipping',
}

export function StagePill({ stage }: { stage: ProjectStage }) {
  return <span className={`stage-pill stage-${stage}`}>{STAGE_LABEL[stage]}</span>
}

export function Dashboard({
  projects,
  loading,
  onOpen,
  onNew,
  onDelete,
}: {
  projects: ProjectSummary[]
  loading: boolean
  onOpen: (id: string) => void
  onNew: (template?: TemplateId) => void
  onDelete: (id: string) => Promise<void>
}) {
  const [confirming, setConfirming] = useState<ProjectSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const totalParams = projects.reduce((sum, project) => sum + project.params, 0)
  const totalTeam = projects.reduce((sum, project) => sum + project.teamSize, 0)

  return (
    <div className="page dashboard">
      <header className="page-head">
        <div>
          <span className="eyebrow">Workspace</span>
          <h1>LLM plans</h1>
          <p className="lede">
            Architecture, pipeline and team in one place. Every number is an
            estimate drawn from the graph you build.
          </p>
        </div>
        <button className="primary" onClick={() => onNew()}>
          <Icon name="plus" /> New plan
        </button>
      </header>

      {projects.length > 0 && (
        <div className="stat-strip">
          <div>
            <span className="stat-label">Plans</span>
            <span className="stat-value mono">{projects.length}</span>
          </div>
          <div>
            <span className="stat-label">Mapped parameters</span>
            <span className="stat-value mono">{formatParams(totalParams)}</span>
          </div>
          <div>
            <span className="stat-label">People planned</span>
            <span className="stat-value mono">{totalTeam}</span>
          </div>
        </div>
      )}

      {loading ? (
        <div className="card-grid">
          {[0, 1, 2].map((index) => (
            <div className="project-card skeleton-card" key={index}>
              <span className="skeleton-line" />
              <span className="skeleton-line short" />
              <span className="skeleton-line" />
            </div>
          ))}
        </div>
      ) : projects.length === 0 ? (
        <div className="empty-wrap">
          <EmptyState
            title="No plans yet"
            action={
              <button className="primary" onClick={() => onNew()}>
                <Icon name="plus" /> Start a plan
              </button>
            }
          >
            Pick a seed to see how the graph, pipeline and team fit together.
          </EmptyState>
          <div className="template-grid">
            {TEMPLATES.filter((template) => template.id !== 'blank').map((template) => (
              <button
                className="template-card"
                key={template.id}
                onClick={() => onNew(template.id)}
              >
                <span className="template-tag">{template.tag}</span>
                <strong>{template.name}</strong>
                <span>{template.blurb}</span>
                <span className="template-go">Use this seed →</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="card-grid">
          {projects.map((project) => (
            <article
              className="project-card"
              key={project.id}
              tabIndex={0}
              role="link"
              onClick={() => onOpen(project.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onOpen(project.id)
                }
              }}
            >
              <div className="card-top">
                <StagePill stage={project.stage} />
                <button
                  className="icon-btn small card-menu"
                  aria-label={`Delete ${project.name}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    setConfirming(project)
                  }}
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
              <h2>{project.name}</h2>
              <p className="card-brief">{project.brief || 'No brief yet.'}</p>
              <dl className="card-metrics">
                <div>
                  <dt>Params</dt>
                  <dd className="mono">{formatParams(project.params)}</dd>
                </div>
                <div>
                  <dt>Team</dt>
                  <dd className="mono">{project.teamSize}</dd>
                </div>
                <div>
                  <dt>Milestone</dt>
                  <dd className="mono">
                    {project.nextMilestone ? relativeDate(project.nextMilestone) : '—'}
                  </dd>
                </div>
              </dl>
              <div className="card-foot">
                <Sparkbars progress={project.progress} />
                <span className="muted mono">edited {relativeDate(project.updatedAt)}</span>
              </div>
            </article>
          ))}
        </div>
      )}

      {confirming && (
        <Modal
          title="Delete plan?"
          subtitle={`${confirming.name} and its graph, pipeline, team and evals are removed.`}
          onClose={() => setConfirming(null)}
          footer={
            <>
              <button className="quiet" onClick={() => setConfirming(null)}>
                Keep plan
              </button>
              <button
                className="danger"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    await onDelete(confirming.id)
                    setConfirming(null)
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                {busy ? 'Deleting…' : 'Delete plan'}
              </button>
            </>
          }
        >
          <p className="muted">
            This cannot be undone. Export a copy first if you want to keep the
            architecture and plan.
          </p>
        </Modal>
      )}

      {projects.length === 0 && !loading && (
        <p className="muted smallfoot">
          Plans are private to your account. Numbers update as you edit the graph.
        </p>
      )}
      {projects.length > 0 && (
        <p className="muted smallfoot">
          Last edited {formatDate(Math.max(...projects.map((project) => project.updatedAt)))}.
        </p>
      )}
    </div>
  )
}
