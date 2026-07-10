# CI Test Pipeline (Unit/Integration Tiers) + Canonical FOLLOWUPS.md — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the full test suite in GitHub Actions — fast unit tests on every PR plus Supabase-backed integration tests booted via the Supabase CLI (no secrets) — and consolidate all outstanding follow-up work into one canonical `docs/FOLLOWUPS.md`.

**Architecture:** Supabase-dependent test files are renamed to `*.int.test.ts` and vitest is configured with two `projects` (`unit`, `integration`). CI gets two blocking jobs: `Check` (typecheck + unit tests, no Docker) and `Integration` (Supabase CLI boots a local stack, migrations auto-apply, tests run against it). A `skip-integration` PR label skips the integration job; GitHub treats a skipped required check as satisfied.

**Tech Stack:** vitest 4.1.5 (`projects` config), GitHub Actions, `supabase/setup-cli@v1` pinned to CLI 2.90.0, pnpm 9.15.0, Node 20.

**Spec:** `docs/superpowers/specs/2026-07-10-ci-tests-and-followups-design.md`

## Global Constraints

- No changes to production code under `src/`
- No new npm dependencies
- Node pinned to `20.x` (package.json `engines`), pnpm from `packageManager` field (`pnpm@9.15.0`) — never pass a pnpm version to `pnpm/action-setup` (triggers `ERR_PNPM_BAD_PM_VERSION`)
- Supabase CLI pinned to `2.90.0` in CI (matches local)
- Work happens on branch `feat/ci-integration-tests` (already created off `main` at `e1b34ca`)
- Test file convention: Supabase-dependent → `*.int.test.ts`; pure unit → `*.test.ts`
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Canonical FOLLOWUPS.md

**Files:**
- Create: `docs/FOLLOWUPS.md` (content rescued from branch `chore/followups-doc` commit `67f526d`, amended + extended)

**Interfaces:**
- Consumes: nothing
- Produces: `docs/FOLLOWUPS.md` — referenced by later tasks' commit messages; Task 5 deletes the now-redundant `chore/followups-doc` branch

- [ ] **Step 1: Write the file**

Create `docs/FOLLOWUPS.md` with exactly this content (original doc from `chore/followups-doc`, with the Plan 5 branch-protection and actions-bump bullets amended, and a new 2026-07-10 section appended):

```markdown
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
```

- [ ] **Step 2: Verify the rescued content matches the source branch**

Run:
```bash
git show chore/followups-doc:docs/FOLLOWUPS.md | head -45 > /tmp/followups-orig.txt
head -45 docs/FOLLOWUPS.md > /tmp/followups-new.txt
diff /tmp/followups-orig.txt /tmp/followups-new.txt
```
Expected: no output (first 45 lines — everything before the Plan 5 section — are identical).

- [ ] **Step 3: Commit**

