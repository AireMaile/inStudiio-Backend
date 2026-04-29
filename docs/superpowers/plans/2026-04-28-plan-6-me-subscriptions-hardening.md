# Plan 6 — `GET /me/subscriptions` Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Widen `GET /me/subscriptions` (all statuses, embedded studio, query filters), add `GET /me/subscriptions/:id`, add `mapStripeStatus()` Stripe-status normalization to prevent DB CHECK violations, and lock the response contract with tests.

**Architecture:** `mapStripeStatus()` lives in `src/lib/stripeStatus.ts` and is imported wherever the webhook handlers write a raw Stripe status to the DB. The `GET /me/subscriptions` route in `src/routes/me.ts` is rewritten to embed studio via a PostgREST FK join, accept `?status=`/`?studio_id=` query params validated by zod, and set `Cache-Control: no-store`. A new `GET /me/subscriptions/:id` detail endpoint is added in the same router file. Tests live in `tests/lib/stripeStatus.test.ts` (pure unit), `tests/routes/me.subscriptions.test.ts` (extended + polling-contract), `tests/routes/me.subscription.detail.test.ts` (new), and `tests/routes/stripe.webhook.test.ts` (new `incomplete_expired` case).

**Tech Stack:** Node 20, Express 5, TypeScript 6, pnpm 9, Vitest 4, Supertest, Supabase JS v2, zod

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/lib/stripeStatus.ts` | **Create** | `mapStripeStatus()` — collapses Stripe's broad status enum onto the 4-value DB enum |
| `src/routes/me.ts` | **Modify** | Widen list endpoint, add detail endpoint, add zod validation |
| `src/routes/stripeWebhook.ts` | **Modify** | Apply `mapStripeStatus()` at the 2 `sub.status` write sites |
| `tests/lib/stripeStatus.test.ts` | **Create** | Pure-unit coverage for all 8 mapping cases + throw-on-unknown |
| `tests/routes/me.subscriptions.test.ts` | **Modify** | Update breaking test, add filter/cache/shape tests, add polling-contract integration test |
| `tests/routes/me.subscription.detail.test.ts` | **Create** | 200, 401, 404-malformed, 404-not-yours, 404-nonexistent, Cache-Control |
| `tests/routes/stripe.webhook.test.ts` | **Modify** | Add `incomplete_expired → canceled` test |

---

## Task 1: Create `mapStripeStatus()` helper

**Files:**
- Create: `src/lib/stripeStatus.ts`

- [ ] **Step 1: Create the helper file**

```ts
// src/lib/stripeStatus.ts

const MAP: Record<string, 'active' | 'past_due' | 'canceled' | 'incomplete'> = {
  active: 'active',
  trialing: 'active',           // user has access during trial
  past_due: 'past_due',
  unpaid: 'past_due',           // retries exhausted; FE shows "update payment"
  paused: 'past_due',           // similar UX semantics
  canceled: 'canceled',
  incomplete: 'incomplete',
  incomplete_expired: 'canceled', // 23h auto-cancel; sub is dead
};

export function mapStripeStatus(s: string): 'active' | 'past_due' | 'canceled' | 'incomplete' {
  const out = MAP[s];
  if (!out) throw new Error(`unknown Stripe subscription status: ${s}`);
  return out;
}
```

- [ ] **Step 2: Verify typecheck is clean**

```bash
cd /Users/christianvillegas/BusinessCode/inStudiio-Backend && pnpm typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/stripeStatus.ts
git commit -m "feat: add mapStripeStatus() helper for Stripe→DB status normalization"
```

---

## Task 2: Unit-test `mapStripeStatus()`

**Files:**
- Create: `tests/lib/stripeStatus.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/stripeStatus.test.ts
import { describe, it, expect } from 'vitest';
import { mapStripeStatus } from '../../src/lib/stripeStatus.js';

