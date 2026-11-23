import { useMemo, useState } from 'react'
import { estimateProject } from '../shared/estimate'
import type { Eval, EvalStatus, Project, Role, Stage } from '../shared/types'
import { formatParams, uid } from './lib'
import { Icon, type Notify } from './ui'

const STATUS_LABEL: Record<EvalStatus, string> = {
  'not-started': 'Not started',
  running: 'Running',
  pass: 'Pass',
  fail: 'Fail',
}

type SortKey = 'name' | 'metric' | 'target' | 'cadence' | 'stage' | 'status'
const STATUS_ORDER: Record<EvalStatus, number> = {
  fail: 0,
  running: 1,
  'not-started': 2,
  pass: 3,
}

export function Evals({
  project,
  onPlan,
  notify,
}: {
  project: Project
  onPlan: (stages: Stage[], roles: Role[], evals: Eval[]) => void
  notify: Notify
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 })
  const stages = useMemo(
    () => [...project.stages].sort((a, b) => a.position - b.position),
    [project.stages],
  )
  const estimate = estimateProject(project.blocks, project.settings)

  function save(next: Eval[]) {
    onPlan(project.stages, project.roles, next)
  }

  function patch(id: string, change: Partial<Eval>) {
    save(project.evals.map((item) => (item.id === id ? { ...item, ...change } : item)))
  }

  function addEval() {
    const evalRow: Eval = {
      id: uid(),
      name: 'New gate',
      metric: 'accuracy',
      target: '',
      cadence: 'weekly',
      gateStage: stages[0]?.id ?? '',
      status: 'not-started',
    }
    save([...project.evals, evalRow])
    notify('Gate added')
  }

  function removeEval(id: string) {
    save(project.evals.filter((item) => item.id !== id))
  }

  const stageIndex = new Map(stages.map((stage, index) => [stage.id, index]))
  const sortedEvals = useMemo(() => {
    const value = (item: Eval): string | number => {
      switch (sort.key) {
        case 'stage':
          return stageIndex.get(item.gateStage) ?? 99
        case 'status':
          return STATUS_ORDER[item.status]
        default:
          return item[sort.key]
      }
    }
    return [...project.evals].sort((a, b) => {
      const av = value(a)
      const bv = value(b)
      if (av < bv) return -sort.dir
      if (av > bv) return sort.dir
      return a.name.localeCompare(b.name)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.evals, sort, stages])

  function toggleSort(key: SortKey) {
    setSort((current) =>
      current.key === key
        ? { key, dir: current.dir === 1 ? -1 : 1 }
        : { key, dir: 1 },
    )
  }

  const counts: Record<EvalStatus, number> = {
    'not-started': 0,
    running: 0,
    pass: 0,
    fail: 0,
  }
  for (const item of project.evals) counts[item.status] += 1

  const unallocatedStages = stages.filter(
    (stage) =>
      project.roles.reduce((sum, role) => sum + (role.allocation[stage.id] ?? 0), 0) === 0,
  )
  const uncoveredStages = stages.filter(
    (stage) => !project.evals.some((item) => item.gateStage === stage.id),
  )
  const missingTargets = project.evals.filter((item) => !item.target.trim())
  const checks = [
    {
      label: 'Every stage has a gate',
      ok: stages.length > 0 && uncoveredStages.length === 0,
      detail:
        uncoveredStages.length === 0
          ? 'All stages are covered.'
          : `${uncoveredStages.length} stage${uncoveredStages.length > 1 ? 's' : ''} without a gate: ${uncoveredStages
              .map((stage) => stage.name)
              .join(', ')}`,
    },
    {
      label: 'Every gate has a measurable target',
      ok: project.evals.length > 0 && missingTargets.length === 0,
      detail:
        missingTargets.length === 0
          ? `${project.evals.length} targets set.`
          : `${missingTargets.length} gate${missingTargets.length > 1 ? 's' : ''} missing a target.`,
    },
    {
      label: 'Every stage has staff',
      ok: stages.length > 0 && unallocatedStages.length === 0,
      detail:
        unallocatedStages.length === 0
          ? 'Every stage has allocated people.'
          : `${unallocatedStages.length} stage${unallocatedStages.length > 1 ? 's' : ''} with no allocation.`,
    },
    {
      label: 'Architecture estimated',
      ok: estimate.params > 0,
      detail:
        estimate.params > 0
          ? `${formatParams(estimate.params)} parameters mapped.`
          : 'No parameterised blocks in the architecture.',
    },
    {
      label: 'No failing suites',
      ok: counts.fail === 0,
      detail: counts.fail === 0 ? 'Nothing is failing.' : `${counts.fail} suite${counts.fail > 1 ? 's' : ''} failing.`,
    },
    {
      label: 'At least one gate passing',
      ok: counts.pass > 0,
      detail:
        counts.pass > 0 ? `${counts.pass} passing.` : 'No gates have passed yet — expected before a run.',
    },
  ]
  const score = Math.round((checks.filter((check) => check.ok).length / checks.length) * 100)

  return (
    <div className="evals-view">
      <div className="workspace-head">
        <div>
          <span className="eyebrow">Testing</span>
          <h2>Evaluation gates</h2>
          <p className="muted">
            {project.evals.length} suites · {counts.running} running · {counts.pass} passing ·{' '}
            {counts.fail} failing
          </p>
        </div>
        <button className="secondary" onClick={addEval}>
          <Icon name="plus" /> Gate
        </button>
      </div>

      <div className="coverage-strip">
        <span className="coverage-label">Stage coverage</span>
        {stages.length === 0 ? (
          <span className="muted">Add pipeline stages to map gates.</span>
        ) : (
          stages.map((stage) => {
            const gates = project.evals.filter((item) => item.gateStage === stage.id)
            const failing = gates.some((item) => item.status === 'fail')
            return (
              <span
                key={stage.id}
                className={`coverage-cell${gates.length === 0 ? ' none' : failing ? ' failing' : ' on'}`}
                title={`${stage.name}: ${gates.length} gate${gates.length === 1 ? '' : 's'}`}
              >
                <span>{stage.name}</span>
                <span className="mono">{gates.length}</span>
              </span>
            )
          })
        )}
      </div>

      <div className="evals-grid">
        <div className="panel">
          <div className="panel-head">
            <h3>Gates</h3>
            <span className="muted">thresholds, cadence and owning stage</span>
          </div>
          <div className="table-scroll">
            <table className="data-table eval-table">
              <thead>
                <tr>
                  {(
                    [
                      ['name', 'Suite'],
                      ['metric', 'Metric'],
                      ['target', 'Target'],
                      ['cadence', 'Cadence'],
                      ['stage', 'Gate stage'],
                      ['status', 'Status'],
                    ] as [SortKey, string][]
                  ).map(([key, label]) => (
                    <th key={key} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                      <button className="th-sort" onClick={() => toggleSort(key)}>
                        {label}
                        <span aria-hidden="true">{sort.key === key ? (sort.dir === 1 ? '↑' : '↓') : ''}</span>
                      </button>
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {project.evals.length === 0 && (
                  <tr>
                    <td colSpan={7} className="table-empty">
                      No gates yet. Add suites that must pass before a stage is done.
                    </td>
                  </tr>
                )}
                {sortedEvals.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <input
                        className="cell-input"
                        value={item.name}
                        maxLength={60}
                        aria-label="Suite name"
                        onChange={(event) => patch(item.id, { name: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        className="cell-input"
                        value={item.metric}
                        maxLength={40}
                        aria-label="Metric"
                        onChange={(event) => patch(item.id, { metric: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        className={`cell-input mono${item.target.trim() ? '' : ' missing'}`}
                        value={item.target}
                        maxLength={40}
                        placeholder="set a target"
                        aria-label="Target"
                        onChange={(event) => patch(item.id, { target: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        className="cell-input"
                        value={item.cadence}
                        maxLength={40}
                        aria-label="Cadence"
                        onChange={(event) => patch(item.id, { cadence: event.target.value })}
                      />
                    </td>
                    <td>
                      <select
                        className="cell-input"
                        value={item.gateStage}
                        aria-label="Gate stage"
                        onChange={(event) => patch(item.id, { gateStage: event.target.value })}
                      >
                        <option value="">Unassigned</option>
                        {stages.map((stage) => (
                          <option key={stage.id} value={stage.id}>
                            {stage.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        className={`cell-input status-select status-${item.status}`}
                        value={item.status}
                        aria-label="Status"
                        onChange={(event) =>
                          patch(item.id, { status: event.target.value as EvalStatus })
                        }
                      >
                        {(Object.keys(STATUS_LABEL) as EvalStatus[]).map((status) => (
                          <option key={status} value={status}>
                            {STATUS_LABEL[status]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <button
                        className="icon-btn small"
                        aria-label={`Delete ${item.name}`}
                        onClick={() => removeEval(item.id)}
                      >
                        <Icon name="trash" size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <aside className="panel readiness-panel">
          <div className="panel-head">
            <h3>Ship readiness</h3>
            <span className="mono readiness-score">{score}%</span>
          </div>
          <div className="readiness-meter" aria-hidden="true">
            <span style={{ width: `${score}%` }} />
          </div>
          <ul className="checklist">
            {checks.map((check) => (
              <li key={check.label} className={check.ok ? 'ok' : 'warn'}>
                <span className="check-icon">
                  <Icon name={check.ok ? 'check' : 'warn'} size={12} />
                </span>
                <div>
                  <strong>{check.label}</strong>
                  <span>{check.detail}</span>
                </div>
              </li>
            ))}
          </ul>
          <p className="muted tiny">
            Readiness is derived from the plan: gates, targets, staffing and the
            architecture estimate. It is a definition, not a score to game.
          </p>
        </aside>
      </div>
    </div>
  )
}