```bash
git add docs/FOLLOWUPS.md
git commit -m "docs: canonical FOLLOWUPS.md — rescue from chore/followups-doc + 2026-07-10 assessment items

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Vitest unit/integration project split

**Files:**
- Modify: `vitest.config.ts` (full rewrite, 30 lines)
- Modify: `package.json` (scripts block only)
- Rename: 16 test files (listed in Step 2)

**Interfaces:**
- Consumes: nothing
- Produces: `pnpm test:unit` (no Docker needed), `pnpm test:integration` (needs local Supabase), `pnpm test` (both), `pnpm ci:check` (typecheck + unit). Task 3's CI jobs call `test:unit` and `test:integration`.

- [ ] **Step 1: Verify current baseline — unit-capable files pass without Docker**

Docker must NOT be running for this task's verification to mean anything. Check:
```bash
docker ps 2>&1 | head -2
```
Expected: an error like `Cannot connect to the Docker daemon` / `no such file or directory`. If Docker IS running, run `supabase stop` and quit Docker Desktop first.

- [ ] **Step 2: Rename the 16 Supabase-dependent test files**

```bash
git mv tests/supabase.smoke.test.ts               tests/supabase.smoke.int.test.ts
git mv tests/lib/access.test.ts                   tests/lib/access.int.test.ts
git mv tests/jobs/cleanupOrphanVideos.test.ts     tests/jobs/cleanupOrphanVideos.int.test.ts
git mv tests/scripts/onboardStudio.test.ts        tests/scripts/onboardStudio.int.test.ts
git mv tests/routes/me.studios.test.ts            tests/routes/me.studios.int.test.ts
git mv tests/routes/me.subscription.detail.test.ts tests/routes/me.subscription.detail.int.test.ts
git mv tests/routes/me.subscriptions.test.ts      tests/routes/me.subscriptions.int.test.ts
git mv tests/routes/mux.webhook.test.ts           tests/routes/mux.webhook.int.test.ts
git mv tests/routes/mux.webhook.idempotency.test.ts tests/routes/mux.webhook.idempotency.int.test.ts
git mv tests/routes/stripe.webhook.test.ts        tests/routes/stripe.webhook.int.test.ts
git mv tests/routes/stripe.webhook.idempotency.test.ts tests/routes/stripe.webhook.idempotency.int.test.ts
git mv tests/routes/studios.test.ts               tests/routes/studios.int.test.ts
git mv tests/routes/subscriptions.cancel.test.ts  tests/routes/subscriptions.cancel.int.test.ts
git mv tests/routes/subscriptions.create.test.ts  tests/routes/subscriptions.create.int.test.ts
git mv tests/routes/videos.owner.test.ts          tests/routes/videos.owner.int.test.ts
git mv tests/routes/videos.read.test.ts           tests/routes/videos.read.int.test.ts
```

The 9 files that keep their names (pure unit — mocked or no I/O): `tests/env.test.ts`, `tests/health.test.ts`, `tests/mux.smoke.test.ts`, `tests/stripe.smoke.test.ts`, `tests/fixtures/contract.test.ts`, `tests/lib/stripeStatus.test.ts`, `tests/middleware/auth.test.ts`, `tests/middleware/errorHandler.test.ts`, `tests/routes/subscribe.pages.test.ts`.

- [ ] **Step 3: Rewrite `vitest.config.ts` with two projects**

Replace the entire file with:

```ts
import { defineConfig, configDefaults } from 'vitest/config';

