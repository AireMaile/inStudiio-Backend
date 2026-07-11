# Studio Branding Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four nullable branding columns to `studios`, emit them in every studio JSON response, roll out to prod with a seeded Test Studio, and fix the iOS CodingKeys mismatch so the app actually decodes them.

**Architecture:** One migration adds the columns; the two route-level field lists (`STUDIO_FIELDS` in me.ts, the select in studios.ts) are extended; existing contract-lock tests are updated and a round-trip test added. Prod rollout is a post-merge MCP migration + seed. The frontend fix is a separate three-line PR in `inStudiio-Frontend`.

**Tech Stack:** Supabase migrations + supabase-js, Express 5, vitest (unit/integration projects), GitHub Actions (Check + Integration required checks), Swift Codable (frontend PR only).

**Spec:** `docs/superpowers/specs/2026-07-11-studio-branding-fields-design.md`

## Global Constraints

- Backend work on branch `feat/studio-branding-fields` (exists, off `main`); frontend work on a new branch in `/Users/christianvillegas/BusinessCode/inStudiio-Frontend`
- The four columns/JSON keys are exactly: `image_url`, `background_image_url`, `website`, `instagram_url` — all nullable `text`, snake_case in JSON
- No new npm dependencies; no `src/` changes beyond the two route field lists and the regenerated `src/types/db.ts`
- `main` has branch protection requiring the `Check` and `Integration` CI jobs — the PR cannot merge red
- If `git push` stalls >30s, kill it and rerun as `git -c credential.helper= -c credential.helper='!gh auth git-credential' push …` (known macOS keychain hang on this machine)
- Task 4 touches the PRODUCTION database — it runs only after the PR is merged AND the user gives explicit go-ahead in the conversation
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Migration 0008 + regenerated DB types

**Files:**
- Create: `supabase/migrations/0008_studio_branding.sql`
- Modify: `src/types/db.ts` (regenerated, not hand-edited)

**Interfaces:**
- Consumes: nothing
- Produces: `studios` table columns `image_url`, `background_image_url`, `website`, `instagram_url` (all `text | null` in `Database['public']['Tables']['studios']['Row']`); local Supabase left RUNNING for Task 2

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0008_studio_branding.sql`:

```sql
-- Studio branding for the iOS app (avatar, hero image, website/Instagram
-- pills). All nullable: there is no write API yet (values are set via SQL),
-- and the app hides the corresponding UI when a field is null.
alter table public.studios
  add column image_url            text,
  add column background_image_url text,
  add column website              text,
  add column instagram_url        text;
