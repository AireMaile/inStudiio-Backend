# Followups

Tracked-but-not-blocking items captured during reviews. Pick up when convenient.

## From PR #5 review (CORS + frontend setup doc, 2026-04-28)

### CORS

- **`credentials: true` is overbroad for a Bearer-token auth model.**
  `src/index.ts` enables `credentials: true` on the cors middleware, but
  our auth is `Authorization: Bearer <jwt>`. The `credentials` flag is
  for cookies / HTTP auth — it has no effect on bearer headers. Browsers
  won't send the bearer header without explicit `fetch(..., { credentials: 'include' })`
  from the frontend, so the practical surface is small. **Decision: keep
  for now** in case we add cookie-based SSR flows later; flip to `false`
  if we commit to bearer-only.
- **CORS exposedHeaders not configured.** Not an issue today (frontend
  reads no custom response headers). If we add `X-Request-Id`,
  `RateLimit-Remaining`, or similar headers the frontend needs to read,
  list them via `exposedHeaders`.

### Tests

- **No tests for the CORS middleware production-safety guard.** The
  `throw new Error('CORS_ORIGINS is required when NODE_ENV=production')`
  in `src/index.ts` has no test asserting it fires. Add `tests/cors.test.ts`:
  - `NODE_ENV=production` + no `CORS_ORIGINS` → `createApp()` throws
  - `NODE_ENV=production` + `CORS_ORIGINS=https://app.example.com` →
    preflight from that origin returns 204 with the correct
    `Access-Control-Allow-Origin` header; preflight from a different
    origin gets no ACAO header
  - `NODE_ENV=development` → preflight from any origin is allowed
- **Same gap on `APP_ORIGIN` schema refine.** The
  `APP_ORIGIN is required when NODE_ENV=production` zod refine in
  `src/env.ts` has no test. Same shape of fix.

### Docs

- **Stale comment in `.env.example`** for `STRIPE_WEBHOOK_SECRET`. Says
  "used in Plan 3, leave blank for now." Plan 3 shipped and Plan 5
  hardened it. Tighten to:
  `# Set after running 'stripe listen' (see docs/FRONTEND_LOCAL_SETUP.md §6).`

## From Plan 5 final close-out

- Configure branch protection on `main` requiring BOTH CI jobs
  (`Check` and `Integration`) — see the 2026-07-10 CI spec. Settings →
  Branches in GitHub UI, or `gh api` (see plan Task 5).
- Flip the architecture doc TARGET → AS BUILT
  (`ClaudeBrain/Plans/2026-04-26-instudiio-current-architecture.md`)
- Wire the orphan-video janitor to a cron
  (`pnpm tsx scripts/run-cleanup-orphans.ts` hourly)
- **OVERDUE:** Bump `actions/checkout` + `pnpm/action-setup` +
  `actions/setup-node` to current majors (the June 2026 Node 24
  deprecation deadline has passed)

## From repo assessment (2026-07-10)

- **Done 2026-07-10:** run tests in CI. Two-tier split (unit vs
  Supabase-backed integration) — see
  `docs/superpowers/specs/2026-07-10-ci-tests-and-followups-design.md`.
- Modernize `vercel.json` off the legacy `builds`/`routes` v2 format
  (prefer `rewrites` + framework detection).
- Investigate the 10 tests reported as "skipped" in full-suite runs —
  identify which files/cases and why they skip.
- Local/remote branch hygiene: delete merged feature branches
  (`feature/step3`, `feature/step4`, `feature/step5-mvp-hardening`,
  `feature/plan-2-read-endpoints`, `feature/cors-and-frontend-setup-doc`,
  `feature/plan-6-me-subscriptions-hardening`,
  `feat/es256-auth-and-frontend-flow-docs`).