// Shared per-project settings. With `projects`, options like include/
// setupFiles live inside each project, not at the top level.
const shared = {
  environment: 'node' as const,
  globals: false,
  setupFiles: ['tests/setup.ts'],
  testTimeout: 10_000,
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...shared,
          name: 'unit',
          // *.int.test.ts also matches *.test.ts, so exclude it here.
          include: ['tests/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'tests/**/*.int.test.ts'],
        },
      },
      {
        test: {
          ...shared,
          name: 'integration',
          // Requires a running local Supabase (supabase start).
          include: ['tests/**/*.int.test.ts'],
        },
      },
    ],
  },
});
```

- [ ] **Step 4: Update `package.json` scripts**

In the `scripts` block, replace:
```json
"test": "vitest run",
"test:watch": "vitest",
```
with:
```json
"test": "vitest run",
"test:unit": "vitest run --project unit",
"test:integration": "vitest run --project integration",
"test:watch": "vitest",
```
and replace:
```json
"ci:check": "pnpm typecheck && pnpm test",
```
with:
```json
"ci:check": "pnpm typecheck && pnpm test:unit",
```

- [ ] **Step 5: Run unit tests — must pass with Docker stopped**

Run: `pnpm test:unit`
Expected: 9 test files, **0 failed** (roughly 41 passed; a handful may report skipped). If any file fails with `fetch failed`, it depends on Supabase and belongs in the rename list — move it and re-run.

- [ ] **Step 6: Verify the integration project collects exactly the 16 renamed files**

Run: `pnpm vitest list --project integration 2>/dev/null | grep -o 'tests/[^ ]*\.int\.test\.ts' | sort -u | wc -l`
Expected: `16`

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0, no errors (renames keep `.ts` extension so `tsconfig.test.json` still picks them up).

- [ ] **Step 8: Full-suite check with Supabase up (skip only if Docker is unavailable on this machine)**

```bash
open -a Docker && sleep 30   # macOS: start Docker Desktop if not running
supabase start
pnpm test
supabase stop
```
Expected: all 25 files run, 0 failed (~136 passed, ~10 skipped). If Docker cannot be started in this environment, note that in the commit and rely on the CI `Integration` job in Task 4 as the authoritative full-suite verification.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "test: split suite into unit and integration vitest projects

Supabase-dependent files renamed *.int.test.ts. pnpm test:unit now
passes on a plain checkout without Docker; pnpm test is unchanged.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: GitHub Actions workflow — Check + Integration jobs

**Files:**
- Modify: `.github/workflows/ci.yml` (full rewrite)

**Interfaces:**
- Consumes: `pnpm test:unit`, `pnpm test:integration` from Task 2
- Produces: check runs named `Check` and `Integration` (branch-protection contexts used in Task 5); the `skip-integration` label hook used in Task 4

- [ ] **Step 1: Rewrite `.github/workflows/ci.yml`**

Replace the entire file with:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
    # labeled/unlabeled re-trigger the run so the skip-integration label
    # takes effect without needing a new push.
    types: [opened, synchronize, reopened, labeled, unlabeled]

jobs:
  # Merge gate 1: fast, no Docker. Typecheck + unit tests (~1 min).
  check:
    name: Check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # pnpm version is taken from package.json's "packageManager" field;
      # specifying it here too triggers ERR_PNPM_BAD_PM_VERSION.
      - name: Install pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node 20
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Typecheck
        run: pnpm typecheck

      - name: Unit tests
        run: pnpm test:unit

  # Merge gate 2: integration tests against a real local Supabase stack.
  # No repo secrets: the CLI's dev keys are exported at runtime; Stripe and
  # Mux are mocked in tests (placeholders injected by tests/setup.ts).
  #
  # Escape hatch: apply the `skip-integration` label to a PR to skip this
  # job. Branch protection treats a skipped required check as satisfied.
  # Pushes to main always run it.
  integration:
    name: Integration
    runs-on: ubuntu-latest
    timeout-minutes: 15
    if: github.event_name != 'pull_request' || !contains(github.event.pull_request.labels.*.name, 'skip-integration')
    steps:
      - uses: actions/checkout@v4

      - name: Install pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node 20
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Setup Supabase CLI
        uses: supabase/setup-cli@v1
        with:
          version: 2.90.0

      - name: Start local Supabase (applies migrations)
        run: supabase start

      - name: Export Supabase env for tests
        run: |
          eval "$(supabase status -o env)"
          if [ -z "$API_URL" ] || [ -z "$SERVICE_ROLE_KEY" ]; then
            echo "supabase status did not yield API_URL / SERVICE_ROLE_KEY" >&2
            supabase status -o env >&2
            exit 1
          fi
          {
            echo "SUPABASE_URL=$API_URL"
            echo "SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY"
          } >> "$GITHUB_ENV"

      - name: Integration tests
        run: pnpm test:integration
```

- [ ] **Step 2: Sanity-check the YAML parses**

