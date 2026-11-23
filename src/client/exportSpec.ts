import { ACCELERATORS, PRECISION_BYTES, estimateProject } from '../shared/estimate'
import type { Project } from '../shared/types'
import { weeksToMonths } from './lib'

export function projectMarkdown(project: Project): string {
  const estimate = estimateProject(project.blocks, project.settings)
  const accelerator = ACCELERATORS[project.settings.accelerator]
  const stages = [...project.stages].sort((a, b) => a.position - b.position)
  const lines: string[] = []
  lines.push(`# ${project.name}`)
  if (project.brief) lines.push('', project.brief)
  lines.push(
    '',
    `- Stage: ${project.stage}`,
    `- Plan starts: ${new Date(project.startDate).toDateString()}`,
    `- Architecture (estimate): ${(estimate.params / 1e9).toFixed(2)}B total, ${(estimate.activeParams / 1e9).toFixed(2)}B active`,
    `- Memory per GPU: ${(estimate.bytesPerGpu / 1e9).toFixed(1)} GB across ${project.settings.shards} shards`,
    `- Training compute: ${estimate.gpuHours.toFixed(0)} GPU-hours on ${accelerator.label} ($${estimate.computeCost.toFixed(0)})`,
  )

  lines.push('', '## Architecture', '', '| Block | Kind | d_model | Layers | Heads | Precision | Params |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const block of project.blocks) {
    const row = estimate.byBlock.find((item) => item.id === block.id)
    lines.push(
      `| ${block.label} | ${block.kind} | ${block.config.dModel} | ${block.config.layers} | ${block.config.heads} | ${block.config.precision} | ${((row?.params ?? 0) / 1e9).toFixed(3)}B |`,
    )
  }
  lines.push(
    '',
    `Parameter math: embeddings = vocab × d_model; attention = layers × d² × (2 + 2·kv/heads); FFN = layers × 2·d·ffn; MoE = layers × experts × 3·d·ffn; projection = d × vocab.`,
    `Memory: weights (${PRECISION_BYTES.bf16} bytes bf16 by default) + 8 bytes of master/Adam state per parameter + activations, divided by shards.`,
    `Compute: 6 × active parameters × tokens ÷ (peak FLOPS × MFU × utilisation).`,
  )

  lines.push('', '## Run settings', '', '| Setting | Value |', '| --- | --- |')
  lines.push(`| Training tokens | ${project.settings.tokensB}B |`)
  lines.push(`| Model FLOPs utilisation | ${project.settings.mfu}% |`)
  lines.push(`| Accelerator | ${accelerator.label} |`)
  lines.push(`| Shards | ${project.settings.shards} |`)

  lines.push('', '## Pipeline', '', '| Stage | Weeks | Owner | Compute note |')
  lines.push('| --- | --- | --- | --- |')
  for (const stage of stages) {
    lines.push(
      `| ${stage.name} | ${stage.startWeek}–${stage.endWeek} | ${stage.ownerRole || '—'} | ${stage.computeNote || '—'} |`,
    )
  }

  lines.push('', '## Team', '', '| Role | Headcount | Monthly rate | Allocated | People-months |')
  lines.push('| --- | --- | --- | --- | --- |')
  let peopleCost = 0
  for (const role of project.roles) {
    const allocated = stages.reduce(
      (sum, stage) => sum + (role.allocation[stage.id] ?? 0),
      0,
    )
    const rolePeopleMonths = stages.reduce(
      (sum, stage) =>
        sum +
        role.headcount *
          ((role.allocation[stage.id] ?? 0) / 100) *
          weeksToMonths(Math.max(0, stage.endWeek - stage.startWeek)),
      0,
    )
    peopleCost += rolePeopleMonths * role.rate
    lines.push(
      `| ${role.name} | ${role.headcount} | $${role.rate.toLocaleString()} | ${allocated}% | ${rolePeopleMonths.toFixed(1)} |`,
    )
  }
  lines.push(
    '',
    `People cost: $${peopleCost.toFixed(0)}. Compute cost: $${estimate.computeCost.toFixed(0)}. Total: $${(peopleCost + estimate.computeCost).toFixed(0)}.`,
  )

  lines.push('', '## Evaluation gates', '', '| Suite | Metric | Target | Cadence | Gate stage | Status |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const item of project.evals) {
    const gate = stages.find((stage) => stage.id === item.gateStage)?.name ?? '—'
    lines.push(
      `| ${item.name} | ${item.metric || '—'} | ${item.target || '—'} | ${item.cadence || '—'} | ${gate} | ${item.status} |`,
    )
  }
  lines.push('', '_All figures are estimates generated from the plan graph._')
  return lines.join('\n')
}

export function download(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function safeFilename(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'rack-plan'
  )
}
