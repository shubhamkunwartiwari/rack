import { defaultConfig } from '../shared/estimate'
import { TEMPLATES } from '../shared/templates'
import type {
  Block,
  BlockConfig,
  BlockKind,
  Eval,
  Edge,
  Role,
  Stage,
  TemplateId,
} from '../shared/types'
import type { ProjectInput } from './db'

const uid = () => crypto.randomUUID()

function block(
  kind: BlockKind,
  label: string,
  x: number,
  y: number,
  config: Partial<BlockConfig> = {},
): Block {
  return {
    id: uid(),
    kind,
    label,
    x,
    y,
    config: { ...defaultConfig(kind), ...config },
  }
}

function link(from: Block, to: Block): Edge {
  return { id: uid(), fromId: from.id, toId: to.id, port: 'hidden' }
}

type StageDef = [name: string, startWeek: number, endWeek: number, ownerRole: string, note: string]

function stagesFrom(defs: StageDef[]): Stage[] {
  const ids = defs.map(() => uid())
  return defs.map(([name, startWeek, endWeek, ownerRole, computeNote], index) => ({
    id: ids[index]!,
    name,
    position: index,
    startWeek,
    endWeek,
    ownerRole,
    computeNote,
    dependsOn: index > 0 ? [ids[index - 1]!] : [],
  }))
}

function role(
  name: string,
  headcount: number,
  rate: number,
  stages: Stage[],
  percents: number[],
): Role {
  const allocation: Record<string, number> = {}
  stages.forEach((stage, index) => {
    const value = percents[index] ?? 0
    if (value > 0) allocation[stage.id] = value
  })
  return { id: uid(), name, headcount, rate, allocation }
}

function evalRow(
  name: string,
  metric: string,
  target: string,
  cadence: string,
  gate: Stage | undefined,
  status: Eval['status'] = 'not-started',
): Eval {
  return {
    id: uid(),
    name,
    metric,
    target,
    cadence,
    gateStage: gate?.id ?? '',
    status,
  }
}

type Seed = Omit<ProjectInput, 'name' | 'brief' | 'stage' | 'startDate'>

function dense(): Seed {
  const embed = block('embedding', 'Token embedding', 40, 200, {
    dModel: 4096,
    vocab: 32000,
    seqLen: 4096,
    batch: 64,
  })
  const attention = block('attention', 'GQA attention ×32', 280, 200, {
    dModel: 4096,
    layers: 32,
    heads: 32,
    kvHeads: 8,
  })
  const ffn = block('ffn', 'SwiGLU FFN ×32', 520, 200, {
    dModel: 4096,
    layers: 32,
    ffnWidth: 14336,
  })
  const norm = block('norm', 'RMSNorm', 760, 200, { dModel: 4096, layers: 32 })
  const projection = block('projection', 'LM head', 1000, 200, {
    dModel: 4096,
    vocab: 32000,
  })
  const loss = block('loss', 'Cross-entropy', 1240, 200, { dModel: 4096, seqLen: 4096 })
  const blocks = [embed, attention, ffn, norm, projection, loss]
  const stages = stagesFrom([
    ['Data curation', 0, 6, 'Data', '12B tokens filtered from 3 sources'],
    ['Pretrain', 6, 18, 'Infrastructure', '8×H100, 2.4T tokens'],
    ['SFT', 18, 23, 'Research', '180k instruction pairs'],
    ['Preference tuning', 23, 27, 'Research', 'DPO on 40k pairs'],
    ['Eval gates', 27, 31, 'Eval', '7 gated suites'],
    ['Deploy', 31, 34, 'Product', '8×H100 inference pool'],
  ])
  return {
    settings: { tokensB: 2400, mfu: 42, accelerator: 'h100', shards: 8 },
    blocks,
    edges: [
      link(embed, attention),
      link(attention, ffn),
      link(ffn, norm),
      link(norm, projection),
      link(projection, loss),
    ],
    stages,
    roles: [
      role('Research', 4, 12000, stages, [0, 40, 25, 20, 15, 0]),
      role('Infrastructure', 3, 11000, stages, [0, 45, 10, 10, 10, 25]),
      role('Data', 2, 8000, stages, [60, 25, 0, 0, 15, 0]),
      role('Eval', 2, 9000, stages, [0, 10, 15, 15, 60, 0]),
      role('Product', 1, 9000, stages, [10, 0, 10, 20, 20, 40]),
    ],
    evals: [
      evalRow('Validation loss', 'loss', '≤ 2.05', 'daily', stages[1], 'running'),
      evalRow('MMLU 5-shot', 'accuracy', '0.70', 'weekly', stages[1], 'running'),
      evalRow('GSM8K 8-shot', 'exact match', '0.72', 'weekly', stages[2]),
      evalRow('HumanEval', 'pass@1', '0.42', 'per release', stages[2]),
      evalRow('MT-Bench', 'judge score', '7.4', 'weekly', stages[3]),
      evalRow('Toxicity sweep', 'flagged rate', '≤ 0.5%', 'per release', stages[4]),
      evalRow('p95 latency', 'milliseconds', '≤ 400', 'continuous', stages[5]),
    ],
  }
}