Run: `node -e "const fs=require('fs'); const yaml=fs.readFileSync('.github/workflows/ci.yml','utf8'); console.log(yaml.split('\n').length, 'lines, no tabs:', !yaml.includes('\t'))"`
Expected: prints line count and `no tabs: true`. (Real validation happens when Actions runs it in Task 4.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run unit + Supabase-backed integration tests as merge gates

Check job: typecheck + unit tests. Integration job: supabase start in
the runner (CLI 2.90.0, no secrets), skippable via skip-integration
label. Both intended as required checks on main.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Label, PR, and end-to-end CI verification

**Files:** none (GitHub state + verification only)

**Interfaces:**
- Consumes: the workflow from Task 3; branch `feat/ci-integration-tests`
- Produces: an open PR with both checks green and the label skip verified — evidence for flipping branch protection in Task 5

- [ ] **Step 1: Create the `skip-integration` label (idempotent)**

```bash
gh label create skip-integration --description "Skip the Integration CI job on this PR" --color D93F0B || echo "label already exists"
```
Expected: label created (or already-exists message).

- [ ] **Step 2: Push the branch and open the PR**

```bash
git push -u origin feat/ci-integration-tests
gh pr create --title "ci: two-tier test pipeline (unit + Supabase integration) + canonical FOLLOWUPS.md" --body "$(cat <<'EOF'
## Summary
- Split the vitest suite into `unit` (no Docker) and `integration` (`*.int.test.ts`, needs local Supabase) projects
- CI now runs tests: `Check` job (typecheck + unit) and `Integration` job (boots Supabase via CLI 2.90.0 in the runner, no secrets)
- `skip-integration` PR label skips the Integration job (skipped required checks still satisfy branch protection)
- Rescued `docs/FOLLOWUPS.md` from the stranded `chore/followups-doc` branch and added 2026-07-10 assessment items

Spec: `docs/superpowers/specs/2026-07-10-ci-tests-and-followups-design.md`

## After merge
- Flip branch protection on `main` to require `Check` + `Integration`
- Delete `chore/followups-doc` (content absorbed here)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: PR URL printed.

- [ ] **Step 3: Watch both checks go green**

Run: `gh pr checks --watch`
Expected: `Check` pass (~1 min), `Integration` pass (~4–7 min). If `Integration` fails, read the failing step's log with `gh run view --log-failed` — likely causes: env export step found no `SERVICE_ROLE_KEY` (inspect the step's stderr dump of `supabase status -o env` and adjust the variable names in the workflow), or a test needs Supabase state the migrations don't provide (fix the test classification, not the workflow).

- [ ] **Step 4: Verify the label skip works**

```bash
gh pr edit --add-label skip-integration
gh pr checks --watch
```
Expected: the labeled event triggers a new run where `Integration` shows **skipped** and `Check` passes.

- [ ] **Step 5: Remove the label and confirm Integration runs again**

```bash
gh pr edit --remove-label skip-integration
gh pr checks --watch
```
Expected: new run, both `Check` and `Integration` pass. Leave the PR open for the user to review/merge.

---

### Task 5: Post-merge follow-through (run AFTER the user merges the PR)

**Files:** none (GitHub settings + branch cleanup)

**Interfaces:**
- Consumes: merged PR from Task 4; check contexts `Check` and `Integration`
- Produces: branch protection on `main`; stranded/merged branches deleted

- [ ] **Step 1: Enable branch protection requiring both checks**

```bash
gh api -X PUT repos/AireMaile/inStudiio-Backend/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'EOF'
{
  "required_status_checks": { "strict": false, "contexts": ["Check", "Integration"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
EOF
```
Expected: JSON response echoing the protection config. If the API returns 403 (plan/permission limits on the org), fall back to GitHub UI: Settings → Branches → Add branch ruleset → require status checks `Check` and `Integration` — and tell the user this needs their admin access.

- [ ] **Step 2: Delete the absorbed and merged branches**

```bash
git branch -D chore/followups-doc
git push origin --delete chore/followups-doc
git checkout main && git pull
git branch -d feature/step3 feature/step4 feature/step5-mvp-hardening feature/plan-2-read-endpoints feature/cors-and-frontend-setup-doc feature/plan-6-me-subscriptions-hardening feat/es256-auth-and-frontend-flow-docs feat/ci-integration-tests
```
Expected: local branches deleted; remote `chore/followups-doc` deleted. If `git branch -d` refuses a branch (squash merges hide ancestry), verify its PR shows MERGED via `gh pr list --state merged`, then use `-D`.

- [ ] **Step 3: Confirm protection is live**

Run: `gh api repos/AireMaile/inStudiio-Backend/branches/main/protection --jq '.required_status_checks.contexts'`
Expected: `["Check","Integration"]`