describe('mapStripeStatus', () => {
  it('active → active', () => {
    expect(mapStripeStatus('active')).toBe('active');
  });
  it('trialing → active (trial is full access)', () => {
    expect(mapStripeStatus('trialing')).toBe('active');
  });
  it('past_due → past_due', () => {
    expect(mapStripeStatus('past_due')).toBe('past_due');
  });
  it('unpaid → past_due (retries exhausted)', () => {
    expect(mapStripeStatus('unpaid')).toBe('past_due');
  });
  it('paused → past_due (similar UX)', () => {
    expect(mapStripeStatus('paused')).toBe('past_due');
  });
  it('canceled → canceled', () => {
    expect(mapStripeStatus('canceled')).toBe('canceled');
  });
  it('incomplete → incomplete', () => {
    expect(mapStripeStatus('incomplete')).toBe('incomplete');
  });
  it('incomplete_expired → canceled (auto-cancelled after 23h)', () => {
    expect(mapStripeStatus('incomplete_expired')).toBe('canceled');
  });
  it('throws on unknown status', () => {
    expect(() => mapStripeStatus('unknown_future_status')).toThrow(
      'unknown Stripe subscription status: unknown_future_status',
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
cd /Users/christianvillegas/BusinessCode/inStudiio-Backend && pnpm vitest run tests/lib/stripeStatus.test.ts
```

Expected: 9 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/lib/stripeStatus.test.ts
git commit -m "test: unit tests for mapStripeStatus() all 8 mappings + throw-on-unknown"
```

---

## Task 3: Apply `mapStripeStatus()` in webhook handlers

The two webhook handler write sites that use raw `sub.status` are:
1. `checkout.session.completed` — the upsert at line ~141
2. `customer.subscription.updated` — the update at line ~224

The other 3 handlers hardcode `'active'`, `'past_due'`, `'canceled'` which already pass the DB CHECK constraint.

**Files:**
- Modify: `src/routes/stripeWebhook.ts`

- [ ] **Step 1: Add the import**

In `src/routes/stripeWebhook.ts`, add this import after the existing imports (line 7):

Old:
```ts
import type { StripeDeps } from '../types/stripeDeps.js';
```

New:
```ts
import type { StripeDeps } from '../types/stripeDeps.js';
import { mapStripeStatus } from '../lib/stripeStatus.js';
```

- [ ] **Step 2: Apply `mapStripeStatus()` in `checkout.session.completed`**

Locate the upsert payload inside the `checkout.session.completed` case. The line reads:

Old:
```ts
                status: sub.status,
                current_period_start: new Date(start * 1000).toISOString(),
                current_period_end: new Date(end * 1000).toISOString(),
                cancel_at_period_end: !!sub.cancel_at_period_end,
```

New:
```ts
                status: mapStripeStatus(sub.status),
                current_period_start: new Date(start * 1000).toISOString(),
                current_period_end: new Date(end * 1000).toISOString(),
                cancel_at_period_end: !!sub.cancel_at_period_end,
```

- [ ] **Step 3: Apply `mapStripeStatus()` in `customer.subscription.updated`**

Locate the `update` object inside the `customer.subscription.updated` case. The line reads:

Old:
```ts
          const update = {
            status: sub.status,
            cancel_at_period_end: !!sub.cancel_at_period_end,
```

New:
```ts
          const update = {
            status: mapStripeStatus(sub.status),
            cancel_at_period_end: !!sub.cancel_at_period_end,
```

- [ ] **Step 4: Verify typecheck is clean**

```bash
cd /Users/christianvillegas/BusinessCode/inStudiio-Backend && pnpm typecheck
```

Expected: no errors.

- [ ] **Step 5: Run the webhook test suite to confirm no regressions**

```bash
cd /Users/christianvillegas/BusinessCode/inStudiio-Backend && pnpm vitest run tests/routes/stripe.webhook.test.ts
```

Expected: all existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/routes/stripeWebhook.ts
git commit -m "feat: apply mapStripeStatus() at webhook status write sites (B1 hardening)"
```

---

## Task 4: Add `incomplete_expired` webhook regression test

**Files:**
- Modify: `tests/routes/stripe.webhook.test.ts`

This test verifies that when Stripe sends `incomplete_expired` (which is not in the DB CHECK constraint), `mapStripeStatus()` normalizes it to `'canceled'` so no PG 23514 CHECK violation occurs.

- [ ] **Step 1: Add the test inside the `POST /webhooks/stripe — event handling` describe block**

Add this test at the end of the `POST /webhooks/stripe — event handling` describe block, before the closing `});`. It should be placed after the `customer.subscription.deleted` test:

```ts
  it('customer.subscription.updated with incomplete_expired maps to canceled (no CHECK violation)', async () => {
    const user = await createTestUser('plan4-sub-wh-u');
    users.push(user);
    const studio = await insertTestStudio({
      ownerUserId: user.id,
      slug: `${SLUG_PREFIX}inc-exp-${Date.now()}`,
    });
    const subId = `sub_test_p4wh_${Date.now()}`;
    await supabase.from('subscriptions').insert({
      user_id: user.id,
      studio_id: studio.id,
      stripe_subscription_id: subId,
      stripe_customer_id: `cus_test_p4wh_${Date.now()}`,
      status: 'incomplete',
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
      cancel_at_period_end: false,
    });

    const stripe = makeStripeMock();
    // Build a customer.subscription.updated event then override status to
    // 'incomplete_expired'. The typed builder only accepts the 4 DB values,
    // so we override after the fact.
    const event = customerSubscriptionUpdated({
      subId,
      status: 'incomplete',   // placeholder — we override below
      cancelAtPeriodEnd: false,
    });
    (event.data.object as { status: string }).status = 'incomplete_expired';

    const app = createApp({ stripe });
    const res = await postEvent(app, event);
    expect(res.status).toBe(200);

    const { data } = await supabase
      .from('subscriptions')
      .select('status')
      .eq('stripe_subscription_id', subId)
      .single();
    expect(data?.status).toBe('canceled');
  });
```

- [ ] **Step 2: Run the full webhook test suite**

```bash
cd /Users/christianvillegas/BusinessCode/inStudiio-Backend && pnpm vitest run tests/routes/stripe.webhook.test.ts
```

Expected: all tests pass, including the new `incomplete_expired` test.

- [ ] **Step 3: Commit**

```bash
git add tests/routes/stripe.webhook.test.ts
git commit -m "test: incomplete_expired webhook maps to canceled (no CHECK violation)"
```

---

## Task 5: Widen `GET /me/subscriptions` — embed studio, filters, cache header

**Files:**
- Modify: `src/routes/me.ts`
- Modify: `tests/routes/me.subscriptions.test.ts` (fix breaking test)

The existing `GET /me/subscriptions` handler:
- Hardcodes `status='active'` — must be removed
- Returns `studio_id` as a flat field — must become an embedded `studio` object
- Has no query-param validation — must add zod
- Has no `Cache-Control` header — must add `no-store`

The existing test at line 52 checks `sub.studio_id` and the exact key list — both will break and must be updated as part of this task.

- [ ] **Step 1: Rewrite `src/routes/me.ts` completely**

```ts
// src/routes/me.ts
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';

const STUDIO_FIELDS = 'id, name, slug, description, price_monthly, created_at' as const;

const SUB_FIELDS =
  'id, status, current_period_start, current_period_end, cancel_at_period_end, ' +
  `studio:studios(${STUDIO_FIELDS})`;

const ListQuery = z.object({
  // Empty strings (?status=) collapse to undefined so they're treated as
  // "filter not specified" instead of failing zod's enum check. Same
  // applies to studio_id.
  status: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['active', 'past_due', 'canceled', 'incomplete']).optional(),
  ),
  studio_id: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().uuid().optional(),
  ),
});