function moe(): Seed {
  const embed = block('embedding', 'Multilingual embedding', 40, 180, {
    dModel: 4096,
    vocab: 128000,
    seqLen: 8192,
    batch: 48,
  })
  const attention = block('attention', 'MLA attention ×32', 280, 180, {
    dModel: 4096,
    layers: 32,
    heads: 32,
    kvHeads: 8,
  })
  const experts = block('moe', 'Experts 8 · top-2', 520, 180, {
    dModel: 4096,
    layers: 32,
    ffnWidth: 14336,
    experts: 8,
    topK: 2,
  })
  const norm = block('norm', 'RMSNorm', 760, 180, { dModel: 4096, layers: 32 })
  const projection = block('projection', 'Shared LM head', 1000, 180, {
    dModel: 4096,
    vocab: 128000,
  })
  const loss = block('loss', 'Router-aware CE', 1240, 180, { dModel: 4096, seqLen: 8192 })
  const blocks = [embed, attention, experts, norm, projection, loss]
  const stages = stagesFrom([
    ['Data curation', 0, 8, 'Data', '5.2T multilingual tokens'],
    ['Router research', 8, 14, 'Research', 'Top-k sweep on 4 validation sets'],
    ['Pretrain', 14, 28, 'Infrastructure', '16×H200, 3T tokens'],
    ['SFT', 28, 34, 'Research', '320k instruction pairs'],
    ['Preference tuning', 34, 38, 'Research', 'DPO + router balance loss'],
    ['Eval gates', 38, 43, 'Eval', 'Per-language coverage matrix'],
    ['Deploy', 43, 46, 'Product', 'Expert-parallel serving'],
  ])
  return {
    settings: { tokensB: 3000, mfu: 38, accelerator: 'h200', shards: 16 },
    blocks,
    edges: [
      link(embed, attention),
      link(attention, experts),
      link(experts, norm),
      link(norm, projection),
      link(projection, loss),
    ],
    stages,
    roles: [
      role('Research', 6, 12000, stages, [0, 30, 25, 20, 15, 10, 0]),
      role('Infrastructure', 4, 11000, stages, [0, 10, 55, 10, 5, 5, 15]),
      role('Data', 3, 8000, stages, [65, 15, 20, 0, 0, 0, 0]),
      role('Eval', 2, 9000, stages, [0, 20, 10, 10, 10, 40, 10]),
      role('Product', 1, 9000, stages, [5, 0, 0, 10, 15, 25, 45]),
    ],
    evals: [
      evalRow('Router balance', 'expert load σ', '≤ 0.08', 'daily', stages[1], 'running'),
      evalRow('Validation loss', 'loss', '≤ 1.98', 'daily', stages[2], 'running'),
      evalRow('M-MMLU', 'accuracy', '0.66', 'weekly', stages[2]),
      evalRow('FLORES-200', 'chrF++', '48.0', 'per release', stages[3]),
      evalRow('Arena preference', 'win rate', '≥ 55%', 'weekly', stages[4]),
      evalRow('Expert dropout', 'degraded tokens', '≤ 2%', 'per release', stages[5]),
      evalRow('Throughput', 'tokens/sec/GPU', '≥ 2200', 'continuous', stages[6]),
    ],
  }
}

