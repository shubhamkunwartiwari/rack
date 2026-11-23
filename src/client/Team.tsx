import { useMemo, useState } from 'react'
import { estimateProject } from '../shared/estimate'
import type { Eval, Project, Role, Stage } from '../shared/types'
import {
  clamp,
  currentWeek,
  formatMoney,
  uid,
  weeksToMonths,
} from './lib'
import { Field, Icon, NumberInput, type Notify } from './ui'

export function Team({
  project,
  onPlan,
  notify,
}: {
  project: Project
  onPlan: (stages: Stage[], roles: Role[], evals: Eval[]) => void
  notify: Notify
}) {
  const [selectedRole, setSelectedRole] = useState<string | null>(null)
  const stages = useMemo(
    () => [...project.stages].sort((a, b) => a.position - b.position),
    [project.stages],
  )
  const estimate = estimateProject(project.blocks, project.settings)
  const roles = project.roles

  function save(nextRoles: Role[]) {
    onPlan(project.stages, nextRoles, project.evals)
  }

  function patchRole(id: string, patch: Partial<Role>) {
    save(roles.map((role) => (role.id === id ? { ...role, ...patch } : role)))
  }

  function setAllocation(role: Role, stageId: string, value: number) {
    const others = stages.reduce(
      (sum, stage) => (stage.id === stageId ? sum : sum + (role.allocation[stage.id] ?? 0)),
      0,
    )
    const allocation = { ...role.allocation }
    const clamped = clamp(value, 0, Math.max(0, 100 - others))
    if (clamped <= 0) delete allocation[stageId]
    else allocation[stageId] = clamped
    if (clamped !== value && value > clamped)
      notify(`${role.name} can only give ${Math.max(0, 100 - others)}% to ${stages.find((s) => s.id === stageId)?.name ?? 'that stage'}.`)
    patchRole(role.id, { allocation })
  }

  function addRole() {
    const role: Role = {
      id: uid(),
      name: 'New role',
      headcount: 1,
      rate: 9000,
      allocation: {},
    }
    save([...roles, role])
    setSelectedRole(role.id)
    notify('Role added')
  }

  function removeRole(id: string) {
    save(roles.filter((role) => role.id !== id))
    if (selectedRole === id) setSelectedRole(null)
  }

  const perStage = stages.map((stage) => {
    const months = weeksToMonths(Math.max(0, stage.endWeek - stage.startWeek))
    const peopleMonths = roles.reduce(
      (sum, role) => sum + role.headcount * ((role.allocation[stage.id] ?? 0) / 100) * months,
      0,
    )
    const peopleCost = roles.reduce(
      (sum, role) =>
        sum + role.headcount * ((role.allocation[stage.id] ?? 0) / 100) * months * role.rate,
      0,
    )
    return { stage, peopleMonths, peopleCost, months }
  })
  const peopleCostTotal = perStage.reduce((sum, item) => sum + item.peopleCost, 0)
  const totalPeopleMonths = perStage.reduce((sum, item) => sum + item.peopleMonths, 0)
  const totalCost = peopleCostTotal + estimate.computeCost
  const teamSize = roles.reduce((sum, role) => sum + role.headcount, 0)
  const unallocated = roles.filter(
    (role) => stages.reduce((sum, stage) => sum + (role.allocation[stage.id] ?? 0), 0) === 0,
  )

  const burn = useMemo(() => {
    const months = Math.ceil(Math.max(1, ...stages.map((stage) => stage.endWeek)) / 4.345)
    const values = Array.from({ length: Math.min(months, 48) }, (_, monthIndex) => {
      const week = monthIndex * 4.345
      return roles.reduce((sum, role) => {
        const active = stages.filter(
          (stage) => week >= stage.startWeek && week < stage.endWeek,
        )
        const share = active.reduce(
          (total, stage) => total + (role.allocation[stage.id] ?? 0) / 100,
          0,
        )
        return sum + role.headcount * role.rate * Math.min(1, share)
      }, 0)
    })
    return values
  }, [roles, stages])
  const burnMax = Math.max(1, ...burn)

  if (stages.length === 0) {
    return (
      <div className="page">
        <div className="workspace-head">
          <div>
            <span className="eyebrow">People</span>
            <h2>Team plan</h2>
          </div>
        </div>
        <div className="empty-state bordered">
          <span className="empty-mark">⌗</span>
          <h3>No stages to staff yet</h3>
          <p>Add pipeline stages first, then allocate roles across them.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="team-view">
      <div className="workspace-head">
        <div>
          <span className="eyebrow">People</span>
          <h2>Team plan</h2>
          <p className="muted">
            {teamSize} people · {totalPeopleMonths.toFixed(1)} people-months ·{' '}
            {unallocated.length ? `${unallocated.length} roles unallocated` : 'every role allocated'}
          </p>
        </div>
        <button className="secondary" onClick={addRole}>
          <Icon name="plus" /> Role
        </button>
      </div>

      <div className="team-grid">
        <div className="panel">
          <div className="panel-head">
            <h3>Roles</h3>
            <span className="muted mono">{roles.length}</span>
          </div>
          <table className="data-table roles-table">
            <thead>
              <tr>
                <th>Role</th>
                <th className="num-col">People</th>
                <th className="num-col">Rate / mo</th>
                <th className="num-col">Allocated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {roles.length === 0 && (
                <tr>
                  <td colSpan={5} className="table-empty">
                    No roles yet. Add research, infrastructure, data, eval and product.
                  </td>
                </tr>
              )}
              {roles.map((role) => {
                const allocated = stages.reduce(
                  (sum, stage) => sum + (role.allocation[stage.id] ?? 0),
                  0,
                )
                return (
                  <tr
                    key={role.id}
                    className={selectedRole === role.id ? 'on' : ''}
                    onClick={() => setSelectedRole(role.id)}
                  >
                    <td>
                      <input
                        className="cell-input name-cell"
                        value={role.name}
                        maxLength={40}
                        aria-label="Role name"
                        onChange={(event) => patchRole(role.id, { name: event.target.value })}
                      />
                    </td>
                    <td className="num-col">
                      <NumberInput
                        value={role.headcount}
                        min={0}
                        max={500}
                        ariaLabel={`${role.name} headcount`}
                        onChange={(headcount) => patchRole(role.id, { headcount })}
                      />
                    </td>
                    <td className="num-col">
                      <NumberInput
                        value={role.rate}
                        min={0}
                        max={100000}
                        step={500}
                        ariaLabel={`${role.name} monthly rate`}
                        onChange={(rate) => patchRole(role.id, { rate })}
                      />
                    </td>
                    <td className="num-col">
                      <span className={`alloc-total mono${allocated > 100 ? ' over' : allocated >= 100 ? ' full' : ''}`}>
                        {allocated}%
                      </span>
                    </td>
                    <td>
                      <button
                        className="icon-btn small"
                        aria-label={`Delete ${role.name}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          removeRole(role.id)
                        }}
                      >
                        <Icon name="trash" size={12} />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="panel summary-panel">
          <div className="panel-head">
            <h3>Cost</h3>
            <span className="muted mono">{estimate.bytesPerGpu > 0 ? 'estimate' : '—'}</span>
          </div>
          <div className="cost-rows">
            <div>
              <span>People</span>
              <strong className="mono">{formatMoney(peopleCostTotal)}</strong>
            </div>
            <div>
              <span>Compute</span>
              <strong className="mono">{formatMoney(estimate.computeCost)}</strong>
            </div>
            <div className="total">
              <span>Total run</span>
              <strong className="mono">{formatMoney(totalCost)}</strong>
            </div>
          </div>
          <div className="burn">
            <span className="field-label">Monthly burn</span>
            <div className="burn-bars" aria-label="Monthly burn estimate">
              {burn.map((value, index) => (
                <span
                  key={index}
                  title={`Month ${index + 1}: ${formatMoney(value)}`}
                  style={{ height: `${Math.max(3, (value / burnMax) * 46)}px` }}
                />
              ))}
            </div>
            <span className="muted tiny">
              {formatMoney(burnMax)} peak · {burn.length} months
            </span>
          </div>
          <div className="cost-rows">
            <div>
              <span>Compute hours</span>
              <strong className="mono">{estimate.gpuHours.toFixed(0)}</strong>
            </div>
            <div>
              <span>People-months</span>
              <strong className="mono">{totalPeopleMonths.toFixed(1)}</strong>
            </div>
          </div>
        </div>
      </div>

      <div className="panel allocation-panel">
        <div className="panel-head">
          <h3>Allocation by stage</h3>
          <span className="muted">percent of each role's time · max 100 per role</span>
        </div>
        <div className="allocation-scroll">
          <table className="allocation-grid">
            <thead>
              <tr>
                <th className="corner">role / stage</th>
                {stages.map((stage) => (
                  <th key={stage.id}>
                    <span>{stage.name}</span>
                    <span className="mono muted">{stage.startWeek}–{stage.endWeek}w</span>
                  </th>
                ))}
                <th className="num-col">people-mo</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((role) => {
                const allocated = stages.reduce(
                  (sum, stage) => sum + (role.allocation[stage.id] ?? 0),
                  0,
                )
                const peopleMonths = stages.reduce(
                  (sum, stage) =>
                    sum +
                    role.headcount *
                      ((role.allocation[stage.id] ?? 0) / 100) *
                      weeksToMonths(Math.max(0, stage.endWeek - stage.startWeek)),
                  0,
                )
                return (
                  <tr key={role.id}>
                    <th scope="row">
                      <span className="role-dot" data-full={allocated >= 100} />
                      {role.name}
                      <span className="mono muted">{allocated}%</span>
                    </th>
                    {stages.map((stage) => {
                      const value = role.allocation[stage.id] ?? 0
                      const heat = value >= 90 ? 'amber' : value >= 60 ? 'warm' : value >= 25 ? 'mid' : value > 0 ? 'low' : ''
                      return (
                        <td key={stage.id} className={`alloc-cell ${heat}`}>
                          <NumberInput
                            value={value}
                            min={0}
                            max={100}
                            step={5}
                            ariaLabel={`${role.name} on ${stage.name}`}
                            onChange={(next) => setAllocation(role, stage.id, next)}
                          />
                        </td>
                      )
                    })}
                    <td className="num-col mono">{peopleMonths.toFixed(1)}</td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">people-months</th>
                {perStage.map((item) => (
                  <td key={item.stage.id} className="mono">
                    {item.peopleMonths.toFixed(1)}
                  </td>
                ))}
                <td className="num-col mono">{totalPeopleMonths.toFixed(1)}</td>
              </tr>
              <tr className="foot-cost">
                <th scope="row">people cost</th>
                {perStage.map((item) => (
                  <td key={item.stage.id} className="mono">
                    {formatMoney(item.peopleCost)}
                  </td>
                ))}
                <td className="num-col mono">{formatMoney(peopleCostTotal)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="panel capacity-panel">
        <div className="panel-head">
          <h3>Capacity</h3>
          <span className="muted">roles × stages</span>
        </div>
        <div className="capacity-grid">
          {roles.map((role) => (
            <div className="capacity-row" key={role.id}>
              <span className="capacity-name">{role.name}</span>
              <div className="capacity-cells">
                {stages.map((stage) => {
                  const value = role.allocation[stage.id] ?? 0
                  return (
                    <span
                      key={stage.id}
                      className={`capacity-cell${value >= 90 ? ' amber' : ''}`}
                      style={{ opacity: 0.18 + (value / 100) * 0.82 }}
                      title={`${role.name} → ${stage.name}: ${value}%`}
                    />
                  )
                })}
              </div>
              <span className="mono muted">
                {role.headcount} × {Math.round(
                  stages.reduce((sum, stage) => sum + (role.allocation[stage.id] ?? 0), 0) / 100,
                )} FTE
              </span>
            </div>
          ))}
        </div>
        <p className="muted tiny">
          Today is week {currentWeek(project.startDate).toFixed(1)}. Amber cells are at or above 90%
          of a role's time; totals above 100 are refused when saving.
        </p>
      </div>
    </div>
  )
}