```

- [ ] **Step 2: Start local Supabase and apply all migrations**

```bash
docker ps >/dev/null 2>&1 || (open -a Docker && sleep 30)
supabase start
supabase db reset
```
Expected: reset output ends listing `Applying migration 0008_studio_branding.sql` with no errors. (If `supabase start` says it is already running, just run `supabase db reset`.)

- [ ] **Step 3: Regenerate the DB types**

Run: `pnpm gen:types`
Then: `grep -c "background_image_url" src/types/db.ts`
Expected: `3` (one each in the studios Row/Insert/Update blocks).

- [ ] **Step 4: Verify nothing broke**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck exit 0; all 25 test files pass (146 tests, ~10 may report skipped) — nothing consumes the new columns yet. Leave Supabase running for Task 2.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0008_studio_branding.sql src/types/db.ts
git commit -m "feat(db): add studio branding columns (image_url, background_image_url, website, instagram_url)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Emit branding fields in routes (TDD)

**Files:**
- Modify: `src/routes/me.ts:7` (`STUDIO_FIELDS` constant)
- Modify: `src/routes/studios.ts:44` (list select)
- Modify: `tests/helpers/testData.ts` (`insertTestStudio` options)
- Test: `tests/routes/studios.int.test.ts`, `tests/routes/me.studios.int.test.ts`, `tests/routes/me.subscriptions.int.test.ts`

**Interfaces:**
- Consumes: Task 1's columns and regenerated types (local Supabase must be running: `supabase start`)
- Produces: every studio object in `/studios`, `/me/studios`, `/me/subscriptions`, `/me/subscriptions/:id` carries the four keys (value or null); `insertTestStudio` accepts optional `imageUrl`, `backgroundImageUrl`, `website`, `instagramUrl` strings

- [ ] **Step 1: Extend the test-data helper**

In `tests/helpers/testData.ts`, replace the `insertTestStudio` function with:

```ts
export async function insertTestStudio(opts: {
  ownerUserId: string;
  slug: string;
  name?: string;
  priceMonthly?: number;
  imageUrl?: string;
  backgroundImageUrl?: string;
  website?: string;
  instagramUrl?: string;
}): Promise<TestStudio> {
  const { data, error } = await supabase
    .from('studios')
    .insert({
      owner_user_id: opts.ownerUserId,
      slug: opts.slug,
      name: opts.name ?? `Test Studio ${opts.slug}`,
      description: 'Test description',
      price_monthly: opts.priceMonthly ?? 9.99,
      stripe_product_id: `prod_test_${opts.slug}`,
      stripe_price_id: `price_test_${opts.slug}`,
      image_url: opts.imageUrl ?? null,
      background_image_url: opts.backgroundImageUrl ?? null,
      website: opts.website ?? null,
      instagram_url: opts.instagramUrl ?? null,
    })
    .select('id, slug')
    .single();
  if (error || !data) throw error ?? new Error('insert returned no row');
  return { id: data.id, slug: data.slug };
}
```

- [ ] **Step 2: Update the three contract-lock key lists and add the round-trip test**

The shared studio key list appears in three files. In each, replace the array

```ts
['created_at', 'description', 'id', 'name', 'price_monthly', 'slug']
```

with

```ts
[
  'background_image_url',
  'created_at',
  'description',
  'id',
  'image_url',
  'instagram_url',
  'name',
  'price_monthly',
  'slug',
  'website',
]
```

at these locations:
- `tests/routes/studios.int.test.ts` — the `whitelists fields and excludes internal plumbing` test
- `tests/routes/me.studios.int.test.ts:45-47`
- `tests/routes/me.subscriptions.int.test.ts:78-80` (the `Object.keys(sub.studio)` assertion)

Then, in `tests/routes/studios.int.test.ts`, add a third seeded studio in the existing `beforeAll` (after the `beta` insert):

```ts
await insertTestStudio({
  ownerUserId: ownerId,
  slug: `${SLUG_PREFIX}branded`,
  name: 'Branded',
  imageUrl: 'https://example.com/avatar.jpg',
  backgroundImageUrl: 'https://example.com/hero.jpg',
  website: 'https://example.com',
  instagramUrl: 'https://instagram.com/example',
});
```

and add this test after `whitelists fields and excludes internal plumbing`:

```ts
it('passes branding values through and emits null when unset', async () => {
  const res = await request(app).get('/studios?limit=100');
  expect(res.status).toBe(200);
  const branded = res.body.studios.find((s: any) => s.slug === `${SLUG_PREFIX}branded`);
  const plain = res.body.studios.find((s: any) => s.slug === `${SLUG_PREFIX}alpha`);
  expect(branded).toMatchObject({
    image_url: 'https://example.com/avatar.jpg',
    background_image_url: 'https://example.com/hero.jpg',
    website: 'https://example.com',
    instagram_url: 'https://instagram.com/example',
  });
  expect(plain.image_url).toBeNull();
  expect(plain.background_image_url).toBeNull();
  expect(plain.website).toBeNull();
  expect(plain.instagram_url).toBeNull();
});
```

- [ ] **Step 3: Run the three test files to verify they fail**

Run: `pnpm vitest run --project integration tests/routes/studios.int.test.ts tests/routes/me.studios.int.test.ts tests/routes/me.subscriptions.int.test.ts`
Expected: FAIL — key-list assertions report the four new keys missing from responses (routes don't select them yet).

- [ ] **Step 4: Extend the route field lists**

In `src/routes/me.ts`, replace line 7 with:

```ts
const STUDIO_FIELDS =
  'id, name, slug, description, price_monthly, created_at, image_url, background_image_url, website, instagram_url' as const;
```

In `src/routes/studios.ts`, replace the `.select(...)` line inside `listStudios` with:

```ts
      .select(
        'id, name, slug, description, price_monthly, created_at, image_url, background_image_url, website, instagram_url',
        { count: 'exact' },
      )
```

- [ ] **Step 5: Run the three test files to verify they pass**

Run: `pnpm vitest run --project integration tests/routes/studios.int.test.ts tests/routes/me.studios.int.test.ts tests/routes/me.subscriptions.int.test.ts`
Expected: PASS, 0 failed.

- [ ] **Step 6: Full check**

Run: `pnpm typecheck && pnpm test`
Expected: exit 0; all files pass, 0 failed.

- [ ] **Step 7: Commit**

```bash
git add src/routes/me.ts src/routes/studios.ts tests/helpers/testData.ts tests/routes/studios.int.test.ts tests/routes/me.studios.int.test.ts tests/routes/me.subscriptions.int.test.ts
git commit -m "feat(api): emit studio branding fields in /studios and /me responses

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Docs + PR + CI green

