# Studio Branding Fields — Design

**Date:** 2026-07-11
**Status:** Approved
**Branch:** `feat/studio-branding-fields` (backend); separate PR in `inStudiio-Frontend`
**Source:** `inStudiio-Frontend/BACKEND_STUDIOS_HANDOFF.md` §2

## Problem

The iOS app renders a studio avatar, hero image, and website/Instagram pill
buttons, but the backend never emits those fields, so every studio shows the
gray-placeholder fallback. The handoff asks for four nullable columns on
`studios`, emitted wherever a studio object appears in JSON.

Additionally, a cross-repo contract bug was found during design: the iOS
`JSONDecoder` uses `.convertFromSnakeCase`, which maps `image_url` →
`imageUrl`, but `Studio.swift`'s CodingKeys expect `imageURL` (capital URL).
Three of the four fields would silently decode as `nil` even after the
backend ships. (`website` has no underscore/acronym and works.)

## Decisions (user-approved)

1. **Storage:** four nullable `text` columns directly on `public.studios`
   (no separate table, no jsonb).
2. **Prod migration:** applied via the Supabase MCP after the backend PR
   merges, with explicit user go-ahead at that moment.
3. **Seed values:** stable stock placeholders for the `test` studio (picsum
   seeded URLs + instudiio.com + instagram.com/instudiio).
4. **Frontend fix:** patch `Studio.swift` CodingKeys in a separate PR on
   `inStudiio-Frontend` for Chris to review and smoke-test.

## Section 1 — Backend

**Migration** `supabase/migrations/0008_studio_branding.sql`:

```sql
alter table public.studios
  add column image_url            text,
  add column background_image_url text,
  add column website              text,
  add column instagram_url        text;
```

All nullable; no backfill; no RLS changes (existing row-level policies on
`studios` cover new columns). No CHECK constraints or URL validation — there
is no write API for these fields yet (SQL-only, per handoff; an upload
feature is explicitly out of scope).

**Types:** regenerate `src/types/db.ts` against local Supabase
(`supabase db reset`, then `pnpm gen:types`).

**Routes** — the four field names are appended to the studio selects:

- `src/routes/me.ts:7` — `STUDIO_FIELDS` constant. This automatically covers
  `GET /me/studios`, `GET /me/subscriptions` (nested `studio` object), and
  `GET /me/subscriptions/:id`.
- `src/routes/studios.ts:44` — the `GET /studios` list select.

Response contract addition (all four keys always present, value or `null`):

```json
{
  "image_url": "https://… | null",
  "background_image_url": "https://… | null",
  "website": "https://… | null",
  "instagram_url": "https://… | null"
}
```

**Tests:** extend existing integration tests rather than new files —
`tests/routes/studios.int.test.ts` and
`tests/routes/me.subscriptions.int.test.ts` assert (a) the four keys are
present and `null` for a studio seeded without branding, and (b) values
round-trip for a studio seeded with branding (extend
`tests/helpers/testData.ts` so seeding can set the new columns). Runs
through the CI pipeline (Check + Integration) on the PR.

**Docs:** update the studio object examples in `docs/flows/README.md` /
`docs/FRONTEND_WORKFLOW.md` where the `/studios` response shape is shown
(grep for `price_monthly` in docs to find them), and the Postman collection
only if it asserts response shapes (it does not — skip).

## Section 2 — Prod rollout (post-merge)

1. Apply migration 0008 to the production Supabase project via the MCP
   (`apply_migration`), after user go-ahead.
2. Seed the Test Studio:

```sql
update public.studios
   set image_url            = 'https://picsum.photos/seed/instudiio-avatar/400/400',
       background_image_url = 'https://picsum.photos/seed/instudiio-hero/1200/800',
       website              = 'https://instudiio.com',
       instagram_url        = 'https://instagram.com/instudiio'
 where slug = 'test';
```

3. Verify live: `curl https://in-studiio-backend.vercel.app/studios` shows
   the four keys, with values on the `test` studio and `null` on others.

## Section 3 — Frontend fix (inStudiio-Frontend, separate PR)

In `inStudiio/Models/Studio.swift`, give the acronym CodingKeys explicit raw
values matching what `.convertFromSnakeCase` produces:

```swift
enum CodingKeys: String, CodingKey {
    case id, name, slug, description, priceMonthly, createdAt
    case website
    case instagramURL = "instagramUrl"
    case imageURL = "imageUrl"
    case backgroundImageURL = "backgroundImageUrl"
}
```

Branch + PR on `AireMaile/inStudiio-Frontend` explaining the decoder
mismatch. Constraint: the iOS app cannot be built/verified in this
environment — the PR description must flag that Chris should smoke-test
(decode a `/studios` response and confirm images/pills render).

## Out of scope

- Upload endpoint / storage for studio-owner-managed images
- `GET /studios/:slug` detail endpoint
- Backlog items from the handoff (`DELETE /me`, profile update, home feed)
- Root-causing the since-resolved `/studios` 500 (does not reproduce)

## Verification

1. `pnpm test` green locally with Supabase up (new assertions included)
2. CI green on the backend PR (Check + Integration)
3. After merge + MCP migration + seed: live curl shows branding fields
4. Frontend PR opened with the CodingKeys fix and smoke-test note for Chris
