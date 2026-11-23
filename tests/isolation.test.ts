/**
 * Cross-account isolation through the HTTP boundary.
 *
 * Unlike tests/app.test.ts (which calls the Hono handler in-process), this
 * suite starts a real HTTP server on loopback and issues real fetch requests
 * as two distinct identities. The production entrypoint (src/worker/index.ts)
 * resolves identity exclusively through the Freebuff SDK; the header resolver
 * below is only mounted by this test server, standing in for the OIDC issuer
 * that is not available in a local test run.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Miniflare } from 'miniflare'
import type { Project } from '../src/shared/types'
import { createApp } from '../src/worker/app'
import type { Env } from '../src/worker/auth'

const runtime = new Miniflare({
  workers: [
    {
      config: {
        name: 'isolation-db',
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
        env: { DB: { type: 'd1', name: 'rack-isolation-test' } },
      },
    },
  ],
  port: 0,
})

let server: ReturnType<typeof Bun.serve> | undefined
let origin = ''
let env: Env
let db: D1Database

beforeAll(async () => {
  db = (await runtime.getD1Database('DB')) as unknown as D1Database
  env = {
    DB: db,
    ASSETS: { fetch: async () => new Response('public page') } as unknown as Fetcher,
  }
  const app = createApp(async (request) => {
    const sub = request.headers.get('x-identity')
    return sub ? { sub } : null
  })
  server = Bun.serve({
    port: 0,
    fetch: (request) => app.fetch(request, env),
  })
  origin = `http://127.0.0.1:${server.port}`
  // Mutations are same-origin checked against this value.
  env.APP_ORIGIN = origin
}, 20_000)

afterAll(async () => {
  server?.stop(true)
  await runtime.dispose()
})

type Identity = 'alice' | 'bob'

async function call(
  identity: Identity | null,
  path: string,
  method = 'GET',
  body?: unknown,
) {
  return fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(identity ? { 'x-identity': identity } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      Origin: origin,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

test('two identities are isolated at the HTTP boundary for reads and writes', async () => {
  expect((await call(null, '/api/projects')).status).toBe(401)

  const created = await call('alice', '/api/projects', 'POST', {
    template: 'dense',
    name: 'Alice run',
  })
  expect(created.status).toBe(201)
  const { project } = (await created.json()) as { project: Project }
  expect(project.blocks).toHaveLength(6)

  // Bob sees an empty workspace and cannot reach Alice's project by id.
  const bobList = (await (await call('bob', '/api/projects')).json()) as {
    projects: Project[]
  }
  expect(bobList.projects).toHaveLength(0)
  expect((await call('bob', `/api/projects/${project.id}`)).status).toBe(404)
  expect((await call('bob', `/api/projects/${project.id}`, 'DELETE')).status).toBe(404)
  expect(
    (
      await call('bob', `/api/projects/${project.id}/graph`, 'PUT', {
        blocks: [],
        edges: [],
      })
    ).status,
  ).toBe(404)
  expect(
    (
      await call('bob', `/api/projects/${project.id}/plan`, 'PUT', {
        stages: [],
        roles: [],
        evals: [],
      })
    ).status,
  ).toBe(404)
  expect(
    (
      await call('bob', `/api/projects/${project.id}/settings`, 'PUT', {
        tokensB: 1,
        mfu: 1,
        accelerator: 'a100',
        shards: 1,
      })
    ).status,
  ).toBe(404)

  // Alice still owns the untouched project; her own write succeeds.
  const graph = {
    blocks: project.blocks.slice(0, 2).map((block, index) => ({
      ...block,
      id: `alice-${index}`,
    })),
    edges: [
      {
        id: 'alice-edge',
        fromId: 'alice-0',
        toId: 'alice-1',
        port: 'embedding',
      },
    ],
  }
  expect(
    (await call('alice', `/api/projects/${project.id}/graph`, 'PUT', graph)).status,
  ).toBe(200)

  const reloaded = (await (
    await call('alice', `/api/projects/${project.id}`)
  ).json()) as { project: Project }
  expect(reloaded.project.blocks).toHaveLength(2)
  expect(reloaded.project.edges).toHaveLength(1)
  expect(reloaded.project.name).toBe('Alice run')

  // Bob's own project is separate and invisible to Alice.
  const bobCreated = await call('bob', '/api/projects', 'POST', {
    template: 'blank',
    name: 'Bob run',
  })
  expect(bobCreated.status).toBe(201)
  const bobProject = ((await bobCreated.json()) as { project: Project }).project
  expect((await call('alice', `/api/projects/${bobProject.id}`)).status).toBe(404)
  expect(
    (
      await call('alice', `/api/projects/${bobProject.id}`, 'PATCH', {
        name: 'Taken over',
      })
    ).status,
  ).toBe(404)
  const aliceList = (await (await call('alice', '/api/projects')).json()) as {
    projects: Project[]
  }
  expect(aliceList.projects.map((item) => item.name)).toEqual(['Alice run'])
  const bobFinal = (await (await call('bob', '/api/projects')).json()) as {
    projects: Project[]
  }
  expect(bobFinal.projects.map((item) => item.name)).toEqual(['Bob run'])
})