**Files:**
- Modify: `docs/FRONTEND_WORKFLOW.md:190-202` and `docs/FRONTEND_WORKFLOW.md:314-322` (JSON examples)

**Interfaces:**
- Consumes: Tasks 1–2 committed on `feat/studio-branding-fields`
- Produces: merged-ready PR with `Check` and `Integration` green (branch protection requires both)

- [ ] **Step 1: Update the two JSON examples**

In `docs/FRONTEND_WORKFLOW.md`, the `GET /studios` example (~line 190) becomes:

```json
{
  "studios": [
    {
      "id": "c4b33530-473b-40f4-9efd-eb9297a60b47",
      "name": "Test Studio",
      "slug": "test",
      "description": null,
      "price_monthly": 9.99,
      "created_at": "2026-05-29T22:24:33.035239+00:00",
      "image_url": "https://picsum.photos/seed/instudiio-avatar/400/400",
      "background_image_url": "https://picsum.photos/seed/instudiio-hero/1200/800",
      "website": "https://instudiio.com",
      "instagram_url": "https://instagram.com/instudiio"
    }
  ],
  "pagination": { "limit": 20, "offset": 0, "total": 1 }
}
```

and the nested `studio` object in the `/me/subscriptions` example (~line 317) becomes:

```json
      "studio": {
        "id": "c4b33530-473b-40f4-9efd-eb9297a60b47",
        "name": "Test Studio", "slug": "test", "description": null,
        "price_monthly": 9.99, "created_at": "2026-05-29T22:24:33.035239+00:00",
        "image_url": null, "background_image_url": null,
        "website": null, "instagram_url": null
      }
```

(The second example deliberately shows nulls so both shapes are documented.)

- [ ] **Step 2: Commit and push**

```bash
git add docs/FRONTEND_WORKFLOW.md
git commit -m "docs: add branding fields to studio response examples

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push -u origin feat/studio-branding-fields
```
(If the push stalls >30s: kill it and rerun with `git -c credential.helper= -c credential.helper='!gh auth git-credential' push -u origin feat/studio-branding-fields`.)

- [ ] **Step 3: Open the PR**

```bash
gh pr create --title "feat: studio branding fields (image_url, background_image_url, website, instagram_url)" --body "$(cat <<'EOF'
## Summary
- Migration 0008: four nullable text columns on `studios`
- Emitted in `GET /studios`, `GET /me/studios`, `GET /me/subscriptions`, `GET /me/subscriptions/:id` (snake_case, value or null)
- Contract-lock tests updated + branding round-trip test added
- Response examples in FRONTEND_WORKFLOW.md updated

Per `inStudiio-Frontend/BACKEND_STUDIOS_HANDOFF.md` §2. Spec: `docs/superpowers/specs/2026-07-11-studio-branding-fields-design.md`

## After merge
- Apply migration 0008 to prod via Supabase MCP + seed the `test` studio (plan Task 4)
- Companion iOS PR fixes the `CodingKeys` snake-case mismatch (`imageURL` vs decoded `imageUrl`)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Watch checks**

Run: `gh pr checks --watch --interval 30` (tool timeout 600000; if the call times out mid-run, call it again — a tool timeout is not a CI failure)
Expected: `Check` pass and `Integration` pass. If `Integration` fails, capture `gh run view <id> --log-failed` and stop for diagnosis — do not iterate blind.

---

### Task 4: Prod rollout (AFTER merge — STOP for explicit user go-ahead before every prod mutation)

**Files:** none (production Supabase + live verification)

**Interfaces:**
- Consumes: merged PR from Task 3; Supabase MCP tools (`mcp__supabase__apply_migration`, `mcp__supabase__execute_sql` — load via ToolSearch if deferred); prod project ref `iijhljehoqceownoeauu`
- Produces: live branding fields on https://in-studiio-backend.vercel.app/studios

- [ ] **Step 1: Confirm the MCP targets the right project**

Call `mcp__supabase__get_project_url`. Expected: URL containing `iijhljehoqceownoeauu` (matches `inStudiio-Frontend/inStudiio/App/SupabaseConfig.swift`). If it differs, STOP and ask the user.

- [ ] **Step 2: Apply the migration (user go-ahead required)**

Call `mcp__supabase__apply_migration` with `name: "studio_branding"` and `query` set to exactly the SQL from Task 1 Step 1. Expected: success, no error.

- [ ] **Step 3: Seed the Test Studio**

Call `mcp__supabase__execute_sql` with:

```sql
update public.studios
   set image_url            = 'https://picsum.photos/seed/instudiio-avatar/400/400',
       background_image_url = 'https://picsum.photos/seed/instudiio-hero/1200/800',
       website              = 'https://instudiio.com',
       instagram_url        = 'https://instagram.com/instudiio'
 where slug = 'test'
 returning slug, image_url;
