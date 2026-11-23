import { expect, test } from 'bun:test'
import {
  ACCELERATORS,
  BLOCK_META,
  blockActiveParams,
  blockParams,
  canConnect,
  createsCycle,
  defaultConfig,
  estimateProject,
  trainingBytes,
} from '../src/shared/estimate'
import type { Block, BlockKind } from '../src/shared/types'

const config = (kind: BlockKind, overrides: Record<string, number | string> = {}) => ({
  ...defaultConfig(kind),
  ...overrides,
})

test('parameter counts follow the documented formulas', () => {
  expect(blockParams('embedding', config('embedding', { vocab: 1000, dModel: 100 }))).toBe(100_000)
  // QKVO with GQA: d² × (2 + 2·kv/heads)
  expect(
    blockParams(
      'attention',
      config('attention', { layers: 2, dModel: 100, heads: 10, kvHeads: 5 }),
    ),
  ).toBe(60_000)
  expect(blockParams('ffn', config('ffn', { layers: 1, dModel: 100, ffnWidth: 200 }))).toBe(40_000)
  expect(
    blockParams(
      'moe',
      config('moe', { layers: 1, dModel: 100, ffnWidth: 100, experts: 4, topK: 1 }),
    ),
  ).toBe(120_000)
  expect(blockParams('projection', config('projection', { dModel: 100, vocab: 1000 }))).toBe(100_000)
  expect(blockParams('norm', config('norm', { layers: 4, dModel: 100 }))).toBe(800)
  expect(blockParams('custom', config('custom'))).toBe(0)
})

test('sparse models only activate the routed experts', () => {
  const moe = config('moe', { layers: 1, dModel: 100, ffnWidth: 100, experts: 4, topK: 1 })
  expect(blockActiveParams('moe', moe)).toBe(30_000)
  const dense = config('attention', { layers: 1, dModel: 100, heads: 10, kvHeads: 10 })
  expect(blockActiveParams('attention', dense)).toBe(blockParams('attention', dense))
})

test('training memory adds master weights and optimizer state', () => {
  const attention = config('attention', { layers: 1, dModel: 100, heads: 10, kvHeads: 5 })
  expect(trainingBytes('attention', { ...attention, precision: 'bf16' })).toBe(30_000 * 10)
  expect(trainingBytes('attention', { ...attention, precision: 'fp32' })).toBe(30_000 * 4)
})

test('project estimate sums blocks and derives compute cost from GPU hours', () => {
  const blocks: Block[] = [
    {
      id: 'a',
      kind: 'embedding',
      label: 'Embed',
      x: 0,
      y: 0,
      config: config('embedding', { vocab: 1000, dModel: 100 }) as never,
    },
    {
      id: 'b',
      kind: 'attention',
      label: 'Attn',
      x: 0,
      y: 0,
      config: config('attention', { layers: 1, dModel: 100, heads: 10, kvHeads: 5 }) as never,
    },
  ]
  const estimate = estimateProject(blocks, {
    tokensB: 1,
    mfu: 40,
    accelerator: 'h100',
    shards: 2,
  })
  expect(estimate.params).toBe(130_000)
  expect(estimate.activeParams).toBe(130_000)
  expect(estimate.bytesPerGpu).toBeGreaterThan(0)
  expect(estimate.gpuHours).toBeGreaterThan(0)
  expect(estimate.computeCost).toBeCloseTo(
    estimate.gpuHours * ACCELERATORS.h100.rate,
    8,
  )
  expect(estimate.byBlock[0]!.share).toBeCloseTo(100_000 / 130_000, 8)
  const empty = estimateProject([], { tokensB: 10, mfu: 40, accelerator: 'h100', shards: 1 })
  expect(empty.gpuHours).toBe(0)
  expect(empty.computeCost).toBe(0)
})

test('connection rules honour typed ports and reject cycles', () => {
  const make = (id: string, kind: BlockKind): Block => ({
    id,
    kind,
    label: id,
    x: 0,
    y: 0,
    config: defaultConfig(kind),
  })
  const embed = make('embed', 'embedding')
  const attention = make('attn', 'attention')
  const projection = make('proj', 'projection')
  const loss = make('loss', 'loss')

  expect(canConnect(embed, attention)).toMatchObject({ ok: true, port: 'embedding' })
  expect(canConnect(attention, projection)).toMatchObject({ ok: true, port: 'hidden' })
  expect(canConnect(projection, loss)).toMatchObject({ ok: true, port: 'logits' })
  expect(canConnect(attention, loss).ok).toBe(false)
  expect(canConnect(loss, attention).ok).toBe(false)
  expect(canConnect(attention, embed).ok).toBe(false)
  expect(BLOCK_META.loss.output).toBeNull()

  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'b', toId: 'c' },
  ]
  expect(createsCycle(edges, 'c', 'a')).toBe(true)
  expect(createsCycle(edges, 'a', 'c')).toBe(false)
  expect(createsCycle(edges, 'a', 'a')).toBe(true)
})
