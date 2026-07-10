# CI Test Pipeline + Canonical Followups Doc — Design

**Date:** 2026-07-10
**Status:** Approved
**Branch:** `feat/ci-integration-tests`

## Problem

The test suite (146 tests, 25 files) never runs in CI. The GitHub Actions
workflow only typechecks, because the tests were assumed to need repo
secrets. In fact, Stripe and Mux are fully mocked/DI'd in every route test —
the only real dependency is a local Supabase stack, which the Supabase CLI
can boot inside a GitHub Actions runner with no secrets. On a plain checkout
without Docker, 95 tests fail with "fetch failed", so the suite is currently
decorative both locally and in CI.

Separately, tracked follow-up work lives in `docs/FOLLOWUPS.md` on the
unmerged `chore/followups-doc` branch, where it is effectively invisible,
and a 2026-07-10 repo assessment produced new items with nowhere to live.

## Decisions (user-approved)

1. **Two-tier test split** — rename Supabase-dependent tests to
   `*.int.test.ts`; vitest `projects` split them from unit tests.
2. **Both CI jobs are blocking from day one** — required checks via branch
   protection (manual GitHub Settings step after first green run).
3. **Escape hatch** — a `skip-integration` PR label skips the integration
   job. GitHub treats a skipped required check as satisfied, so the PR can
   still merge. Pushes to `main` always run the full suite.
4. **One canonical `docs/FOLLOWUPS.md`** — rescue the doc from
   `chore/followups-doc`, extend it with the assessment items, delete that
   branch after merge.

## Section 1 — Test suite split

**Convention:** a test file that requires the local Supabase stack (creates
test users via `tests/helpers/testUsers.ts`, seeds rows via
`tests/helpers/testData.ts`, or queries the DB directly) is named
`*.int.test.ts`. Everything else stays `*.test.ts`.

**Files renamed (16):**

- `tests/supabase.smoke.test.ts`
- `tests/lib/access.test.ts`
- `tests/jobs/cleanupOrphanVideos.test.ts`
- `tests/scripts/onboardStudio.test.ts`
- `tests/routes/` — all except `subscribe.pages.test.ts`:
  `me.studios`, `me.subscription.detail`, `me.subscriptions`,
  `mux.webhook`, `mux.webhook.idempotency`, `stripe.webhook`,
  `stripe.webhook.idempotency`, `studios`, `subscriptions.cancel`,
  `subscriptions.create`, `videos.owner`, `videos.read`

**Files unchanged (9 unit files):** `env`, `health`, `mux.smoke`,
`stripe.smoke`, `fixtures/contract`, `lib/stripeStatus`, `middleware/auth`,
`middleware/errorHandler`, `routes/subscribe.pages`.

**vitest.config.ts:** two projects sharing the existing
`tests/setup.ts` setup file and node environment:

- `unit`: include `tests/**/*.test.ts`, exclude `tests/**/*.int.test.ts`
- `integration`: include `tests/**/*.int.test.ts`

**package.json scripts:**

- `test:unit` → `vitest run --project unit`
- `test:integration` → `vitest run --project integration`
- `test` → `vitest run` (both projects; unchanged local behavior)
- `ci:check` → `pnpm typecheck && pnpm test:unit` (the no-Docker tier)

**Success criterion:** `pnpm test:unit` passes on a machine with no Docker
running; `pnpm test` still runs all 146 tests when Supabase is up.

## Section 2 — GitHub Actions workflow

Rework `.github/workflows/ci.yml` into two jobs, triggered on
`pull_request` and `push` to `main`:

**Job `check`** (~1 min) — replaces the current typecheck-only job:
pnpm/node setup (existing pattern) → `pnpm install --frozen-lockfile` →
`pnpm typecheck` → `pnpm test:unit`.

**Job `integration`** (~5 min, `timeout-minutes: 15`):

1. pnpm/node setup + install (same as `check`)
2. `supabase/setup-cli@v1` (pin a CLI version for determinism)
3. `supabase start` — boots the local stack and applies the 7 migrations
   to a fresh Postgres
4. Export `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from
   `supabase status -o env` into `$GITHUB_ENV` (mapping `API_URL` →
   `SUPABASE_URL`, `SERVICE_ROLE_KEY` → `SUPABASE_SERVICE_ROLE_KEY`)
5. `pnpm test:integration`

No repo secrets: the Supabase dev keys come from the CLI at runtime;
Stripe/Mux values are the placeholders `tests/setup.ts` already injects
(`sk_test_placeholder` etc. — no external API is called).

**Skip mechanism:** the `integration` job carries

```yaml
if: github.event_name != 'pull_request' ||
    !contains(github.event.pull_request.labels.*.name, 'skip-integration')
```

Applying the `skip-integration` label to a PR skips the job; branch
protection counts the skipped check as satisfied. Pushes to `main` are
unaffected by the label. The label must be created once in the GitHub UI
(or via `gh label create skip-integration`).

**Manual follow-through (owner):** after the first green run on a PR, set
branch protection on `main` to require both `check` and `integration`.

**Error handling:** if `supabase start` proves flaky in CI, add a single
retry step; do not build retry logic preemptively. The 15-minute job
timeout prevents hung runs from blocking merges indefinitely.

## Section 3 — Canonical FOLLOWUPS.md

Copy `docs/FOLLOWUPS.md` from `chore/followups-doc` (commit `67f526d`) onto
this branch, preserving its existing sections (PR #5 review notes, Plan 5
close-out). Append a new section **"From repo assessment (2026-07-10)"**:

- Wire the orphan-video janitor (`src/jobs/cleanupOrphanVideos.ts`) to a
  schedule — Vercel cron behind an authenticated endpoint, or a GitHub
  Actions `schedule` workflow
- Modernize `vercel.json` off the legacy `builds`/`routes` v2 format
- Bump `actions/checkout` / `actions/setup-node` / `pnpm/action-setup`
  (Node 24 deprecation deadline of June 2026 has passed)
- Enable branch protection on `main` requiring both CI jobs (upgrades the
  existing typecheck-only item)
- Investigate the 10 tests reported as skipped in full-suite runs —
  identify which and why
- Revisit `credentials: true` in CORS config once cookie/SSR question is
  settled (carried from PR #5 notes; keep-for-now decision stands)

Items completed by this work (CI test execution, test tiering) are recorded
as done with a pointer to this spec. After this branch merges, delete
`chore/followups-doc` (local + remote).

## Out of scope

- Actually wiring the janitor cron, vercel.json modernization, actions
  version bumps — recorded in FOLLOWUPS.md, not implemented here
- Any changes to production code under `src/`
- Fixing or unskipping the 10 skipped tests

## Verification

1. `pnpm test:unit` green locally with Docker stopped
2. `pnpm typecheck` green
3. Full `pnpm test` green locally with `supabase start` running
4. Push branch, open PR: `check` and `integration` jobs both green in
   Actions
5. Apply `skip-integration` label to a test PR and confirm the integration
   job skips