export const meRouter = Router();

meRouter.use(requireAuth);

meRouter.get('/studios', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw new ApiError(401, 'unauthorized', 'authentication required');
    const { data, error } = await supabase
      .from('studios')
      .select(STUDIO_FIELDS)
      .eq('owner_user_id', req.user.id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ studios: data ?? [] });
  } catch (err) {
    next(err);
  }
});

meRouter.get('/subscriptions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw new ApiError(401, 'unauthorized', 'authentication required');
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_query', parsed.error.issues[0]?.message ?? 'invalid query params');
    }
    let q = supabase
      .from('subscriptions')
      .select(SUB_FIELDS)
      .eq('user_id', req.user.id);
    if (parsed.data.status) q = q.eq('status', parsed.data.status);
    if (parsed.data.studio_id) q = q.eq('studio_id', parsed.data.studio_id);
    const { data, error } = await q
      .order('current_period_end', { ascending: false })
      .order('id', { ascending: true });
    if (error) throw error;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ subscriptions: data ?? [] });
  } catch (err) {
    next(err);
  }
});

meRouter.get('/subscriptions/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw new ApiError(401, 'unauthorized', 'authentication required');
    const id = String(req.params.id ?? '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new ApiError(404, 'subscription_not_found', 'Subscription not found.');
    }
    const { data, error } = await supabase
      .from('subscriptions')
      .select(SUB_FIELDS)
      .eq('id', id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new ApiError(404, 'subscription_not_found', 'Subscription not found.');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ subscription: data });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 2: Verify typecheck is clean**

```bash
cd /Users/christianvillegas/BusinessCode/inStudiio-Backend && pnpm typecheck
```

Expected: no errors.

- [ ] **Step 3: Update the breaking test in `tests/routes/me.subscriptions.test.ts`**

The test "returns only caller-owned active subs, whitelisted fields" at line 52 checks:
- `sub.studio_id` — will now be `sub.studio.id`
- `Object.keys(sub)` exact list that includes `'studio_id'` — will now include `'studio'` instead

Replace only that test case (lines 52–73). The `beforeAll`/`afterAll` and auth test stay unchanged.

Old test case to replace:
```ts
  it('returns only caller-owned active subs, whitelisted fields', async () => {
    const token = signUserToken({ id: aliceId, email: aliceEmail });
    const res = await request(app).get('/me/subscriptions').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(1);
    const sub = res.body.subscriptions[0];
    expect(sub.studio_id).toBe(studio1Id);
    expect(sub.status).toBe('active');
    expect(Object.keys(sub).sort()).toEqual(
      [
        'cancel_at_period_end',
        'current_period_end',
        'current_period_start',
        'id',
        'status',
        'studio_id',
      ].sort(),
    );
    expect(sub).not.toHaveProperty('stripe_subscription_id');
    expect(sub).not.toHaveProperty('stripe_customer_id');
    expect(sub).not.toHaveProperty('user_id');
  });
```

New test case:
```ts
  it('returns all owned subs (not filtered to active), embedded studio, whitelisted fields', async () => {
    const token = signUserToken({ id: aliceId, email: aliceEmail });
    const res = await request(app).get('/me/subscriptions').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    // Alice has two subs: studio1 (active) + studio2 (canceled)
    expect(res.body.subscriptions).toHaveLength(2);
    const sub = res.body.subscriptions.find((s: { status: string }) => s.status === 'active')!;
    expect(sub).toBeDefined();
    expect(sub.studio.id).toBe(studio1Id);
    expect(sub.status).toBe('active');
    expect(Object.keys(sub).sort()).toEqual(
      [
        'cancel_at_period_end',
        'current_period_end',
        'current_period_start',
        'id',
        'status',
        'studio',
      ].sort(),
    );
    expect(sub).not.toHaveProperty('studio_id');
    expect(sub).not.toHaveProperty('stripe_subscription_id');
    expect(sub).not.toHaveProperty('stripe_customer_id');
    expect(sub).not.toHaveProperty('user_id');
    // Studio shape guard
    expect(typeof sub.studio).toBe('object');
    expect(Array.isArray(sub.studio)).toBe(false);
    expect(Object.keys(sub.studio).sort()).toEqual(
      ['created_at', 'description', 'id', 'name', 'price_monthly', 'slug'].sort(),
    );
  });
```