function small(): Seed {
  const embed = block('embedding', 'Token embedding', 40, 200, {
    dModel: 2048,
    vocab: 32000,
    seqLen: 8192,
    batch: 128,
  })
  const attention = block('attention', 'GQA attention ×24', 280, 180, {
    dModel: 2048,
    layers: 24,
    heads: 16,
    kvHeads: 4,
  })
  const ffn = block('ffn', 'SwiGLU FFN ×24', 520, 180, {
    dModel: 2048,
    layers: 24,
    ffnWidth: 5632,
  })
  const norm = block('norm', 'RMSNorm', 760, 180, { dModel: 2048, layers: 24 })
  const projection = block('projection', 'LM head', 1000, 180, {
    dModel: 2048,
    vocab: 32000,
  })
  const loss = block('loss', 'Cross-entropy', 1240, 180, { dModel: 2048, seqLen: 8192 })
  const stages = stagesFrom([
    ['Data curation', 0, 3, 'Data', '300B tokens, deduplicated'],
    ['Pretrain', 3, 9, 'Infrastructure', '4×H100, 300B tokens'],
    ['SFT', 9, 12, 'Research', '60k instruction pairs'],
    ['Eval gates', 12, 17, 'Eval', '12 suites, tight thresholds'],
    ['Deploy', 17, 19, 'Product', 'Single-node serving'],
  ])
  const blocks = [embed, attention, ffn, norm, projection, loss]
  return {
    settings: { tokensB: 300, mfu: 45, accelerator: 'h100', shards: 4 },
    blocks,
    edges: [
      link(embed, attention),
      link(attention, ffn),
      link(ffn, norm),
      link(norm, projection),
      link(projection, loss),
    ],
    stages,
    roles: [
      role('Research', 2, 12000, stages, [0, 40, 30, 20, 10]),
      role('Infrastructure', 1, 11000, stages, [0, 60, 10, 15, 15]),
      role('Data', 1, 8000, stages, [70, 20, 0, 10, 0]),
      role('Eval', 2, 9000, stages, [0, 0, 10, 80, 10]),
      role('Product', 1, 9000, stages, [10, 0, 10, 20, 60]),
    ],
    evals: [
      evalRow('Validation loss', 'loss', '≤ 2.22', 'daily', stages[1], 'running'),
      evalRow('MMLU 5-shot', 'accuracy', '0.58', 'weekly', stages[1]),
      evalRow('ARC-Challenge', 'accuracy', '0.52', 'weekly', stages[3]),
      evalRow('TruthfulQA', 'truthful %', '≥ 55%', 'per release', stages[3]),
      evalRow('BBH', 'normalized', '0.42', 'per release', stages[3]),
      evalRow('Safety red team', 'critical findings', '0', 'per release', stages[3]),
      evalRow('Cost per 1M tokens', 'USD', '≤ 0.30', 'monthly', stages[4]),
    ],
  }
}

function blank(): Seed {
  return {
    settings: { tokensB: 1000, mfu: 40, accelerator: 'h100', shards: 8 },
    blocks: [],
    edges: [],
    stages: [],
    roles: [],
    evals: [],
  }
}

export function buildTemplate(template: TemplateId): Seed & {
  name: string
  brief: string
  stage: ProjectInput['stage']
  startDate: number
} {
  const meta = TEMPLATES.find((item) => item.id === template) ?? TEMPLATES[3]!
  const seed =
    template === 'dense'
      ? dense()
      : template === 'moe'
        ? moe()
        : template === 'small'
          ? small()
          : blank()
  // Plans start on the current Monday so timeline weeks line up with the week.
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
  return {
    ...seed,
    name: meta.projectName,
    brief: meta.brief,
    stage: template === 'blank' ? 'scoping' : template === 'dense' ? 'design' : 'design',
    startDate: start.getTime(),
  }
}
