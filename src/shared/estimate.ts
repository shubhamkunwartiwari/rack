import type {
  AcceleratorKey,
  Block,
  BlockConfig,
  BlockKind,
  PortType,
  Precision,
  ProjectSettings,
} from './types'

export const BLOCK_KINDS: BlockKind[] = [
  'embedding',
  'attention',
  'ffn',
  'moe',
  'norm',
  'residual',
  'projection',
  'loss',
  'custom',
]

export type BlockMeta = {
  label: string
  code: string
  group: 'input' | 'compute' | 'output'
  input: PortType[]
  output: PortType | null
  blurb: string
}

export const BLOCK_META: Record<BlockKind, BlockMeta> = {
  embedding: {
    label: 'Embedding',
    code: 'EMB',
    group: 'input',
    input: [],
    output: 'embedding',
    blurb: 'Token lookup table. Params = vocab × d_model.',
  },
  attention: {
    label: 'Attention',
    code: 'ATT',
    group: 'compute',
    input: ['embedding', 'hidden'],
    output: 'hidden',
    blurb: 'QKVO projections across layers, K/V reduced by GQA.',
  },
  ffn: {
    label: 'Dense FFN',
    code: 'FFN',
    group: 'compute',
    input: ['embedding', 'hidden'],
    output: 'hidden',
    blurb: 'Two dense matrices per layer: 2 × d × ffn.',
  },
  moe: {
    label: 'MoE experts',
    code: 'MoE',
    group: 'compute',
    input: ['embedding', 'hidden'],
    output: 'hidden',
    blurb: 'Expert bank: layers × experts × 3 × d × ffn, active share top-k.',
  },
  norm: {
    label: 'Norm',
    code: 'NRM',
    group: 'compute',
    input: ['embedding', 'hidden'],
    output: 'hidden',
    blurb: 'Layer norms and scalars; negligible parameter cost.',
  },
  residual: {
    label: 'Residual',
    code: 'RES',
    group: 'compute',
    input: ['embedding', 'hidden'],
    output: 'hidden',
    blurb: 'Additive skip connection; no parameters.',
  },
  projection: {
    label: 'Projection',
    code: 'PRJ',
    group: 'output',
    input: ['embedding', 'hidden'],
    output: 'logits',
    blurb: 'Unembedding to vocabulary logits: d × vocab.',
  },
  loss: {
    label: 'Loss head',
    code: 'LSS',
    group: 'output',
    input: ['logits'],
    output: null,
    blurb: 'Cross-entropy objective. Requires logits input.',
  },
  custom: {
    label: 'Custom',
    code: 'CUS',
    group: 'compute',
    input: ['embedding', 'hidden'],
    output: 'hidden',
    blurb: 'Placeholder block for a component outside the estimate.',
  },
}

export const PRECISIONS: Precision[] = ['fp32', 'bf16', 'fp16', 'fp8', 'int8', 'int4']

export const PRECISION_BYTES: Record<Precision, number> = {
  fp32: 4,
  bf16: 2,
  fp16: 2,
  fp8: 1,
  int8: 1,
  int4: 0.5,
}

export const ACCELERATORS: Record<
  AcceleratorKey,
  { label: string; tflops: number; rate: number }
> = {
  h100: { label: 'H100 SXM', tflops: 989, rate: 3.4 },
  h200: { label: 'H200', tflops: 989, rate: 4.2 },
  b200: { label: 'B200', tflops: 2250, rate: 6.8 },
  a100: { label: 'A100 80GB', tflops: 312, rate: 2.0 },
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  tokensB: 2000,
  mfu: 40,
  accelerator: 'h100',
  shards: 8,
}

export function defaultConfig(kind: BlockKind): BlockConfig {
  const base: BlockConfig = {
    dModel: 4096,
    layers: 32,
    heads: 32,
    kvHeads: 8,
    ffnWidth: 14336,
    experts: 8,
    topK: 2,
    vocab: 32000,
    seqLen: 4096,
    batch: 64,
    precision: 'bf16',
  }
  if (kind === 'embedding') return { ...base, layers: 1 }
  if (kind === 'norm') return { ...base, ffnWidth: 0 }
  if (kind === 'residual' || kind === 'loss') return { ...base, layers: 0, ffnWidth: 0 }
  if (kind === 'projection') return { ...base, layers: 0, ffnWidth: 0 }
  if (kind === 'custom') return { ...base, layers: 0, ffnWidth: 0 }
  return base
}