- [ ] **Step 4: Run the existing test suite to confirm only the modified test now passes with new shape**

```bash
cd /Users/christianvillegas/BusinessCode/inStudiio-Backend && pnpm vitest run tests/routes/me.subscriptions.test.ts
```

Expected: 2 tests pass (auth test + updated shape test).

- [ ] **Step 5: Commit**

```bash
git add src/routes/me.ts tests/routes/me.subscriptions.test.ts
git commit -m "feat: widen GET /me/subscriptions — embed studio, all statuses, zod filters, no-store"
```

---

## Task 6: Add filter, cache, and shape tests to `me.subscriptions.test.ts`

**Files:**
- Modify: `tests/routes/me.subscriptions.test.ts`

These tests use a separate `describe` block with their own `beforeEach`/`afterEach` setup so they don't interfere with the `beforeAll`/`afterAll` block above.

- [ ] **Step 1: Add the new `describe` block and imports at the bottom of the file**

Add these imports at the top of the file, after the existing imports:

```ts
import { makeStripeMock } from '../helpers/stripeMock.js';
import { deleteAllStripeWebhookEventsByPrefix } from '../helpers/testData.js';
import { checkoutSessionCompleted } from '../fixtures/stripeEvents.js';
import { type TestUser } from '../helpers/testUsers.js';
```

Then add the following `describe` block at the bottom of the file (after the closing `});` of the existing describe block):

