# Web app

A small app with accounts and saved data, ready to become your own product.
The example workspace lets each user create, edit and delete private notes.

## Start and check

```sh
bun install
bun run dev
bun test
bun run typecheck
bun run build
```

Open the URL printed by Vite. The server binds to `0.0.0.0` for Cloud previews
and runs the Worker with a local D1 database. With no auth configuration on a
loopback origin, one clearly labelled local preview identity is used. This
fallback never applies on a hosted origin or to incomplete sign-in config.

## Make it yours

- `src/client/main.tsx` — the React interface and interactions.
- `src/client/style.css` — colors, typography and spacing.
- `src/worker/app.ts` — the private API and authorization.
- `src/worker/auth.ts` — Sign in with Freebuff and local preview identity.
- `src/worker/db.ts` — the D1 schema and row mapping.
- `src/shared/types.ts` — API types shared by browser and server.

Notes are capped at 1000 characters; the workspace lists the newest 100. All
queries bind parameters and scope ownership by the authenticated user's `sub`.
Build on this example instead of introducing another database or auth service.
Add pagination when your product needs longer lists. Schema initialization is
idempotent; append migrations deliberately as the app grows.

## Publish with Freebuff

When the user requests publishing, use the Publish button, or Sites tools:

1. Create/inspect the site and target preview first.
2. Enable Sign in with Freebuff using `sites_enable_auth`. For local login
   testing, supply the dev server's loopback origin and use only the returned
   development configuration locally. Never invent or reuse a client ID.
3. Provision Sites database storage as `DB` using `sites_add_storage`.
4. Build and deploy with `sites_deploy` and `deploy.json`. Sites injects the
   reserved `FREEBUFF_CLIENT_ID`, `FREEBUFF_ISSUER` and `APP_ORIGIN` bindings.
   No application secret or separate cloud account is needed.

Read `node_modules/@freebuff/auth/AGENTS.md` before changing sign-in. The SDK
wraps requests before API/static fallbacks and forwards refreshed session
cookies. Never derive the canonical origin from a request Host. Private routes
authenticate every request, key records by `sub`, reject foreign-origin
mutations and return private/no-store responses. Missing setup is an error,
never anonymous access to hosted data.

For uploaded files, add Sites' `FILES` storage when needed; this starter has
no file feature and does not provision a bucket. For live collaboration, use
Sites' managed realtime tools instead of adding a separate backend. For SSR
requirements, adapt the same project with Sites' supported Next/OpenNext path
rather than asking the user to select another template.

## Verify before publishing

`bun test` uses a real local D1 database through Miniflare to verify CRUD,
two-user isolation, signed-out refusals, origin checks and validation. Test
identities are injected into the app factory only; the shipped Worker always
uses the SDK. Also test the built Worker in workerd with its assets/bindings.
After provisioning, verify actual Freebuff sign-in, callback, refresh and
sign-out in a browser, plus two real accounts' isolation. Unit identities and
a successful redirect do not prove the hosted login flow works. Publishing
and real-account checks require the owner's authorization and setup.