/** Parameter count for a single block, following the estimate in the spec. */
export function blockParams(kind: BlockKind, c: BlockConfig): number {
  const d = c.dModel
  switch (kind) {
    case 'embedding':
      return c.vocab * d
    case 'attention': {
      const ratio = c.heads > 0 ? Math.min(c.kvHeads / c.heads, 1) : 1
      return c.layers * d * d * (2 + 2 * ratio)
    }
    case 'ffn':
      return c.layers * 2 * d * c.ffnWidth
    case 'moe':
      return c.layers * Math.max(1, c.experts) * 3 * d * c.ffnWidth
    case 'norm':
      return c.layers * 2 * d
    case 'projection':
      return d * c.vocab
    case 'loss':
    case 'residual':
    case 'custom':
      return 0
  }
}

/** Parameters touched by one forward pass (MoE only activates top-k experts). */
export function blockActiveParams(kind: BlockKind, c: BlockConfig): number {
  const params = blockParams(kind, c)
  if (kind !== 'moe') return params
  const experts = Math.max(1, c.experts)
  return params * (Math.min(c.topK, experts) / experts)
}

/** Bytes held per parameter during training: weights plus master weights and Adam. */
export function trainingBytes(kind: BlockKind, c: BlockConfig): number {
  const params = blockParams(kind, c)
  const master = c.precision === 'fp32' ? 0 : 8
  return params * (PRECISION_BYTES[c.precision] + master)
}

function activationBytes(c: BlockConfig): number {
  return (
    Math.max(1, c.batch) *
    Math.max(1, c.seqLen) *
    Math.max(1, c.dModel) *
    Math.max(1, c.layers) *
    16
  )
}

export type Estimate = {
  params: number
  activeParams: number
  totalTrainingBytes: number
  bytesPerGpu: number
  flops: number
  gpuHours: number
  computeCost: number
  byBlock: { id: string; label: string; kind: BlockKind; params: number; share: number }[]
}

export function estimateProject(
  blocks: Block[],
  settings: ProjectSettings,
): Estimate {
  let params = 0
  let activeParams = 0
  let trainingBytesTotal = 0
  let activations = 0
  for (const block of blocks) {
    params += blockParams(block.kind, block.config)
    activeParams += blockActiveParams(block.kind, block.config)
    trainingBytesTotal += trainingBytes(block.kind, block.config)
    activations = Math.max(activations, activationBytes(block.config))
  }
  const shards = Math.max(1, settings.shards)
  const mfu = Math.min(Math.max(settings.mfu, 1), 90) / 100
  const perGpu = ACCELERATORS[settings.accelerator] ?? ACCELERATORS.h100
  const tokens = Math.max(0, settings.tokensB) * 1e9
  // ~6 FLOPs per parameter-token pair for training.
  const flops = 6 * activeParams * tokens
  const gpuHours = flops / (perGpu.tflops * 1e12 * mfu * 0.4) / 3600
  return {
    params,
    activeParams,
    totalTrainingBytes: trainingBytesTotal + activations,
    bytesPerGpu: (trainingBytesTotal + activations) / shards,
    flops,
    gpuHours: Number.isFinite(gpuHours) ? gpuHours : 0,
    computeCost: (Number.isFinite(gpuHours) ? gpuHours : 0) * perGpu.rate,
    byBlock: blocks.map((block) => {
      const p = blockParams(block.kind, block.config)
      return {
        id: block.id,
        label: block.label,
        kind: block.kind,
        params: p,
        share: params > 0 ? p / params : 0,
      }
    }),
  }
}

/** Edge validity: typed ports must match and a loss head is terminal. */
export function canConnect(
  from: Block,
  to: Block,
): { ok: boolean; port: PortType; error?: string } {
  const source = BLOCK_META[from.kind]
  const target = BLOCK_META[to.kind]
  if (!source.output) return { ok: false, port: 'hidden', error: 'That block has no output.' }
  if (target.input.length === 0)
    return { ok: false, port: source.output, error: 'That block is a source and takes no input.' }
  if (!target.input.includes(source.output))
    return {
      ok: false,
      port: source.output,
      error: `${source.label} outputs ${source.output}, ${target.label} needs ${target.input.join(' or ')}.`,
    }
  return { ok: true, port: source.output }
}

export function createsCycle(
  edges: { fromId: string; toId: string }[],
  fromId: string,
  toId: string,
): boolean {
  if (fromId === toId) return true
  const next = new Map<string, string[]>()
  for (const edge of edges) {
    const list = next.get(edge.fromId) ?? []
    list.push(edge.toId)
    next.set(edge.fromId, list)
  }
  const stack = [toId]
  const seen = new Set<string>()
  while (stack.length) {
    const id = stack.pop()!
    if (id === fromId) return true
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...(next.get(id) ?? []))
  }
  return false
}