```ts
const PLAN6_PREFIX = 'plan6-me-';
const PLAN6_EVENT_PREFIX = 'evt_p6me_';

describe('GET /me/subscriptions — Plan 6 filters, shape, polling', () => {
  const users: TestUser[] = [];
  beforeEach(async () => {
    await supabase.from('subscriptions').delete().like('stripe_subscription_id', 'sub_test_p6_%');
    await deleteTestStudiosBySlugPrefix(PLAN6_PREFIX);
    await deleteAllStripeWebhookEventsByPrefix(PLAN6_EVENT_PREFIX);
  });
  afterEach(async () => {
    await supabase.from('subscriptions').delete().like('stripe_subscription_id', 'sub_test_p6_%');
    await deleteTestStudiosBySlugPrefix(PLAN6_PREFIX);
    await deleteAllStripeWebhookEventsByPrefix(PLAN6_EVENT_PREFIX);
    for (const u of users) await deleteTestUser(u.id);
    users.length = 0;
  });

  it('?status=canceled returns only canceled rows; active row excluded', async () => {
    const owner = await createTestUser(`${PLAN6_PREFIX}owner`);
    const user = await createTestUser(`${PLAN6_PREFIX}u`);
    users.push(owner, user);
    const studio1 = await insertTestStudio({ ownerUserId: owner.id, slug: `${PLAN6_PREFIX}s1-${Date.now()}` });
    const studio2 = await insertTestStudio({ ownerUserId: owner.id, slug: `${PLAN6_PREFIX}s2-${Date.now()}` });
    await insertTestSubscription({ userId: user.id, studioId: studio1.id, status: 'active', stripeSubId: `sub_test_p6_act_${Date.now()}` });
    await insertTestSubscription({ userId: user.id, studioId: studio2.id, status: 'canceled', stripeSubId: `sub_test_p6_can_${Date.now()}` });

    const app = createApp();
    const res = await request(app)
      .get('/me/subscriptions?status=canceled')
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(1);
    expect(res.body.subscriptions[0].status).toBe('canceled');
    expect(res.body.subscriptions[0].studio.id).toBe(studio2.id);
  });

  it('?studio_id=<uuid> filters to that studio only', async () => {
    const owner = await createTestUser(`${PLAN6_PREFIX}owner`);
    const user = await createTestUser(`${PLAN6_PREFIX}u`);
    users.push(owner, user);
    const studio1 = await insertTestStudio({ ownerUserId: owner.id, slug: `${PLAN6_PREFIX}f1-${Date.now()}` });
    const studio2 = await insertTestStudio({ ownerUserId: owner.id, slug: `${PLAN6_PREFIX}f2-${Date.now()}` });
    await insertTestSubscription({ userId: user.id, studioId: studio1.id, status: 'active', stripeSubId: `sub_test_p6_f1_${Date.now()}` });
    await insertTestSubscription({ userId: user.id, studioId: studio2.id, status: 'active', stripeSubId: `sub_test_p6_f2_${Date.now()}` });

    const app = createApp();
    const res = await request(app)
      .get(`/me/subscriptions?studio_id=${studio1.id}`)
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(1);
    expect(res.body.subscriptions[0].studio.id).toBe(studio1.id);
  });

  it('?status=active&studio_id=<uuid> composes both filters', async () => {
    const owner = await createTestUser(`${PLAN6_PREFIX}owner`);
    const user = await createTestUser(`${PLAN6_PREFIX}u`);
    users.push(owner, user);
    const studio1 = await insertTestStudio({ ownerUserId: owner.id, slug: `${PLAN6_PREFIX}c1-${Date.now()}` });
    const studio2 = await insertTestStudio({ ownerUserId: owner.id, slug: `${PLAN6_PREFIX}c2-${Date.now()}` });
    await insertTestSubscription({ userId: user.id, studioId: studio1.id, status: 'active', stripeSubId: `sub_test_p6_c1_${Date.now()}` });
    await insertTestSubscription({ userId: user.id, studioId: studio2.id, status: 'canceled', stripeSubId: `sub_test_p6_c2_${Date.now()}` });

    const app = createApp();
    const res = await request(app)
      .get(`/me/subscriptions?status=active&studio_id=${studio1.id}`)
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(1);
    expect(res.body.subscriptions[0].status).toBe('active');
    expect(res.body.subscriptions[0].studio.id).toBe(studio1.id);
  });

  it('?status= (empty string) treated as no filter — returns all statuses', async () => {
    const owner = await createTestUser(`${PLAN6_PREFIX}owner`);
    const user = await createTestUser(`${PLAN6_PREFIX}u`);
    users.push(owner, user);
    const studio1 = await insertTestStudio({ ownerUserId: owner.id, slug: `${PLAN6_PREFIX}e1-${Date.now()}` });
    const studio2 = await insertTestStudio({ ownerUserId: owner.id, slug: `${PLAN6_PREFIX}e2-${Date.now()}` });
    await insertTestSubscription({ userId: user.id, studioId: studio1.id, status: 'active', stripeSubId: `sub_test_p6_e1_${Date.now()}` });
    await insertTestSubscription({ userId: user.id, studioId: studio2.id, status: 'canceled', stripeSubId: `sub_test_p6_e2_${Date.now()}` });

    const app = createApp();
    const res = await request(app)
      .get('/me/subscriptions?status=')
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(2);
  });

  it('?status=invalid → 400 invalid_query', async () => {
    const user = await createTestUser(`${PLAN6_PREFIX}u`);
    users.push(user);
    const app = createApp();
    const res = await request(app)
      .get('/me/subscriptions?status=invalid')
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('invalid_query');
  });

  it('?studio_id=not-a-uuid → 400 invalid_query', async () => {
    const user = await createTestUser(`${PLAN6_PREFIX}u`);
    users.push(user);
    const app = createApp();
    const res = await request(app)
      .get('/me/subscriptions?studio_id=not-a-uuid')
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('invalid_query');
  });

  it('response includes Cache-Control: no-store', async () => {
    const user = await createTestUser(`${PLAN6_PREFIX}u`);
    users.push(user);
    const app = createApp();
    const res = await request(app)
      .get('/me/subscriptions')
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('other users subscriptions are not visible', async () => {
    const owner = await createTestUser(`${PLAN6_PREFIX}owner`);
    const alice = await createTestUser(`${PLAN6_PREFIX}alice`);
    const bob = await createTestUser(`${PLAN6_PREFIX}bob`);
    users.push(owner, alice, bob);
    const studio = await insertTestStudio({ ownerUserId: owner.id, slug: `${PLAN6_PREFIX}vis-${Date.now()}` });
    await insertTestSubscription({ userId: bob.id, studioId: studio.id, status: 'active', stripeSubId: `sub_test_p6_bob_${Date.now()}` });

    const app = createApp();
    const res = await request(app)
      .get('/me/subscriptions')
      .set('Authorization', `Bearer ${signUserToken(alice)}`);
    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(0);
  });

  it('stable sort: two subs with same current_period_end are ordered by id ASC', async () => {
    const owner = await createTestUser(`${PLAN6_PREFIX}owner`);
    const user = await createTestUser(`${PLAN6_PREFIX}u`);
    users.push(owner, user);
    const studio1 = await insertTestStudio({ ownerUserId: owner.id, slug: `${PLAN6_PREFIX}sort1-${Date.now()}` });
    const studio2 = await insertTestStudio({ ownerUserId: owner.id, slug: `${PLAN6_PREFIX}sort2-${Date.now()}` });

    const sharedEnd = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
    const subStart = new Date().toISOString();
    // Insert directly to control period_end timestamps exactly
    const { data: row1 } = await supabase.from('subscriptions').insert({
      user_id: user.id, studio_id: studio1.id,
      stripe_subscription_id: `sub_test_p6_sort1_${Date.now()}`,
      stripe_customer_id: `cus_test_sort1`,
      status: 'active',
      current_period_start: subStart, current_period_end: sharedEnd,
      cancel_at_period_end: false,
    }).select('id').single();
    const { data: row2 } = await supabase.from('subscriptions').insert({
      user_id: user.id, studio_id: studio2.id,
      stripe_subscription_id: `sub_test_p6_sort2_${Date.now()}`,
      stripe_customer_id: `cus_test_sort2`,
      status: 'active',
      current_period_start: subStart, current_period_end: sharedEnd,
      cancel_at_period_end: false,
    }).select('id').single();

    const app = createApp();
    const res = await request(app)
      .get('/me/subscriptions')
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(2);
    // id ASC tiebreaker: lower UUID string first
    const ids = res.body.subscriptions.map((s: { id: string }) => s.id);
    const expectedOrder = [row1!.id, row2!.id].sort();
    expect(ids).toEqual(expectedOrder);
  });
});
```

