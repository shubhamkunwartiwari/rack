import { createApp } from './app'
import { getAuth, type Env } from './auth'

const app = createApp()
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      const handler = (req: Request) =>
        Promise.resolve(app.fetch(req, env, ctx))
      const auth = getAuth(env)
      // SDK auth routes and refreshed cookies run before static assets.
      return await (auth ? auth.wrap(handler)(request) : handler(request))
    } catch {
      return Response.json(
        { error: 'Sign-in setup is unavailable. Please try again later.' },
        {
          status: 503,
          headers: { 'Cache-Control': 'private, no-store' },
        },
      )
    }
  },
}
