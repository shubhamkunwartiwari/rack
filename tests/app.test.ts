import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Miniflare } from 'miniflare'
import { defaultConfig } from '../src/shared/estimate'
import type { Block, BlockKind, Project } from '../src/shared/types'
import { createApp } from '../src/worker/app'
import { currentUser, type Env } from '../src/worker/auth'

const runtime = new Miniflare({
  workers: [
    {
      config: {
        name: 'test-db',
        compatibilityDate: '2026-11-11',
        manifest: {
          mainModule: 'index.js',
          modules: {
            'index.js': {
              type: 'esm',
              contents:
                'export default { fetch() { return new Response("test") } }',
            },
          },
        },
        env: { DB: { type: 'd1', name: 'rack-test' } },
      },
    },
  ],
  port: 0,
})
let env: Env
beforeAll(async () => {
  const db = await runtime.getD1Database('DB')
  env = {
    DB: db as unknown as D1Database,
    APP_ORIGIN: 'https://app.example.test',
    ASSETS: {
      fetch: async () => new Response('public page'),
    } as unknown as Fetcher,
  }
}, 20_000)
afterAll(() => runtime.dispose())

// This identity seam exists only in the app factory. The Worker entrypoint
// never reads these test headers and always calls the real auth SDK.
const app = createApp(async (request) => {
  const sub = request.headers.get('test-user')
  return sub ? { sub } : null
})
const call = (
  path: string,
  user?: string,
  method = 'GET',
  body?: unknown,
  origin = env.APP_ORIGIN!,
) =>
  app.request(
    `https://app.example.test${path}`,
    {
      method,
      headers: {
        ...(user ? { 'test-user': user } : {}),
        Origin: origin,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  )

const block = (
  id: string,
  kind: BlockKind,
  config: Record<string, unknown> = {},
): Block => ({
  id,
  kind,
  label: kind,
  x: 0,
  y: 0,
  config: { ...defaultConfig(kind), ...config },
})

async function createProject(user: string, template = 'blank') {
  const response = await call('/api/projects', user, 'POST', { template })
  expect(response.status).toBe(201)
  return ((await response.json()) as { project: Project }).project
}

test('unauthenticated data routes refuse access and public assets remain public', async () => {
  for (const [path, method] of [
    ['/api/projects', 'GET'],
    ['/api/projects', 'POST'],
    ['/api/projects/absent', 'GET'],
    ['/api/projects/absent', 'DELETE'],
    ['/api/projects/absent/graph', 'PUT'],
    ['/api/projects/absent/plan', 'PUT'],
  ]) {
    const response = await call(path!, undefined, method)
    expect(response.status).toBe(401)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  }
  expect(await (await call('/')).text()).toBe('public page')
  expect((await call('/api/health')).status).toBe(200)
})

test('seeded plans carry a graph, pipeline, team and gates, isolated by owner', async () => {
  const project = await createProject('alice', 'dense')
  expect(project.blocks).toHaveLength(6)
  expect(project.stages).toHaveLength(6)
  expect(project.roles).toHaveLength(5)
  expect(project.evals).toHaveLength(7)
  expect(project.settings.tokensB).toBe(2400)

  const list = (await (await call('/api/projects', 'alice')).json()) as {
    projects: { id: string; params: number; teamSize: number; progress: number[] }[]
  }
  const summary = list.projects.find((item) => item.id === project.id)
  expect(summary).toBeDefined()
  expect(summary!.params).toBeGreaterThan(5e9)
  expect(summary!.teamSize).toBe(12)
  expect(summary!.progress).toHaveLength(6)

  expect((await call(`/api/projects/${project.id}`, 'bob')).status).toBe(404)
  expect(
    (await (await call('/api/projects', 'bob')).json() as { projects: unknown[] })
      .projects,
  ).toHaveLength(0)
  expect(
    (
      await call(`/api/projects/${project.id}`, 'bob', 'PATCH', {
        name: 'Taken over',
      })
    ).status,
  ).toBe(404)
  expect((await call(`/api/projects/${project.id}`, 'bob', 'DELETE')).status).toBe(
    404,
  )
})

test('graph and plan saves round-trip, reject bad references and over-allocation', async () => {
  const project = await createProject('carol', 'blank')
  expect(project.blocks).toHaveLength(0)

  const embed = block('b-embed', 'embedding')
  const attention = block('b-attn', 'attention')
  const graph = {
    blocks: [embed, attention],
    edges: [{ id: 'e-1', fromId: embed.id, toId: attention.id, port: 'embedding' }],
  }
  expect(
    (await call(`/api/projects/${project.id}/graph`, 'carol', 'PUT', graph)).status,
  ).toBe(200)
  let loaded = (await (await call(`/api/projects/${project.id}`, 'carol')).json()) as {
    project: Project
  }
  expect(loaded.project.blocks).toHaveLength(2)
  expect(loaded.project.edges).toHaveLength(1)

  expect(
    (
      await call(`/api/projects/${project.id}/graph`, 'carol', 'PUT', {
        blocks: [embed],
        edges: [{ id: 'e-2', fromId: embed.id, toId: 'missing', port: 'hidden' }],
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await call(`/api/projects/${project.id}/graph`, 'carol', 'PUT', {
        blocks: [embed],
        edges: [{ id: 'e-3', fromId: embed.id, toId: embed.id, port: 'hidden' }],
      })
    ).status,
  ).toBe(400)

  const plan = {
    stages: [
      {
        id: 's-1',
        name: 'Pretrain',
        position: 0,
        startWeek: 0,
        endWeek: 8,
        ownerRole: 'Infrastructure',
        computeNote: '8 GPUs',
        dependsOn: [],
      },
      {
        id: 's-2',
        name: 'Eval',
        position: 1,
        startWeek: 8,
        endWeek: 12,
        ownerRole: 'Eval',
        computeNote: '',
        dependsOn: ['s-1'],
      },
    ],
    roles: [
      {
        id: 'r-1',
        name: 'Research',
        headcount: 2,
        rate: 10000,
        allocation: { 's-1': 60, 's-2': 40 },
      },
    ],
    evals: [
      {
        id: 'v-1',
        name: 'MMLU',
        metric: 'accuracy',
        target: '0.7',
        cadence: 'weekly',
        gateStage: 's-1',
        status: 'running',
      },
    ],
  }
  expect(
    (await call(`/api/projects/${project.id}/plan`, 'carol', 'PUT', plan)).status,
  ).toBe(200)
  loaded = (await (await call(`/api/projects/${project.id}`, 'carol')).json()) as {
    project: Project
  }
  expect(loaded.project.stages).toHaveLength(2)
  expect(loaded.project.stages[1]!.dependsOn).toEqual(['s-1'])
  expect(loaded.project.roles[0]!.allocation).toEqual({ 's-1': 60, 's-2': 40 })
  expect(loaded.project.evals[0]!.status).toBe('running')

  const overAllocated = {
    ...plan,
    roles: [
      {
        id: 'r-2',
        name: 'Research',
        headcount: 2,
        rate: 10000,
        allocation: { 's-1': 80, 's-2': 80 },
      },
    ],
  }
  expect(
    (
      await call(`/api/projects/${project.id}/plan`, 'carol', 'PUT', overAllocated)
    ).status,
  ).toBe(400)

  expect(
    (
      await call(`/api/projects/${project.id}/settings`, 'carol', 'PUT', {
        tokensB: 400,
        mfu: 55,
        accelerator: 'b200',
        shards: 16,
      })
    ).status,
  ).toBe(200)
  loaded = (await (await call(`/api/projects/${project.id}`, 'carol')).json()) as {
    project: Project
  }
  expect(loaded.project.settings).toMatchObject({
    tokensB: 400,
    mfu: 55,
    accelerator: 'b200',
    shards: 16,
  })
})

test('project details patch and delete are scoped to the owner', async () => {
  const project = await createProject('dana', 'small')
  const patched = await call(`/api/projects/${project.id}`, 'dana', 'PATCH', {
    name: 'Lumen v2',
    brief: 'Eval-first plan',
    stage: 'training',
    startDate: Date.parse('2026-01-05T00:00:00Z'),
  })
  expect(patched.status).toBe(200)
  const { project: updated } = (await patched.json()) as { project: Project }
  expect(updated).toMatchObject({
    name: 'Lumen v2',
    stage: 'training',
    brief: 'Eval-first plan',
  })
  expect((await call(`/api/projects/${project.id}`, 'dana', 'DELETE')).status).toBe(200)
  expect((await call(`/api/projects/${project.id}`, 'dana')).status).toBe(404)
})

test('rejects foreign origins, missing origins and oversized bodies', async () => {
  expect(
    (
      await call('/api/projects', 'alice', 'POST', { template: 'blank' }, 'https://foreign.example')
    ).status,
  ).toBe(403)
  expect(
    (
      await prismaRequestWithoutOrigin()
    ).status,
  ).toBe(403)
  const oversized = await call('/api/projects', 'alice', 'POST', {
    template: 'blank',
    name: 'x'.repeat(300_000),
  })
  expect(oversized.status).toBe(413)

  const malformed = await app.request(
    'https://app.example.test/api/projects',
    {
      method: 'POST',
      headers: {
        'test-user': 'alice',
        Origin: env.APP_ORIGIN!,
        'Content-Type': 'application/json',
      },
      body: 'not JSON',
    },
    env,
  )
  expect([201, 400]).toContain(malformed.status)
})

test('graph writes are owner-scoped and the stored payload round-trips exactly', async () => {
  const project = await createProject('erin', 'blank')
  const graph = {
    blocks: [block('b-1', 'embedding'), block('b-2', 'attention')],
    edges: [{ id: 'e-1', fromId: 'b-1', toId: 'b-2', port: 'embedding' }],
  }
  expect(
    (await call(`/api/projects/${project.id}/graph`, 'erin', 'PUT', graph)).status,
  ).toBe(200)

  const loaded = (await (
    await call(`/api/projects/${project.id}`, 'erin')
  ).json()) as { project: Project }
  expect(JSON.stringify(loaded.project.blocks)).toBe(JSON.stringify(graph.blocks))
  expect(JSON.stringify(loaded.project.edges)).toBe(JSON.stringify(graph.edges))

  const plan = {
    stages: [
      {
        id: 's-1',
        name: 'Pretrain',
        position: 0,
        startWeek: 0,
        endWeek: 8,
        ownerRole: 'Infrastructure',
        computeNote: '',
        dependsOn: [],
      },
    ],
    roles: [
      { id: 'r-1', name: 'Research', headcount: 2, rate: 10000, allocation: { 's-1': 100 } },
    ],
    evals: [],
  }
  expect(
    (await call(`/api/projects/${project.id}/plan`, 'erin', 'PUT', plan)).status,
  ).toBe(200)

  // A second account can neither read nor overwrite the first account's data.
  for (const [path, method, body] of [
    [`/api/projects/${project.id}`, 'GET', undefined],
    [`/api/projects/${project.id}/graph`, 'PUT', { blocks: [], edges: [] }],
    [`/api/projects/${project.id}/plan`, 'PUT', { stages: [], roles: [], evals: [] }],
    [
      `/api/projects/${project.id}/settings`,
      'PUT',
      { tokensB: 1, mfu: 1, accelerator: 'a100', shards: 1 },
    ],
  ] as const) {
    expect((await call(path, 'frank', method, body)).status).toBe(404)
  }

  const untouched = (await (
    await call(`/api/projects/${project.id}`, 'erin')
  ).json()) as { project: Project }
  expect(JSON.stringify(untouched.project.blocks)).toBe(JSON.stringify(graph.blocks))
  expect(untouched.project.roles[0]!.allocation).toEqual({ 's-1': 100 })
  expect(untouched.project.settings.tokensB).toBe(1000)
  expect(
    ((await (await call('/api/projects', 'frank')).json()) as { projects: unknown[] })
      .projects,
  ).toHaveLength(0)
})

function prismaRequestWithoutOrigin() {
  return app.request(
    'https://app.example.test/api/projects',
    { method: 'POST', headers: { 'test-user': 'alice' } },
    env,
  )
}

test('missing database reports setup and local preview identity never activates on hosted origins', async () => {
  const noDb = await app.request(
    'https://app.example.test/api/projects',
    { headers: { 'test-user': 'alice' } },
    { ...env, DB: undefined },
  )
  expect(noDb.status).toBe(503)
  expect(
    await currentUser(new Request('https://app.example.test/'), {} as Env),
  ).toBeNull()
  expect(
    await currentUser(new Request('http://localhost:5000/'), {
      APP_ORIGIN: 'https://app.example.test',
    } as Env),
  ).toBeNull()
  expect(
    await currentUser(new Request('http://localhost:5000/'), {} as Env),
  ).toMatchObject({ sub: 'local-preview' })
})