- [ ] **Step 2: Run the new tests**

```bash
cd /Users/christianvillegas/BusinessCode/inStudiio-Backend && pnpm vitest run tests/routes/me.subscriptions.test.ts
```

Expected: all tests pass (original 2 + new 9 = 11 total).

- [ ] **Step 3: Commit**

```bash
git add tests/routes/me.subscriptions.test.ts
git commit -m "test: GET /me/subscriptions filter, shape, cache, isolation, stable-sort tests"
```

---

## Task 7: Add polling-contract integration test

**Files:**
- Modify: `tests/routes/me.subscriptions.test.ts`

This test is the end-to-end proof that the FE polling flow works: empty list before checkout webhook → populated list after webhook. It goes in its own `describe` block so it can use a different prefix.

- [ ] **Step 1: Add the polling-contract describe block at the bottom of the file**

```ts
const POLL_SLUG_PREFIX = 'plan6-poll-';
const POLL_EVENT_PREFIX = 'evt_p6poll_';

describe('GET /me/subscriptions — polling-contract integration', () => {
  const users: TestUser[] = [];
  beforeEach(async () => {
    await supabase.from('subscriptions').delete().like('stripe_subscription_id', 'sub_test_p6poll_%');
    await deleteTestStudiosBySlugPrefix(POLL_SLUG_PREFIX);
    await deleteAllStripeWebhookEventsByPrefix(POLL_EVENT_PREFIX);
  });
  afterEach(async () => {
    await supabase.from('subscriptions').delete().like('stripe_subscription_id', 'sub_test_p6poll_%');
    await deleteTestStudiosBySlugPrefix(POLL_SLUG_PREFIX);
    await deleteAllStripeWebhookEventsByPrefix(POLL_EVENT_PREFIX);
    for (const u of users) await deleteTestUser(u.id);
    users.length = 0;
  });

  it('empty before webhook, populated after checkout.session.completed replay', async () => {
    const user = await createTestUser(`${POLL_SLUG_PREFIX}u`);
    users.push(user);
    const studio = await insertTestStudio({
      ownerUserId: user.id,
      slug: `${POLL_SLUG_PREFIX}s-${Date.now()}`,
    });
    const subId = `sub_test_p6poll_${Date.now()}`;
    const custId = `cus_test_p6poll_${Date.now()}`;
    const periodStart = Math.floor(Date.now() / 1000);
    const periodEnd = periodStart + 30 * 86400;

    const stripe = makeStripeMock();
    stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: subId,
      status: 'active',
      cancel_at_period_end: false,
      items: {
        data: [{ current_period_start: periodStart, current_period_end: periodEnd }],
      },
    });

    const app = createApp({ stripe });

    // Step 1: poll before checkout — list is empty
    const before = await request(app)
      .get(`/me/subscriptions?studio_id=${studio.id}`)
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(before.status).toBe(200);
    expect(before.body.subscriptions).toHaveLength(0);

    // Step 2: simulate Stripe sending checkout.session.completed
    const event = checkoutSessionCompleted({
      userId: user.id,
      studioId: studio.id,
      subId,
      custId,
      eventId: `${POLL_EVENT_PREFIX}${Date.now()}`,
    });
    const webhookRes = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', 't=0,v1=dummy')
      .send(JSON.stringify(event));
    expect(webhookRes.status).toBe(200);

    // Step 3: poll after checkout — row appears, fully shaped
    const after = await request(app)
      .get(`/me/subscriptions?studio_id=${studio.id}`)
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(after.status).toBe(200);
    expect(after.body.subscriptions).toHaveLength(1);
    const sub = after.body.subscriptions[0];
    expect(sub.status).toBe('active');
    expect(sub.studio.id).toBe(studio.id);
    expect(sub.cancel_at_period_end).toBe(false);
    expect(sub.current_period_end).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the polling-contract test**

```bash
cd /Users/christianvillegas/BusinessCode/inStudiio-Backend && pnpm vitest run tests/routes/me.subscriptions.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/routes/me.subscriptions.test.ts
git commit -m "test: polling-contract integration — empty→populated via checkout.session.completed replay"
```

---

## Task 8: Create `GET /me/subscriptions/:id` detail tests

**Files:**
- Create: `tests/routes/me.subscription.detail.test.ts`

The detail endpoint is already implemented in `src/routes/me.ts` from Task 5. This task adds the full test coverage.

- [ ] **Step 1: Create the test file**

```ts
// tests/routes/me.subscription.detail.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/index.js';
import { supabase } from '../../src/supabase.js';
import { makeStripeMock } from '../helpers/stripeMock.js';
import { createTestUser, deleteTestUser, signUserToken, type TestUser } from '../helpers/testUsers.js';
import {
  insertTestStudio,
  insertTestSubscription,
  deleteTestStudiosBySlugPrefix,
} from '../helpers/testData.js';

const SLUG_PREFIX = 'plan6-me-detail-';

