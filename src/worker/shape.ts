import type {
  Block,
  BlockConfig,
  BlockKind,
  Edge,
  Eval,
  EvalStatus,
  GraphPayload,
  PlanPayload,
  PortType,
  Precision,
  ProjectSettings,
  ProjectStage,
  Role,
  Stage,
  TemplateId,
} from '../shared/types'
import {
  BLOCK_META,
  DEFAULT_SETTINGS,
  PRECISIONS,
  defaultConfig,
} from '../shared/estimate'

export const MAX_BLOCKS = 200
export const MAX_EDGES = 400
export const MAX_STAGES = 40
export const MAX_ROLES = 20
export const MAX_EVALS = 80

const STAGES: ProjectStage[] = ['scoping', 'design', 'training', 'evaluating', 'shipping']
const EVAL_STATUS: EvalStatus[] = ['not-started', 'running', 'pass', 'fail']

export function text(value: unknown, max: number, fallback = ''): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : fallback
}

export function int(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.round(Math.min(Math.max(n, min), max))
}

function real(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

export function readSettings(raw: unknown): ProjectSettings {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const accelerator =
    body.accelerator === 'h100' ||
    body.accelerator === 'h200' ||
    body.accelerator === 'b200' ||
    body.accelerator === 'a100'
      ? body.accelerator
      : DEFAULT_SETTINGS.accelerator
  return {
    tokensB: real(body.tokensB, 0, 100_000, DEFAULT_SETTINGS.tokensB),
    mfu: int(body.mfu, 1, 90, DEFAULT_SETTINGS.mfu),
    accelerator,
    shards: int(body.shards, 1, 4096, DEFAULT_SETTINGS.shards),
  }
}

function readConfig(kind: BlockKind, raw: unknown): BlockConfig {
  const base = defaultConfig(kind)
  if (!raw || typeof raw !== 'object') return base
  const body = raw as Record<string, unknown>
  const precision = PRECISIONS.includes(body.precision as Precision)
    ? (body.precision as Precision)
    : base.precision
  const heads = int(body.heads, 1, 512, base.heads)
  return {
    dModel: int(body.dModel, 16, 32768, base.dModel),
    layers: int(body.layers, 0, 200, base.layers),
    heads,
    kvHeads: Math.min(int(body.kvHeads, 1, 512, base.kvHeads), heads),
    ffnWidth: int(body.ffnWidth, 0, 262144, base.ffnWidth),
    experts: int(body.experts, 1, 256, base.experts),
    topK: int(body.topK, 1, 256, base.topK),
    vocab: int(body.vocab, 256, 1_000_000, base.vocab),
    seqLen: int(body.seqLen, 128, 2_000_000, base.seqLen),
    batch: int(body.batch, 1, 8192, base.batch),
    precision,
  }
}

function isKind(value: unknown): value is BlockKind {
  return typeof value === 'string' && value in BLOCK_META
}

function readBlock(raw: unknown): Block | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const body = raw as Record<string, unknown>
  const id = text(body.id, 64)
  if (!id || !isKind(body.kind)) return null
  return {
    id,
    kind: body.kind,
    label: text(body.label, 60) || BLOCK_META[body.kind].label,
    x: real(body.x, -20_000, 20_000, 0),
    y: real(body.y, -20_000, 20_000, 0),
    config: readConfig(body.kind, body.config),
  }
}

export function readGraph(raw: unknown): GraphPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const body = raw as Record<string, unknown>
  if (!Array.isArray(body.blocks) || !Array.isArray(body.edges)) return null
  if (body.blocks.length > MAX_BLOCKS || body.edges.length > MAX_EDGES) return null
  const blocks: Block[] = []
  const ids = new Set<string>()
  for (const item of body.blocks) {
    const block = readBlock(item)
    if (!block || ids.has(block.id)) return null
    ids.add(block.id)
    blocks.push(block)
  }
  const edges: Edge[] = []
  const pairs = new Set<string>()
  for (const item of body.edges) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const body = item as Record<string, unknown>
    const id = text(body.id, 64)
    const fromId = text(body.fromId, 64)
    const toId = text(body.toId, 64)
    const port = ['embedding', 'hidden', 'logits'].includes(body.port as string)
      ? (body.port as PortType)
      : 'hidden'
    if (!id || !fromId || !toId || fromId === toId) return null
    if (!ids.has(fromId) || !ids.has(toId) || pairs.has(`${fromId}:${toId}`)) return null
    pairs.add(`${fromId}:${toId}`)
    edges.push({ id, fromId, toId, port })
  }
  return { blocks, edges }
}

