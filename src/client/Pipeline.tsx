import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { estimateProject } from '../shared/estimate'
import type { Eval, Project, Role, Stage } from '../shared/types'
import {
  addWeeks,
  clamp,
  currentWeek,
  formatMoney,
  uid,
  weeksToMonths,
} from './lib'
import { Field, Icon, Modal, NumberInput, type Notify } from './ui'

type Zoom = 'week' | 'month' | 'quarter'
const PX: Record<Zoom, number> = { week: 64, month: 26, quarter: 10 }
const ROW_H = 58
const LABEL_W = 190

export function Pipeline({
  project,
  onPlan,
  notify,
}: {
  project: Project
  onPlan: (stages: Stage[], roles: Role[], evals: Eval[]) => void
  notify: Notify
}) {
  const [zoom, setZoom] = useState<Zoom>('week')
  const [selected, setSelected] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [draftName, setDraftName] = useState('')
  const dragRef = useRef<{
    id: string
    mode: 'move' | 'left' | 'right'
    startX: number
    startWeek: number
    endWeek: number
  } | null>(null)

  const stages = useMemo(
    () => [...project.stages].sort((a, b) => a.position - b.position),
    [project.stages],
  )
  const px = PX[zoom]
  const maxWeek = Math.max(8, ...stages.map((stage) => stage.endWeek), currentWeek(project.startDate) + 2)
  const totalWidth = LABEL_W + (maxWeek + 4) * px
  const estimate = estimateProject(project.blocks, project.settings)
  const activeStage = stages.find((stage) => stage.id === selected) ?? null
  const totalWeeks = Math.max(1, stages.reduce((sum, stage) => sum + (stage.endWeek - stage.startWeek), 0))
  const today = currentWeek(project.startDate)

  function update(patch: Partial<Stage>) {
    if (!activeStage) return
    onPlan(
      project.stages.map((stage) => (stage.id === activeStage.id ? { ...stage, ...patch } : stage)),
      project.roles,
      project.evals,
    )
  }

  function startDrag(event: ReactPointerEvent, stage: Stage, mode: 'move' | 'left' | 'right') {
    event.preventDefault()
    event.stopPropagation()
    setSelected(stage.id)
    dragRef.current = {
      id: stage.id,
      mode,
      startX: event.clientX,
      startWeek: stage.startWeek,
      endWeek: stage.endWeek,
    }
    const onMove = (moveEvent: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const delta = Math.round((moveEvent.clientX - drag.startX) / px)
      const original = project.stages.find((stage) => stage.id === drag.id)
      if (!original) return
      let next: Partial<Stage> = {}
      if (drag.mode === 'move') {
        const span = drag.endWeek - drag.startWeek
        const start = Math.max(0, drag.startWeek + delta)
        next = { startWeek: start, endWeek: start + span }
      } else if (drag.mode === 'left') {
        next = { startWeek: clamp(drag.startWeek + delta, 0, drag.endWeek - 1) }
      } else {
        next = { endWeek: Math.max(drag.startWeek + 1, drag.endWeek + delta) }
      }
      onPlan(
        project.stages.map((item) => (item.id === drag.id ? { ...item, ...next } : item)),
        project.roles,
        project.evals,
      )
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      dragRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function addStage() {
    const start = stages.length ? Math.max(...stages.map((stage) => stage.endWeek)) : 0
    const stage: Stage = {
      id: uid(),
      name: draftName.trim() || 'New stage',
      position: stages.length,
      startWeek: start,
      endWeek: start + 4,
      ownerRole: project.roles[0]?.name ?? 'Research',
      computeNote: '',
      dependsOn: stages.length ? [stages[stages.length - 1]!.id] : [],
    }
    onPlan([...project.stages, stage], project.roles, project.evals)
    setSelected(stage.id)
    setAdding(false)
    setDraftName('')
    notify(`${stage.name} added`)
  }

  function removeStage(stage: Stage) {
    onPlan(
      project.stages
        .filter((item) => item.id !== stage.id)
        .map((item, index) => ({
          ...item,
          position: index,
          dependsOn: item.dependsOn.filter((id) => id !== stage.id),
        })),
      project.roles.map((role) => {
        const allocation = { ...role.allocation }
        delete allocation[stage.id]
        return { ...role, allocation }
      }),
      project.evals.map((item) =>
        item.gateStage === stage.id ? { ...item, gateStage: '' } : item,
      ),
    )
    setSelected(null)
    notify(`${stage.name} removed`)
  }

  function monthTicks() {
    const ticks: { week: number; label: string }[] = []
    const date = new Date(project.startDate)
    date.setDate(1)
    for (let index = 0; index < 24; index += 1) {
      const week = (date.getTime() - project.startDate) / (7 * 86_400_000)
      if (week > maxWeek + 4) break
      ticks.push({
        week,
        label: date.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }),
      })
      date.setMonth(date.getMonth() + 1)
    }
    return ticks
  }

  return (
    <div className="pipeline-view">
      <div className="workspace-head">
        <div>
          <span className="eyebrow">Process</span>
          <h2>Pipeline</h2>
          <p className="muted">
            {stages.length} stages · {stages.length ? Math.max(...stages.map((s) => s.endWeek)) : 0} weeks · plan starts{' '}
            {new Date(project.startDate).toLocaleDateString()}
          </p>
        </div>
        <div className="head-actions">
          <div className="segmented" role="group" aria-label="Timeline zoom">
            {(['week', 'month', 'quarter'] as Zoom[]).map((value) => (
              <button key={value} className={zoom === value ? 'on' : ''} onClick={() => setZoom(value)}>
                {value}
              </button>
            ))}
          </div>
          <button className="secondary" onClick={() => setAdding(true)}>
            <Icon name="plus" /> Stage
          </button>
        </div>
      </div>

      {stages.length === 0 ? (
        <div className="empty-state bordered">
          <span className="empty-mark">⌗</span>
          <h3>No stages yet</h3>
          <p>Map data curation, pretraining, tuning, evaluation and deployment as weeks.</p>
          <button className="primary" onClick={() => setAdding(true)}>
            <Icon name="plus" /> Add the first stage
          </button>
        </div>
      ) : (
        <div className="pipeline-body">
          <div className="timeline-scroll">
            <div className="timeline" style={{ width: totalWidth }}>
              <div className="timeline-head" style={{ height: 30 }}>
                <span className="timeline-corner mono">stage</span>
                {monthTicks().map((tick) => (
                  <span
                    key={`${tick.week}-${tick.label}`}
                    className="tick-label mono"
                    style={{ left: LABEL_W + tick.week * px }}
                  >
                    {tick.label}
                  </span>
                ))}
              </div>
              <div className="timeline-rows" style={{ height: stages.length * ROW_H }}>
                {stages.map((stage, index) => {
                  const left = LABEL_W + stage.startWeek * px
                  const width = Math.max(6, (stage.endWeek - stage.startWeek) * px)
                  const share = (stage.endWeek - stage.startWeek) / totalWeeks
                  const stageCost = estimate.computeCost * share
                  return (
                    <div className="timeline-row" key={stage.id} style={{ height: ROW_H }}>
                      <div className="row-label" style={{ width: LABEL_W }}>
                        <span className="row-index mono">{String(index + 1).padStart(2, '0')}</span>
                        <span className="row-name">{stage.name}</span>
                        <span className="row-owner mono">{stage.ownerRole || 'unassigned'}</span>
                      </div>
                      <div
                        className={`stage-bar${selected === stage.id ? ' selected' : ''}`}
                        style={{ left, width }}
                        onPointerDown={(event) => startDrag(event, stage, 'move')}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') setSelected(stage.id)
                        }}
                        title={`${stage.name} · weeks ${stage.startWeek}–${stage.endWeek}`}
                      >
                        <span className="bar-resize left" onPointerDown={(event) => startDrag(event, stage, 'left')} />
                        <span className="bar-text">
                          <span className="bar-weeks mono">
                            {stage.endWeek - stage.startWeek}w
                          </span>
                          {width > 120 && (
                            <span className="bar-note">{stage.computeNote || `${formatMoney(stageCost)} est. compute`}</span>
                          )}
                        </span>
                        <span className="bar-resize right" onPointerDown={(event) => startDrag(event, stage, 'right')} />
                      </div>
                    </div>
                  )
                })}
                <svg className="dep-layer" width={totalWidth} height={stages.length * ROW_H}>
                  {stages.flatMap((stage) =>
                    stage.dependsOn.map((depId) => {
                      const from = stages.find((item) => item.id === depId)
                      const fromIndex = stages.findIndex((item) => item.id === depId)
                      const index = stages.findIndex((item) => item.id === stage.id)
                      if (!from || fromIndex < 0 || index < 0) return null
                      const x1 = LABEL_W + from.endWeek * px
                      const y1 = fromIndex * ROW_H + ROW_H / 2
                      const x2 = LABEL_W + stage.startWeek * px
                      const y2 = index * ROW_H + ROW_H / 2
                      const midX = Math.max(x1 + 12, x2 - 12)
                      return (
                        <path
                          key={`${depId}-${stage.id}`}
                          className="dep"
                          d={`M${x1},${y1} H${midX} V${y2} H${x2}`}
                        />
                      )
                    }),
                  )}
                  <line
                    className="today-line"
                    x1={LABEL_W + today * px}
                    x2={LABEL_W + today * px}
                    y1={0}
                    y2={stages.length * ROW_H}
                  />
                  <text
                    className="today-label"
                    x={LABEL_W + today * px + 4}
                    y={12}
                  >
                    today
                  </text>
                </svg>
              </div>
            </div>
          </div>

          <aside className="inspector">
            {activeStage ? (
              <div className="inspector-body">
                <div className="inspector-head">
                  <span className="kind-chip kind-attention">STG</span>
                  <span className="eyebrow">Stage</span>
                </div>
                <input
                  className="inspector-title"
                  value={activeStage.name}
                  aria-label="Stage name"
                  maxLength={60}
                  onChange={(event) => update({ name: event.target.value })}
                />
                <div className="inspector-grid">
                  <Field label="Start week">
                    <NumberInput
                      value={activeStage.startWeek}
                      min={0}
                      max={520}
                      onChange={(startWeek) => update({ startWeek, endWeek: Math.max(startWeek + 1, activeStage.endWeek) })}
                    />
                  </Field>
                  <Field label="End week">
                    <NumberInput
                      value={activeStage.endWeek}
                      min={activeStage.startWeek + 1}
                      max={1040}
                      onChange={(endWeek) => update({ endWeek })}
                    />
                  </Field>
                </div>
                <Field label="Owner role">
                  <input
                    className="input"
                    value={activeStage.ownerRole}
                    maxLength={40}
                    list="role-names"
                    onChange={(event) => update({ ownerRole: event.target.value })}
                  />
                  <datalist id="role-names">
                    {project.roles.map((role) => (
                      <option key={role.id} value={role.name} />
                    ))}
                  </datalist>
                </Field>
                <Field label="Compute note">
                  <input
                    className="input"
                    value={activeStage.computeNote}
                    maxLength={120}
                    placeholder="8×H100, 2.4T tokens"
                    onChange={(event) => update({ computeNote: event.target.value })}
                  />
                </Field>
                <div className="inspector-math stacked">
                  <div>
                    <span>Duration</span>
                    <strong className="mono">{activeStage.endWeek - activeStage.startWeek} weeks</strong>
                  </div>
                  <div>
                    <span>Calendar</span>
                    <strong className="mono">
                      {new Date(addWeeks(project.startDate, activeStage.startWeek)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      {' → '}
                      {new Date(addWeeks(project.startDate, activeStage.endWeek)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </strong>
                  </div>
                  <div>
                    <span>Compute share</span>
                    <strong className="mono">{formatMoney(stageCost(estimate.computeCost, activeStage, totalWeeks))}</strong>
                  </div>
                  <div>
                    <span>People-months</span>
                    <strong className="mono">
                      {project.roles
                        .reduce(
                          (sum, role) =>
                            sum +
                            role.headcount *
                              ((role.allocation[activeStage.id] ?? 0) / 100) *
                              weeksToMonths(activeStage.endWeek - activeStage.startWeek),
                          0,
                        )
                        .toFixed(1)}
                    </strong>
                  </div>
                </div>
                <Field label="Depends on">
                  <div className="dep-list">
                    {stages
                      .filter((stage) => stage.id !== activeStage.id)
                      .map((stage) => (
                        <label key={stage.id} className="check">
                          <input
                            type="checkbox"
                            checked={activeStage.dependsOn.includes(stage.id)}
                            onChange={(event) =>
                              update({
                                dependsOn: event.target.checked
                                  ? [...activeStage.dependsOn, stage.id].slice(0, 8)
                                  : activeStage.dependsOn.filter((id) => id !== stage.id),
                              })
                            }
                          />
                          <span>{stage.name}</span>
                        </label>
                      ))}
                  </div>
                </Field>
                <button className="ghost danger-text" onClick={() => removeStage(activeStage)}>
                  <Icon name="trash" /> Delete stage
                </button>
              </div>
            ) : (
              <div className="inspector-body">
                <span className="eyebrow">Timeline</span>
                <h3 className="mono">{estimate.gpuHours.toFixed(0)} GPU-hours</h3>
                <p className="muted tiny">
                  Pick a bar to edit its weeks, owner and dependencies. Drag the
                  middle to move it, the edges to resize.
                </p>
                <div className="inspector-math stacked">
                  <div>
                    <span>Stages</span>
                    <strong className="mono">{stages.length}</strong>
                  </div>
                  <div>
                    <span>Longest path</span>
                    <strong className="mono">{Math.max(0, ...stages.map((s) => s.endWeek))} weeks</strong>
                  </div>
                  <div>
                    <span>Compute cost</span>
                    <strong className="mono">{formatMoney(estimate.computeCost)}</strong>
                  </div>
                </div>
                <p className="muted tiny">Today is week {today.toFixed(1)} of the plan.</p>
              </div>
            )}
          </aside>
        </div>
      )}

      {adding && (
        <Modal
          title="Add a stage"
          subtitle="Stages are weeks from the plan start date."
          onClose={() => setAdding(false)}
          footer={
            <>
              <button className="quiet" onClick={() => setAdding(false)}>
                Cancel
              </button>
              <button className="primary" onClick={addStage}>
                Add stage
              </button>
            </>
          }
        >
          <Field label="Stage name">
            <input
              className="input"
              autoFocus
              value={draftName}
              maxLength={60}
              placeholder="SFT"
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') addStage()
              }}
            />
          </Field>
          <p className="muted tiny">
            It starts where the current plan ends and runs for four weeks. Adjust
            the weeks in the inspector.
          </p>
        </Modal>
      )}
    </div>
  )
}

function stageCost(computeCost: number, stage: Stage, totalWeeks: number): number {
  return computeCost * ((stage.endWeek - stage.startWeek) / Math.max(1, totalWeeks))
}