describe('GET /me/subscriptions/:id', () => {
  const users: TestUser[] = [];
  beforeEach(async () => {
    await supabase.from('subscriptions').delete().like('stripe_subscription_id', 'sub_test_p6d_%');
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
  });
  afterEach(async () => {
    await supabase.from('subscriptions').delete().like('stripe_subscription_id', 'sub_test_p6d_%');
    await deleteTestStudiosBySlugPrefix(SLUG_PREFIX);
    for (const u of users) await deleteTestUser(u.id);
    users.length = 0;
  });

  it('200 returns single subscription with embedded studio', async () => {
    const owner = await createTestUser(`${SLUG_PREFIX}owner`);
    const user = await createTestUser(`${SLUG_PREFIX}u`);
    users.push(owner, user);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}ok-${Date.now()}`,
    });
    const sub = await insertTestSubscription({
      userId: user.id,
      studioId: studio.id,
      status: 'active',
      stripeSubId: `sub_test_p6d_ok_${Date.now()}`,
    });

    const stripe = makeStripeMock();
    const app = createApp({ stripe });
    const res = await request(app)
      .get(`/me/subscriptions/${sub.id}`)
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(200);
    expect(res.body.subscription).toBeDefined();
    expect(res.body.subscription.id).toBe(sub.id);
    expect(res.body.subscription.status).toBe('active');
    expect(typeof res.body.subscription.studio).toBe('object');
    expect(Array.isArray(res.body.subscription.studio)).toBe(false);
    expect(res.body.subscription.studio.id).toBe(studio.id);
    expect(res.body.subscription.studio.name).toBeDefined();
    expect(res.body.subscription.studio.slug).toBeDefined();
    expect(res.body.subscription.studio.price_monthly).toBeDefined();
    expect(res.body.subscription.studio.created_at).toBeDefined();
  });

  it('response includes Cache-Control: no-store', async () => {
    const owner = await createTestUser(`${SLUG_PREFIX}owner`);
    const user = await createTestUser(`${SLUG_PREFIX}u`);
    users.push(owner, user);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}cc-${Date.now()}`,
    });
    const sub = await insertTestSubscription({
      userId: user.id,
      studioId: studio.id,
      stripeSubId: `sub_test_p6d_cc_${Date.now()}`,
    });

    const app = createApp();
    const res = await request(app)
      .get(`/me/subscriptions/${sub.id}`)
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('401 when no Authorization header', async () => {
    const app = createApp();
    const res = await request(app).get('/me/subscriptions/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(401);
  });

  it('404 subscription_not_found when id is malformed (existence-leak unification)', async () => {
    const user = await createTestUser(`${SLUG_PREFIX}u`);
    users.push(user);
    const app = createApp();
    const res = await request(app)
      .get('/me/subscriptions/not-a-uuid')
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('subscription_not_found');
  });

  it('404 subscription_not_found when id does not exist', async () => {
    const user = await createTestUser(`${SLUG_PREFIX}u`);
    users.push(user);
    const app = createApp();
    const res = await request(app)
      .get('/me/subscriptions/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${signUserToken(user)}`);
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('subscription_not_found');
  });

  it('404 subscription_not_found when id belongs to another user (existence-leak unification)', async () => {
    const owner = await createTestUser(`${SLUG_PREFIX}owner`);
    const other = await createTestUser(`${SLUG_PREFIX}other`);
    const me = await createTestUser(`${SLUG_PREFIX}me`);
    users.push(owner, other, me);
    const studio = await insertTestStudio({
      ownerUserId: owner.id,
      slug: `${SLUG_PREFIX}leak-${Date.now()}`,
    });
    const otherSub = await insertTestSubscription({
      userId: other.id,
      studioId: studio.id,
      stripeSubId: `sub_test_p6d_leak_${Date.now()}`,
    });

    const app = createApp();
    const res = await request(app)
      .get(`/me/subscriptions/${otherSub.id}`)
      .set('Authorization', `Bearer ${signUserToken(me)}`);
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('subscription_not_found');
  });
});
```

- [ ] **Step 2: Run the detail test suite**

```bash
cd /Users/christianvillegas/BusinessCode/inStudiio-Backend && pnpm vitest run tests/routes/me.subscription.detail.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/routes/me.subscription.detail.test.ts
git commit -m "test: GET /me/subscriptions/:id — 200, 401, 404 malformed/nonexistent/not-yours, no-store"
```

---

## Task 9: Full suite green check + typecheck

- [ ] **Step 1: Run typecheck**

```bash
cd /Users/christianvillegas/BusinessCode/inStudiio-Backend && pnpm typecheck
```

Expected: no errors.

- [ ] **Step 2: Run the full test suite**

```bash
cd /Users/christianvillegas/BusinessCode/inStudiio-Backend && pnpm vitest run
```

Expected: all tests green. If any fail, fix before proceeding.

---

## Task 10: Update Postman collection

The Postman collection `inStudiio Backend (local)` (uid `40498804-5cb76a50-8193-472d-bc33-e19a3e8c157c`) needs:
1. New request `GET /me/subscriptions/:id`
2. Updated `GET /me/subscriptions` — add `?status=` and `?studio_id=` example query params
3. Updated example responses on both to show the embedded `studio` shape

Use the Postman MCP tool to make these changes.

- [ ] **Step 1: Find the existing `GET /me/subscriptions` request in the collection and update it**

Use `mcp__postman__getCollection` with the collection uid to find the request id, then `mcp__postman__updateCollectionRequest` to add query params (`status`, `studio_id`) and update the example response to show the embedded `studio` shape:

```json
{
  "subscriptions": [
    {
      "id": "00000000-0000-0000-0000-000000000001",
      "status": "active",
      "current_period_start": "2026-04-28T12:00:00Z",
      "current_period_end": "2026-05-28T12:00:00Z",
      "cancel_at_period_end": false,
      "studio": {
        "id": "00000000-0000-0000-0000-000000000010",
        "name": "Example Studio",
        "slug": "example",
        "description": "Studio description",
        "price_monthly": 9.99,
        "created_at": "2026-04-01T00:00:00Z"
      }
    }
  ]
}
```

- [ ] **Step 2: Add a new `GET /me/subscriptions/:id` request to the collection**

Use `mcp__postman__createCollectionRequest` to add the request under the same folder as `GET /me/subscriptions`. Example response body:

```json
{
  "subscription": {
    "id": "00000000-0000-0000-0000-000000000001",
    "status": "active",
    "current_period_start": "2026-04-28T12:00:00Z",
    "current_period_end": "2026-05-28T12:00:00Z",
    "cancel_at_period_end": false,
    "studio": {
      "id": "00000000-0000-0000-0000-000000000010",
      "name": "Example Studio",
      "slug": "example",
      "description": "Studio description",
      "price_monthly": 9.99,
      "created_at": "2026-04-01T00:00:00Z"
    }
  }
}
```

Include a 404 example response:
```json
{ "error": { "code": "subscription_not_found", "message": "Subscription not found." } }
```

- [ ] **Step 3: Commit Postman sync note**

```bash
git commit --allow-empty -m "chore: Postman collection updated for Plan 6 (GET /me/subscriptions/:id, embedded studio shape)"
```

---

## Task 11: Open PR

- [ ] **Step 1: Final sanity check**

```bash
cd /Users/christianvillegas/BusinessCode/inStudiio-Backend && pnpm typecheck && pnpm vitest run
```

Expected: typecheck clean, all tests green.

- [ ] **Step 2: Push the branch and open a PR**

```bash
git push -u origin feature/plan-6-me-subscriptions-hardening
gh pr create \
  --title "Plan 6: GET /me/subscriptions hardening — embedded studio, filters, detail endpoint, mapStripeStatus" \
  --body "$(cat <<'EOF'
## Summary

- **`mapStripeStatus()` helper** (`src/lib/stripeStatus.ts`) — normalizes Stripe's broad status enum (`trialing`, `unpaid`, `paused`, `incomplete_expired`, …) onto our 4-value DB CHECK constraint. Applied at the 2 webhook write sites that used raw `sub.status`. Throws on unknown statuses so future Stripe additions surface as alertable webhook 500s, not silent CHECK violations.
- **Widened `GET /me/subscriptions`** — returns all statuses (removed `active`-only filter), embeds studio inline via PostgREST FK join (eliminates the second `/studios/:id` call the FE needed), accepts `?status=` and `?studio_id=` query params validated with zod, sets `Cache-Control: no-store`.
- **New `GET /me/subscriptions/:id`** — single subscription lookup with existence-leak unification (404 for both "not found" and "not yours") and `Cache-Control: no-store`.

## Test plan

- [ ] `pnpm typecheck` passes
- [ ] `pnpm vitest run` green (full suite against local Supabase)
- [ ] `tests/lib/stripeStatus.test.ts` — 9 unit tests covering all 8 mappings + throw-on-unknown
- [ ] `tests/routes/stripe.webhook.test.ts` — `incomplete_expired → canceled` regression test
- [ ] `tests/routes/me.subscriptions.test.ts` — filter, shape, cache, isolation, stable-sort, polling-contract tests
- [ ] `tests/routes/me.subscription.detail.test.ts` — 200, 401, 404 (malformed/nonexistent/not-yours), Cache-Control
- [ ] Postman collection updated with new request and embedded studio shape

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ `GET /me/subscriptions` — all statuses, `?status=`, `?studio_id=`, embedded studio, `no-store` (Tasks 5, 6)
- ✅ `GET /me/subscriptions/:id` — detail, existence-leak 404, `no-store` (Tasks 5, 8)
- ✅ Zod validation, `400 invalid_query` (Task 5, tests in Task 6)
- ✅ `mapStripeStatus()` — helper (Task 1), unit tests (Task 2), applied at webhook (Task 3), `incomplete_expired` webhook test (Task 4)
- ✅ Polling-contract integration test (Task 7)
- ✅ Postman collection (Task 10)
- ✅ `pnpm typecheck` + full suite (Task 9, 11)

**Placeholder scan:** No TBD, TODO, or vague steps — all code blocks are complete.

**Type consistency:**
- `SUB_FIELDS` defined once in `me.ts`, used in both handlers
- `STUDIO_FIELDS` reused verbatim from existing constant (same name, same string)
- `mapStripeStatus` import path `'../lib/stripeStatus.js'` consistent everywhere
- `ListQuery` zod schema used only in the list handler
- `TestUser` type imported in all test files that use the `users` array pattern
