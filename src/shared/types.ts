export type PortType = 'embedding' | 'hidden' | 'logits'

export type BlockKind =
  | 'embedding'
  | 'attention'
  | 'ffn'
  | 'moe'
  | 'norm'
  | 'residual'
  | 'projection'
  | 'loss'
  | 'custom'

export type Precision = 'fp32' | 'bf16' | 'fp16' | 'fp8' | 'int8' | 'int4'

export type AcceleratorKey = 'h100' | 'h200' | 'b200' | 'a100'

export type ProjectStage =
  | 'scoping'
  | 'design'
  | 'training'
  | 'evaluating'
  | 'shipping'

export type BlockConfig = {
  dModel: number
  layers: number
  heads: number
  kvHeads: number
  ffnWidth: number
  experts: number
  topK: number
  vocab: number
  seqLen: number
  batch: number
  precision: Precision
}

export type Block = {
  id: string
  kind: BlockKind
  label: string
  x: number
  y: number
  config: BlockConfig
}

export type Edge = {
  id: string
  fromId: string
  toId: string
  port: PortType
}

export type ProjectSettings = {
  tokensB: number
  mfu: number
  accelerator: AcceleratorKey
  shards: number
}

export type Stage = {
  id: string
  name: string
  position: number
  startWeek: number
  endWeek: number
  ownerRole: string
  computeNote: string
  dependsOn: string[]
}

export type Role = {
  id: string
  name: string
  headcount: number
  rate: number
  /** Percentage of the role's time per stage, keyed by stage id. */
  allocation: Record<string, number>
}

export type EvalStatus = 'not-started' | 'running' | 'pass' | 'fail'

export type Eval = {
  id: string
  name: string
  metric: string
  target: string
  cadence: string
  gateStage: string
  status: EvalStatus
}

export type Project = {
  id: string
  name: string
  brief: string
  stage: ProjectStage
  startDate: number
  createdAt: number
  updatedAt: number
  settings: ProjectSettings
  blocks: Block[]
  edges: Edge[]
  stages: Stage[]
  roles: Role[]
  evals: Eval[]
}

export type ProjectSummary = {
  id: string
  name: string
  brief: string
  stage: ProjectStage
  startDate: number
  updatedAt: number
  params: number
  teamSize: number
  nextMilestone: number | null
  progress: number[]
}

export type GraphPayload = { blocks: Block[]; edges: Edge[] }
export type PlanPayload = { stages: Stage[]; roles: Role[]; evals: Eval[] }

export type TemplateId = 'dense' | 'moe' | 'small' | 'blank'

export type Session = {
  user: { sub: string; name?: string; email?: string } | null
  mode: 'local' | 'freebuff' | 'setup'
  database: boolean
}
