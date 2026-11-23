import { isSameOriginRequest } from '@freebuff/auth'
import type { FreebuffUser } from '@freebuff/auth'
import { Hono, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { appOrigin, currentUser, isLocalPreview, type Env } from './auth'
import {
  deleteProject,
  ensureSchema,
  insertProject,
  listProjects,
  loadProject,
  patchProject,
  replaceGraph,
  replacePlan,
} from './db'
import { buildTemplate } from './seeds'
import {
  readGraph,
  readPlan,
  readProjectInput,
  readSettings,
  readTemplate,
} from './shape'

type AppContext = {
  Bindings: Env
  Variables: { user: FreebuffUser; db: D1Database }
}
type Authenticate = (request: Request, env: Env) => Promise<FreebuffUser | null>

/** Tests inject identities; production always uses the Freebuff SDK. */
export function createApp(authenticate: Authenticate = currentUser) {
  const app = new Hono<AppContext>()
  app.get('/api/health', (c) => c.json({ ok: true }))
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store')
    await next()
  })
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: 256 * 1024,
      onError: (c) => c.json({ error: 'Request is too large.' }, 413),
    }),
  )
  app.get('/api/session', async (c) =>
    c.json({
      user: await authenticate(c.req.raw, c.env),
      mode: isLocalPreview(c.req.raw, c.env)
        ? 'local'
        : c.env.FREEBUFF_CLIENT_ID && c.env.APP_ORIGIN
          ? 'freebuff'
          : 'setup',
      database: Boolean(c.env.DB),
    }),
  )

  const authorize: MiddlewareHandler<AppContext> = async (c, next) => {
    const user = await authenticate(c.req.raw, c.env)
    if (!user) return c.json({ error: 'Sign in required.' }, 401)
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      const origin = appOrigin(c.req.raw, c.env)
      if (!origin || !isSameOriginRequest(c.req.raw, origin))
        return c.json({ error: 'Cross-origin request refused.' }, 403)
    }
    if (!c.env.DB)
      return c.json(
        { error: 'This app is still being set up. Please try again later.' },
        503,
      )
    await ensureSchema(c.env.DB)
    c.set('user', user)
    c.set('db', c.env.DB)
    await next()
  }
  app.use('/api/projects', authorize)
  app.use('/api/projects/*', authorize)

  app.get('/api/projects', async (c) =>
    c.json({ projects: await listProjects(c.get('db'), c.get('user').sub) }),
  )

  app.post('/api/projects', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    const template = readTemplate(
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).template
        : null,
    )
    const seed = buildTemplate(template)
    const nameInput =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).name
        : null
    const name =
      typeof nameInput === 'string' && nameInput.trim()
        ? nameInput.trim().slice(0, 80)
        : seed.name
    const id = await insertProject(c.get('db'), c.get('user').sub, {
      ...seed,
      name,
      brief:
        typeof body === 'object' && body && typeof (body as { brief?: unknown }).brief === 'string'
          ? (body as { brief: string }).brief.trim().slice(0, 280)
          : seed.brief,
    })
    const project = await loadProject(c.get('db'), id, c.get('user').sub)
    return project
      ? c.json({ project }, 201)
      : c.json({ error: 'Project could not be created.' }, 500)
  })

  app.get('/api/projects/:id', async (c) => {
    const project = await loadProject(c.get('db'), c.req.param('id'), c.get('user').sub)
    return project ? c.json({ project }) : c.json({ error: 'Project not found.' }, 404)
  })

  app.patch('/api/projects/:id', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ error: 'Send a project patch.' }, 400)
    const record = body as Record<string, unknown>
    const existing = await loadProject(
      c.get('db'),
      c.req.param('id'),
      c.get('user').sub,
    )
    if (!existing) return c.json({ error: 'Project not found.' }, 404)
    const input = readProjectInput({
      name: record.name ?? existing.name,
      brief: record.brief ?? existing.brief,
      stage: record.stage ?? existing.stage,
      startDate: record.startDate ?? existing.startDate,
    })
    if (!input) return c.json({ error: 'A project needs a name.' }, 400)
    const project = await patchProject(
      c.get('db'),
      c.req.param('id'),
      c.get('user').sub,
      input,
    )
    return project ? c.json({ project }) : c.json({ error: 'Project not found.' }, 404)
  })

  app.delete('/api/projects/:id', async (c) => {
    const removed = await deleteProject(
      c.get('db'),
      c.req.param('id'),
      c.get('user').sub,
    )
    return removed ? c.json({ ok: true }) : c.json({ error: 'Project not found.' }, 404)
  })

  app.put('/api/projects/:id/graph', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    const graph = readGraph(body)
    if (!graph)
      return c.json(
        { error: 'That architecture could not be saved. Check blocks, types and connections.' },
        400,
      )
    const saved = await replaceGraph(
      c.get('db'),
      c.req.param('id'),
      c.get('user').sub,
      graph.blocks,
      graph.edges,
    )
    return saved
      ? c.json({ ok: true, savedAt: Date.now() })
      : c.json({ error: 'Project not found.' }, 404)
  })

  app.put('/api/projects/:id/plan', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    const plan = readPlan(body)
    if (!plan)
      return c.json(
        {
          error:
            'That plan could not be saved. Check stage names, rates and that each role totals at most 100%.',
        },
        400,
      )
    const saved = await replacePlan(
      c.get('db'),
      c.req.param('id'),
      c.get('user').sub,
      plan,
    )
    return saved
      ? c.json({ ok: true, savedAt: Date.now() })
      : c.json({ error: 'Project not found.' }, 404)
  })

  app.put('/api/projects/:id/settings', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ error: 'Send run settings.' }, 400)
    const existing = await loadProject(c.get('db'), c.req.param('id'), c.get('user').sub)
    if (!existing) return c.json({ error: 'Project not found.' }, 404)
    const settings = readSettings(body)
    const updated = await c
      .get('db')
      .prepare('UPDATE projects SET settings = ?, updated_at = ? WHERE id = ? AND owner_sub = ?')
      .bind(JSON.stringify(settings), Date.now(), existing.id, c.get('user').sub)
      .run()
    return updated.success
      ? c.json({ ok: true })
      : c.json({ error: 'Settings could not be saved.' }, 500)
  })

  app.notFound((c) =>
    c.req.path === '/api' || c.req.path.startsWith('/api/')
      ? c.json({ error: 'Endpoint not found.' }, 404)
      : c.env.ASSETS.fetch(c.req.raw),
  )
  app.onError((_error, c) =>
    c.json({ error: 'Something went wrong. Please try again.' }, 500),
  )
  return app
}
