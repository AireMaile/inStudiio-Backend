# inStudiio Plan 6 — `GET /me/subscriptions` read-endpoint hardening

**Date:** 2026-04-28
**Status:** Design approved, ready for implementation plan
**Branch (target):** `feature/plan-6-me-subscriptions-hardening` off `main`
**Predecessor:** Plan 5 — MVP hardening (merged; see PR #4)
**Future-plan reference:** [[2026-04-25-instudiio-plan-5-mvp-hardening]] §5

---

## 1. Purpose

Plan 5 shipped optimistic local writes on the cancel route, with the
Stripe webhook reconciling the rest of the row. The frontend integration
needs a read endpoint that surfaces this state correctly:

- Post-checkout flow: FE polls until the webhook-inserted row appears
- Cancel flow: FE re-fetches and immediately sees `cancel_at_period_end=true`
- Listing flow: FE renders subscriptions alongside studio info (name, price)

The current `GET /me/subscriptions` is too narrow for these cases:
- Hardcodes `status='active'` — canceled and past_due rows are invisible
- Returns subscription fields only — FE needs a second `/studios/:id`
  call per row to render anything meaningful
- No cache headers — polling could hit a stale browser/proxy cache
- No way to look up a single subscription by id
- No way to scope to one studio (the post-checkout polling case)

This plan widens the contract to make the FE integration straightforward
and locks the response shape so we don't churn it during frontend dev.

---

## 2. Scope

### In scope

1. Widen `GET /me/subscriptions` — return all statuses by default; accept
   `?status=` and `?studio_id=` query params
2. Embed studio summary inline in each subscription row (denormalized response)
3. Add `GET /me/subscriptions/:id` — single subscription lookup, with
   existence-leak unification (404 for both "missing" and "owned by another user")
4. Send `Cache-Control: no-store` on both endpoints
5. Validate query params with zod (consistent with the rest of the codebase)
6. Test coverage: list filtering, single-sub lookup, polling-contract
   integration test that replays a captured `checkout.session.completed`
   webhook end-to-end

### Explicitly out of scope

- Pagination — `unique (user_id, studio_id)` constraint caps row count
  per user well below any pagination threshold
- `updated_at` column on `subscriptions` — would require migrating the
  table and touching all 5 webhook handlers; FE has no demonstrated need
  (status transitions are observable via existing fields)
- ETag / `If-Modified-Since` support — `no-store` is the simpler contract
- Owner-side aggregations (subscriber counts, MRR) — that's Plan 8
- Frontend integration code — that's Plan 7
- Production deploy — that's Plan 9

---

## 3. API surface

### `GET /me/subscriptions`

List the authenticated user's subscriptions.

**Query params** (all optional):

| Param | Type | Notes |
|---|---|---|
| `status` | `'active' \| 'past_due' \| 'canceled' \| 'incomplete'` | Filter to one status |
| `studio_id` | UUID | Filter to one studio (post-checkout polling case) |

Invalid values → `400 invalid_query`.

**Response 200:**

```json
{
  "subscriptions": [
    {
      "id": "<sub uuid>",
      "status": "active",
      "current_period_start": "2026-04-28T12:00:00Z",
      "current_period_end": "2026-05-28T12:00:00Z",
      "cancel_at_period_end": false,
      "studio": {
        "id": "<studio uuid>",
        "name": "Example Studio",
        "slug": "example",
        "description": "...",
        "price_monthly": 9.99
      }
    }
  ]
}
```

**Headers:** `Cache-Control: no-store`
**Auth:** requires bearer JWT; rows scoped to `req.user.id`
**Order:** `current_period_end DESC`

### `GET /me/subscriptions/:id`

Look up a single subscription by its DB UUID.

**Path param:** subscription UUID. Malformed UUIDs → `404 subscription_not_found`
(the existence-leak pattern from `DELETE /subscriptions/:id`).

**Response 200:** `{ "subscription": SubscriptionWithStudio }` (same shape
as a single list element).

**Response 404:** `{ "error": { "code": "subscription_not_found", "message": "Subscription not found." } }`
returned for **both** "id doesn't exist" and "id belongs to another user."
This unification is intentional: it prevents the API from leaking the
existence of subscriptions across user boundaries.

**Headers:** `Cache-Control: no-store`
**Auth:** requires bearer JWT.

### Why `incomplete` is in the status enum

`incomplete` is a real Stripe status. It surfaces when the initial
payment is declined, when SCA / 3D Secure auth is pending, or in manual
approval flows. Stripe auto-cancels `incomplete` subs after 23 hours.

The schema already enforces it
(`check (status in ('active','past_due','canceled','incomplete'))`) and
the webhook handlers already write it. The API must surface it so the FE
can render appropriate UI (e.g., "payment didn't go through, retry?")
instead of silently hiding the row.

For MVP, the FE doesn't need a special UI for `incomplete` — it just
needs to know the subscription isn't `active` for access-control purposes.

---

## 4. Response-shape rationale

```ts
type SubscriptionWithStudio = {
  id: string;
  status: 'active' | 'past_due' | 'canceled' | 'incomplete';
  current_period_start: string;        // ISO timestamp
  current_period_end: string;          // ISO timestamp
  cancel_at_period_end: boolean;
  studio: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    price_monthly: number;
  };
};
```

**Fields omitted** vs. the `subscriptions` table:

| DB field | Why omitted |
|---|---|
| `stripe_subscription_id` | Internal Stripe id; FE has no use for it |
| `stripe_customer_id` | Same reason |
| `user_id` | Implicit (the endpoint is `/me/subscriptions`) |
| `studio_id` | Promoted into the embedded `studio.id` |
| `created_at` | No FE screen needs "subscribed since" yet; cheap to add later |

**Studio fields** mirror the `STUDIO_FIELDS` constant already used by
`GET /me/studios` and `GET /studios/:slug`, keeping a single source of
truth for what "studio summary" means.

---

## 5. Implementation approach

### Single Supabase query with FK join

Both endpoints use one round-trip via PostgREST's embedded select:

```ts
const SUB_FIELDS =
  'id, status, current_period_start, current_period_end, cancel_at_period_end, ' +
  'studio:studios(id, name, slug, description, price_monthly)';

// LIST
let q = supabase
  .from('subscriptions')
  .select(SUB_FIELDS)
  .eq('user_id', req.user.id);
if (parsed.status)    q = q.eq('status', parsed.status);
if (parsed.studio_id) q = q.eq('studio_id', parsed.studio_id);
const { data, error } = await q.order('current_period_end', { ascending: false });
```

PostgREST JSON-builds the embedded `studio` object per row using the
foreign-key relationship between `subscriptions.studio_id` and
`studios.id`. No N+1, no app-level join.

### Query-param validation

```ts
const ListQuery = z.object({
  status: z.enum(['active','past_due','canceled','incomplete']).optional(),
  studio_id: z.string().uuid().optional(),
});
```

Failure → `throw new ApiError(400, 'invalid_query', issue.message)`.

### Single-subscription detail

Reuse the UUID regex pattern already used in `DELETE /subscriptions/:id`
(`src/routes/subscriptions.ts:104`) — no new helpers; consistent
existence-leak unification.

```ts
const id = req.params.id;
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
  throw new ApiError(404, 'subscription_not_found', 'Subscription not found.');
}
const { data, error } = await supabase
  .from('subscriptions')
  .select(SUB_FIELDS)
  .eq('id', id)
  .eq('user_id', req.user.id)   // unifies "missing" and "not yours" → 404
  .maybeSingle();
if (error) throw error;
if (!data)  throw new ApiError(404, 'subscription_not_found', 'Subscription not found.');
res.setHeader('Cache-Control', 'no-store');
res.json({ subscription: data });
```

### Cache headers

`res.setHeader('Cache-Control', 'no-store')` on both endpoints, set
before `res.json()`. No middleware-level approach; explicit per-route
keeps the contract obvious.

### No schema migrations

Existing `subscriptions` table is sufficient. No new columns, no new
indexes (the `subscriptions_user_id_idx` already covers the list query,
and the PK covers the detail query).

---

## 6. Testing

### `tests/routes/me.subscriptions.test.ts` (extend existing)

Existing tests (auth + basic list) keep passing. Add:

- Returns embedded `studio` object with the expected fields
- `?status=canceled` returns canceled rows only; other statuses excluded
- `?status=active&studio_id=<uuid>` composes filters correctly
- `?studio_id=<uuid>` filters to that studio
- `?status=invalid` → `400 invalid_query`
- `?studio_id=not-a-uuid` → `400 invalid_query`
- Response includes `Cache-Control: no-store` header
- Other users' subscriptions not visible (regression guard)

### `tests/routes/me.subscription.detail.test.ts` (new)

- 200 returns single subscription with embedded studio
- 401 when no auth header
- 404 `subscription_not_found` when id is malformed
- 404 `subscription_not_found` when id belongs to another user (existence-leak unified)
- 404 `subscription_not_found` when id doesn't exist at all
- Response includes `Cache-Control: no-store` header

### Polling-contract integration test (in `me.subscriptions.test.ts`)

End-to-end proof that the FE polling flow works against the Plan-5
rewritten webhook handlers:

1. Create test user + studio
2. `GET /me/subscriptions?studio_id=X` → empty list
3. Replay a `checkout.session.completed` event built from the captured
   fixture (uses `tests/fixtures/stripeEvents.ts:checkoutSessionCompleted`)
4. `GET /me/subscriptions?studio_id=X` → 1 row, `status='active'`,
   `studio.id === X`

This locks the contract end-to-end and protects against regressions in
either the read endpoint or the webhook handler.

### No mock changes required

`tests/helpers/stripeMock.ts` already returns the API 2026-03-25.dahlia
shape. Existing test data helpers (`insertTestStudio`,
`insertTestSubscription`, `createTestUser`) cover the seeding needs.

---

## 7. Risk + open questions

### Acknowledged risks

- **`PostgREST embedded select` returns `studio` as `null` if the FK is
  ever orphaned.** Schema enforces FK with `on delete cascade`, so a
  studio can't be deleted while a subscription points at it. Tests will
  assert `studio` is non-null on every row. If this ever fires in
  production, treat as a schema-integrity bug, not an API bug.

- **Status filter accepts only one value.** A FE needing "active OR
  past_due" makes two calls. Acceptable: this is the realistic split
  ("things working" vs "needs attention") and the FE can do it inline.
  Multi-value filtering can be added later without breaking the contract.

### Out-of-band considerations (for Plan 7+)

- Frontend polling cadence and timeout policy are FE concerns. The
  backend guarantees freshness via `no-store` and the FE chooses how
  often to ask. Suggested defaults to capture in Plan 7: poll every 2s,
  give up at 30s with a "still processing — refresh in a moment" fallback.

- If a future screen needs `created_at` ("subscribed since 2026-04-28"),
  add it to the response shape — it's an additive change to the wire
  contract, no version bump needed.

---

## 8. Out-of-band tasks tracked elsewhere

These remain in `docs/FOLLOWUPS.md` and are NOT part of Plan 6:

- CORS production-safety guard test
- `APP_ORIGIN` schema-refine test
- Stale `STRIPE_WEBHOOK_SECRET` comment in `.env.example`
- Branch protection on `main`
- Architecture doc TARGET → AS BUILT flip
- Janitor cron wiring
- Node 24 action upgrades

---

## 9. Definition of done

- [ ] `GET /me/subscriptions` accepts `?status=` and `?studio_id=` and returns embedded studio
- [ ] `GET /me/subscriptions/:id` returns single sub with embedded studio; 404 unifies missing-vs-not-yours
- [ ] Both endpoints set `Cache-Control: no-store`
- [ ] Query param validation via zod; invalid → `400 invalid_query`
- [ ] Existing `me.subscriptions.test.ts` extended; new `me.subscription.detail.test.ts` added; polling-contract integration test added
- [ ] `pnpm typecheck` clean
- [ ] `pnpm vitest run` green on the merge commit (full suite, against local Supabase)
- [ ] PR opened against `main`, CI green, merged