```
Expected: one row returned (`slug = 'test'`).

- [ ] **Step 4: Verify live**

```bash
curl -s "https://in-studiio-backend.vercel.app/studios" | head -c 1200
```
Expected: the `test` studio object contains the four seeded values; the other studio shows the four keys as `null`. If the keys are absent entirely, the Vercel deploy of the merge may still be building — wait and retry once. Also verify the picsum URLs resolve: `curl -s -o /dev/null -w '%{http_code}' "https://picsum.photos/seed/instudiio-avatar/400/400"` → expected `200` (after redirects it may be `302`; treat 2xx/3xx as fine).

---

### Task 5: Frontend CodingKeys fix (separate repo, independent of Tasks 3–4)

**Files:**
- Modify: `/Users/christianvillegas/BusinessCode/inStudiio-Frontend/inStudiio/Models/Studio.swift:23-26`

**Interfaces:**
- Consumes: nothing from other tasks (decode fix is correct regardless of backend state)
- Produces: PR on `AireMaile/inStudiio-Frontend` for Chris to review; iOS app CANNOT be built in this environment — the PR must say Chris smoke-tests

- [ ] **Step 1: Branch**

```bash
cd /Users/christianvillegas/BusinessCode/inStudiio-Frontend
git checkout -b fix/studio-branding-codingkeys
```

- [ ] **Step 2: Fix the CodingKeys**

In `inStudiio/Models/Studio.swift`, replace:

```swift
    enum CodingKeys: String, CodingKey {
        case id, name, slug, description, priceMonthly, createdAt
        case website, instagramURL, imageURL, backgroundImageURL
    }
```

with:

```swift
    enum CodingKeys: String, CodingKey {
        case id, name, slug, description, priceMonthly, createdAt
        case website
        // .convertFromSnakeCase turns image_url into imageUrl (not imageURL),
        // so acronym-cased keys need explicit raw values to match.
        case instagramURL = "instagramUrl"
        case imageURL = "imageUrl"
        case backgroundImageURL = "backgroundImageUrl"
    }
```

- [ ] **Step 3: Sanity-check no other decoder expects the old behavior**

Run: `grep -rn "imageURL\|instagramURL\|backgroundImageURL" inStudiio --include="*.swift" | grep -v "Models/Studio.swift"`
Expected: only *usages* of the Swift properties (views/services reading `studio.imageURL` etc.) — no other Codable definitions of these keys. Usages are unaffected (property names don't change).

- [ ] **Step 4: Commit, push, PR**

```bash
git add inStudiio/Models/Studio.swift
git commit -m "fix: CodingKeys raw values for snake_case-decoded branding fields

.convertFromSnakeCase maps image_url -> imageUrl, which does not match
CodingKeys named imageURL/instagramURL/backgroundImageURL, so those
fields silently decoded as nil. Explicit raw values fix the match.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push -u origin fix/studio-branding-codingkeys
gh pr create --title "fix: studio branding fields decode as nil (CodingKeys vs convertFromSnakeCase)" --body "$(cat <<'EOF'
## Summary
The shared JSONDecoder uses `.convertFromSnakeCase`, which maps `image_url` -> `imageUrl`. The `Studio` CodingKeys are named `imageURL` / `instagramURL` / `backgroundImageURL`, so those three fields always decoded as `nil` (only `website` worked). This gives the acronym-cased keys explicit raw values matching the converted form.

Backend counterpart (adds the fields to the API): AireMaile/inStudiio-Backend PR "feat: studio branding fields".

## Smoke test (please verify — this PR was written without building the app)
1. Run the app against prod after the backend migration+seed lands
2. Search tab -> Test Studio should show the picsum avatar; studio page shows hero image + Website/Instagram pills

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
(Same keychain-hang fallback applies if the push stalls.)