export function readPlan(raw: unknown): PlanPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const body = raw as Record<string, unknown>
  if (!Array.isArray(body.stages) || !Array.isArray(body.roles) || !Array.isArray(body.evals))
    return null
  if (
    body.stages.length > MAX_STAGES ||
    body.roles.length > MAX_ROLES ||
    body.evals.length > MAX_EVALS
  )
    return null
  const stages: Stage[] = []
  const stageIds = new Set<string>()
  for (const item of body.stages) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const row = item as Record<string, unknown>
    const id = text(row.id, 64)
    const name = text(row.name, 60)
    if (!id || !name || stageIds.has(id)) return null
    stageIds.add(id)
    const startWeek = int(row.startWeek, 0, 520, 0)
    stages.push({
      id,
      name,
      position: int(row.position, 0, 60, stages.length),
      startWeek,
      endWeek: Math.max(startWeek + 1, int(row.endWeek, 1, 1040, startWeek + 4)),
      ownerRole: text(row.ownerRole, 40),
      computeNote: text(row.computeNote, 120),
      dependsOn: Array.isArray(row.dependsOn)
        ? row.dependsOn.map((value) => text(value, 64)).filter((value) => stageIds.has(value)).slice(0, 8)
        : [],
    })
  }
  const roles: Role[] = []
  const roleIds = new Set<string>()
  for (const item of body.roles) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const row = item as Record<string, unknown>
    const id = text(row.id, 64)
    const name = text(row.name, 40)
    if (!id || !name || roleIds.has(id)) return null
    roleIds.add(id)
    const allocation: Record<string, number> = {}
    let total = 0
    if (row.allocation && typeof row.allocation === 'object' && !Array.isArray(row.allocation)) {
      for (const [stageId, value] of Object.entries(row.allocation)) {
        if (!stageIds.has(stageId)) continue
        const percent = int(value, 0, 100, 0)
        if (percent > 0) allocation[stageId] = percent
        total += percent
      }
    }
    // A person cannot be allocated beyond a full week; refuse the plan otherwise.
    if (total > 100) return null
    roles.push({
      id,
      name,
      headcount: int(row.headcount, 0, 500, 1),
      rate: real(row.rate, 0, 100_000, 9000),
      allocation,
    })
  }
  const evals: Eval[] = []
  const evalIds = new Set<string>()
  for (const item of body.evals) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const row = item as Record<string, unknown>
    const id = text(row.id, 64)
    const name = text(row.name, 60)
    if (!id || !name || evalIds.has(id)) return null
    evalIds.add(id)
    const gateStage = text(row.gateStage, 64)
    evals.push({
      id,
      name,
      metric: text(row.metric, 40),
      target: text(row.target, 40),
      cadence: text(row.cadence, 40),
      gateStage: stageIds.has(gateStage) ? gateStage : '',
      status: EVAL_STATUS.includes(row.status as EvalStatus)
        ? (row.status as EvalStatus)
        : 'not-started',
    })
  }
  return { stages, roles, evals }
}

export function readProjectInput(raw: unknown): {
  name: string
  brief: string
  stage: ProjectStage
  startDate: number
} | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const body = raw as Record<string, unknown>
  const name = text(body.name, 80)
  if (!name) return null
  return {
    name,
    brief: text(body.brief, 280),
    stage: STAGES.includes(body.stage as ProjectStage) ? (body.stage as ProjectStage) : 'scoping',
    startDate: int(body.startDate, 0, 4_102_444_800_000, Date.now()),
  }
}

export function readTemplate(value: unknown): TemplateId {
  return value === 'dense' || value === 'moe' || value === 'small' || value === 'blank'
    ? value
    : 'blank'
}
