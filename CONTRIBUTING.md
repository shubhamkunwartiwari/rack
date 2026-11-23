# Contributing to Rack

## Setup

```sh
bun install
bun run dev
```

The dev server runs the app and its Worker on a local D1 database; there is no external service to
configure. On `127.0.0.1` with no auth variables set, a single `local-preview` identity is used.
Do not add credentials to the repo to work around that.

## Before opening a pull request

Run every check and make sure each exits 0:

```sh
bun run typecheck
bun test
bun run build
bun run test:e2e   # needs `bun run dev` running and Chrome installed
```

If you change behaviour that the browser suite covers, extend the suite in
`tests/e2e/browser.mjs` rather than weakening an assertion. Tests should drive the app the way a
person does — real clicks, keys and wheel events over the DevTools Protocol.

## Code layout

- `src/shared/estimate.ts` is the single source of truth for parameters, memory, GPU-hours and
  cycle rules. Both the client and the Worker import it; keep them in agreement by changing it there.
- `src/worker/*` is the API and storage layer. Every project route must stay owner-scoped by the
  authenticated `sub`, and mutations must remain same-origin checked.
- `src/client/style.css` holds the design system. Use the existing tokens and the per-entity accents
  as 1 px borders, dots or 2 px rails — not as fills. Keep numbers in monospace with `tabular-nums`.
- Schema changes go through `src/worker/db.ts`; migrations must be idempotent and upgrade existing
  databases in place.

## Style

- TypeScript everywhere, no `any` in new code, no new runtime dependency without a reason in the PR.
- Match the surrounding formatting; `tsc` is the only enforced linter.
- Commit messages should say why the change was made, not only what changed.

## Reporting bugs

Include the browser and OS, the view you were in, the smallest set of steps that reproduces the
problem, and whether it still happens after a reload (that last detail separates a save bug from a
rendering one).
