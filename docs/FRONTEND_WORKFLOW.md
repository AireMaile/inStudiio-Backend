# inStudiio Backend — Frontend Workflow Walkthrough (Production)

**Audience:** a frontend dev who is new to this backend.
**Goal:** map every step of the user journey to the endpoint it hits, with a real
example request and the real response — captured against the **live production
stack**.

**Production stack used in this doc:**

| Piece | Value |
|---|---|
| **API (Vercel)** | `https://in-studiio-backend.vercel.app` |
| **Supabase project** | `https://iijhljehoqceownoeauu.supabase.co` |
| **Supabase anon key** (public, browser-safe) | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlpamhsamVob3FjZW93bm9lYXV1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4NDA3MTUsImV4cCI6MjA5NTQxNjcxNX0.dXYdlEZB17eE3kzKE-LGoe9Mz4DsYYikqKcGC_b-HZ8` |

In Postman these are the `{{baseUrl}}` and `{{jwt}}` variables (see
`docs/inStudiio.postman_collection.json`).

> **How to read the examples**
> - **🟢 REAL** — captured live against production. The bytes are exactly what the
>   server returned.
> - **🧪 REPRESENTATIVE** — used only for *populated* states the live test account
>   doesn't have yet (e.g. an active subscription, a `ready` video). The shape is
>   verified against the route code; the values are illustrative. Every empty
>   state and every error below is 🟢 REAL.

---

## The cast: two kinds of user

| Role | How they're created | What they do |
|---|---|---|
| **Subscriber** | Signs up via Supabase auth (anon key) | Browses studios, subscribes (on the web), watches videos |
| **Studio owner** | Created by the backend team with `pnpm onboard:studio` (a script, **not** a public endpoint) | Uploads videos to their own studio |

There is **no signup/login endpoint on this backend** and **no admin endpoint to
create studios**. Auth lives in Supabase; studios are seeded by an operator
script.

---

## The error shape (everywhere)

```json
{ "error": { "code": "some_code", "message": "Human-readable message" } }
```

`code` is stable (branch on it); `message` is for humans; the HTTP status carries
the category.

🟢 **REAL** — `GET /studios?limit=abc` → **400**

```json
{ "error": { "code": "bad_request", "message": "limit must be an integer" } }
```

---

## Step 0 — Get a JWT (this is Supabase, not us)

**User action:** signs up / logs in.

**Who handles it:** `@supabase/supabase-js` in your frontend, using the **anon
key**. This backend has no part in it. After login you hold a Supabase
**access token (a JWT)** that you put on every authenticated call:

```
Authorization: Bearer <jwt>
```

The deployed API verifies that token against the Supabase project's published
signing keys (the prod project signs tokens with **ES256**; the backend also
still accepts legacy **HS256** tokens) and reads the user id from the `sub`
claim. So: **whatever `access_token` Supabase hands your frontend just works** —
you don't transform it.

### The canonical frontend code

```ts
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://iijhljehoqceownoeauu.supabase.co',
  '<anon key from the table above>',   // anon key — safe in the browser
);

// Sign up (first time)…
await supabase.auth.signUp({ email, password });
// …or sign in (returning user):
await supabase.auth.signInWithPassword({ email, password });

const { data: { session } } = await supabase.auth.getSession();
const jwt = session?.access_token;     // ← goes in Authorization: Bearer
```

### The same thing as raw HTTP (this is what supabase-js does under the hood)

🟢 **REAL** — sign up → **200** (note: **no session yet** — this project
requires email confirmation):

```bash
curl -X POST "https://iijhljehoqceownoeauu.supabase.co/auth/v1/signup" \
  -H "apikey: <anon key>" -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"yourpassword"}'
```
```json
{ "id": "ebe69af9-…", "email": "you@example.com",
  "confirmation_sent_at": "2026-06-17T02:59:24Z",
  "user_metadata": { "email_verified": false, "sub": "ebe69af9-…" } }
```

🟢 **REAL** — sign in **before** confirming the email → **400**:

```json
{ "code": 400, "error_code": "email_not_confirmed", "msg": "Email not confirmed" }
```

🟢 **REAL** — sign in **after** clicking the confirmation link → **200**, and
**this is the JWT you use**:

```bash
curl -X POST "https://iijhljehoqceownoeauu.supabase.co/auth/v1/token?grant_type=password" \
  -H "apikey: <anon key>" -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"yourpassword"}'
```
```json
{ "access_token": "eyJhbGciOiJFUzI1NiIsImtpZCI6…",  ← the Bearer token (ES256)
  "token_type": "bearer", "expires_in": 3600, "refresh_token": "…",
  "user": { "id": "ebe69af9-…", "email": "you@example.com" } }
```

🟢 **REAL** — wrong password → **400** `{"error_code":"invalid_credentials","msg":"Invalid login credentials"}`.

> **JWTs expire in 1h** (`expires_in: 3600`). On a 401 with
> `code: "unauthorized"`, refresh via the Supabase client and retry — don't bounce
> the user to a login screen on the first 401.

> **Email confirmation is ON for this project.** A brand-new user can't get a
> session until they click the confirmation link Supabase emails them. (The link
> currently redirects to a placeholder site — see caveats — but the click still
> confirms the account.)

> **The local mint script is NOT this flow.** `pnpm tsx scripts/mint-test-subscriber.ts`
> signs a token *directly with the JWT secret* and is **local-testing only** (it
> refuses to run against production). Use it for curl against a local API — never
> treat it as how the app authenticates.

> **There is no `GET /me`.** You already know who the user is from the Supabase
> session. To ask the backend "what do I own / what am I subscribed to," use
> `GET /me/studios` and `GET /me/subscriptions`.

---

## Step 1 — Health check

| | |
|---|---|
| **Endpoint** | `GET /health` |
| **Auth** | None |

```bash
curl https://in-studiio-backend.vercel.app/health
```

🟢 **REAL** — **200**

```json
{ "status": "ok", "uptime": 1.035736851 }
```

`uptime` is process uptime in seconds (resets on serverless cold start).

---

## Step 2 — Browse studios

| | |
|---|---|
| **Endpoint** | `GET /studios` |
| **Auth** | None (public) |
| **Query** | `limit` (1–100, default 20), `offset` (≥0, default 0) |

```bash
curl "https://in-studiio-backend.vercel.app/studios?limit=20&offset=0"
```

🟢 **REAL** — **200**

```json
{
  "studios": [
    {
      "id": "c4b33530-473b-40f4-9efd-eb9297a60b47",
      "name": "Test Studio",
      "slug": "test",
      "description": null,
      "price_monthly": 9.99,
      "created_at": "2026-05-29T22:24:33.035239+00:00"
    }
  ],
  "pagination": { "limit": 20, "offset": 0, "total": 1 }
}
```

Keep each studio's `id` (to subscribe) and `slug` (to list its videos). There is
**no `GET /studios/:slug`** — reuse the object from this list, or fetch the
studio's videos (requires an active subscription).

---

## Step 3 — Subscribe (this happens on the WEB, not in the app)

The purchase happens in a browser **by design** (see
[`PAYMENTS_MODEL_TRADEOFFS.md`](./PAYMENTS_MODEL_TRADEOFFS.md): the iOS app only
logs in and plays). The flow is split across the browser, Stripe, and a webhook:

```
User clicks Subscribe
        │
        ▼
[1] POST /subscriptions { studioId }      → returns { checkoutUrl }
        │
        ▼
[2] Browser opens checkoutUrl (Stripe hosted page); pays 4242 4242 4242 4242
        │
        ▼
[3] Stripe → POST /webhooks/stripe (checkout.session.completed)   ← server-to-server, NOT you
        │     backend writes the `subscriptions` row
        ▼
[4] Frontend polls GET /me/subscriptions until the row appears
```

### 3a. Create the checkout session

| | |
|---|---|
| **Endpoint** | `POST /subscriptions` |
| **Auth** | **Required** (Bearer JWT) |
| **Body** | `{ "studioId": "<uuid>" }` |

```bash
curl -X POST https://in-studiio-backend.vercel.app/subscriptions \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"studioId":"c4b33530-473b-40f4-9efd-eb9297a60b47"}'
```

🟢 **REAL** — **200** (this is a live **test-mode** Stripe session — note `cs_test_`):

```json
{ "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_test_a11SkL9souqWh2eFCCU0Igx2lIShOIIK…" }
```

Redirect the browser to `checkoutUrl` (`window.location.href = checkoutUrl`).
After payment Stripe redirects to `/subscribe/success?session_id=…`; on cancel,
`/subscribe/cancel` (both small pages the backend serves).

**Errors:**

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_body` | `studioId` missing or not a UUID |
| 401 | `unauthorized` | missing/expired JWT |
| 404 | `studio_not_found` | no studio with that id (or it has no Stripe price) |
| 409 | `already_subscribed` | user already has an `active`/`past_due`/`incomplete` sub here |
| 502 | `stripe_error` | Stripe unreachable — safe to retry |

🟢 **REAL** — bad UUID → **400** `{"error":{"code":"invalid_body","message":"Invalid UUID"}}`

### 3b. Pay (on Stripe's page)

Test card **`4242 4242 4242 4242`**, any future expiry, any CVC, any ZIP.

### 3c. The Stripe webhook writes the row — *you never call this*

`POST /webhooks/stripe` is **server-only** (signed payload, raw body). **Do not
call it from the client.**

> ⚠️ **Production caveat:** the prod Stripe **test-mode webhook is not registered
> yet.** So on the deployed URL, paying will **not** write the subscription row —
> the poll in 3d stays empty. Demo the full loop **locally** with
> `stripe listen --forward-to localhost:3000/webhooks/stripe`
> (`FRONTEND_LOCAL_SETUP.md` §6). Creating the checkout URL works in prod; only
> the entitlement-writing half is gated on the webhook.

### 3d. Poll until the subscription appears

| | |
|---|---|
| **Endpoint** | `GET /me/subscriptions` |
| **Auth** | **Required** |
| **Query** | `status`, `studio_id` — optional filters |

```bash
curl https://in-studiio-backend.vercel.app/me/subscriptions \
  -H "Authorization: Bearer $JWT"
```

🟢 **REAL** — **200**, fresh account with no subscription yet (`Cache-Control: no-store`):

```json
{ "subscriptions": [] }
```

🧪 **REPRESENTATIVE** — once a subscription exists (after the webhook fires
locally), a row looks like:

```json
{
  "subscriptions": [
    {
      "id": "9f1c0e2a-7b6d-4c3e-8a11-2d4f5a6b7c8d",
      "status": "active",
      "current_period_start": "2026-06-16T18:00:00.000Z",
      "current_period_end": "2026-07-16T18:00:00.000Z",
      "cancel_at_period_end": false,
      "studio": {
        "id": "c4b33530-473b-40f4-9efd-eb9297a60b47",
        "name": "Test Studio", "slug": "test", "description": null,
        "price_monthly": 9.99, "created_at": "2026-05-29T22:24:33.035239+00:00"
      }
    }
  ]
}
```

**Polling:** after checkout, poll every ~1.5s for ~10s until a row with
`status: "active"` for the studio appears, then unlock the content.

**`status` is the entitlement flag.** Only `status: "active"` grants video
access. `past_due` / `incomplete` / `canceled` do **not** — show a "renew /
update payment" state. (`trialing` maps to `active`; `unpaid`/`paused` map to
`past_due`.)

**Single subscription:** `GET /me/subscriptions/:id` → `{ "subscription": {…} }`
or **404 `subscription_not_found`** if it isn't yours.

### 3e. Cancel

| | |
|---|---|
| **Endpoint** | `DELETE /subscriptions/:id` |
| **Auth** | **Required** |
| **`:id`** | the **subscription's** id (from `GET /me/subscriptions`), not the studio id |

🧪 **REPRESENTATIVE** — **200** (needs a live subscription to capture):

```json
{ "canceled": true, "cancelAtPeriodEnd": true }
```

It's **cancel-at-period-end**, not instant: the user keeps access until
`current_period_end`; `cancel_at_period_end` flips to `true` immediately, `status`
stays `active` until the period ends. UI: "Cancels on {current_period_end}",
content stays unlocked until then. Errors: 404 `subscription_not_found`, 409
`not_cancelable`.

---

## Step 4 — Owner uploads a video

Two hops: ask us for an upload URL, then send the file straight to Mux.

```
[1] POST /studios/:slug/videos { title }   → returns { video, uploadUrl, uploadId }   (status "waiting")
        ▼
[2] PUT the file bytes to uploadUrl   (straight to Mux — not through us)
        ▼
[3] Mux → POST /webhooks/mux   ← server-to-server, NOT you   (status → preparing → ready)
        ▼
[4] Poll GET /studios/:slug/videos until status === "ready"
```

### 4a. Create the upload

| | |
|---|---|
| **Endpoint** | `POST /studios/:slug/videos` |
| **Auth** | **Required** — caller must **own** this studio |
| **Body** | `{ "title": string (1–200), "description"?: string (≤5000) }` |

```bash
curl -X POST https://in-studiio-backend.vercel.app/studios/test/videos \
  -H "Authorization: Bearer $OWNER_JWT" \
  -H "Content-Type: application/json" \
  -d '{"title":"Episode 1","description":"Warm-up flow"}'
```

🧪 **REPRESENTATIVE** — **201** (needs an owner account for studio `test`):

```json
{
  "video": {
    "id": "b2e7d9a4-1f3c-4a8e-9c12-7d6e5f4a3b2c",
    "studio_id": "c4b33530-473b-40f4-9efd-eb9297a60b47",
    "title": "Episode 1", "description": "Warm-up flow",
    "status": "waiting", "mux_playback_id": null,
    "duration_seconds": null, "error_message": null,
    "created_at": "2026-06-16T18:05:00.000Z"
  },
  "uploadUrl": "https://storage.googleapis.com/video-storage-gcp-…/upload?…",
  "uploadId": "00abc123MuxUploadId"
}
```

Errors: 400 `bad_request`, 403 `forbidden` (not the owner), 404 `not_found`
(no such slug), 502 `upstream_unavailable` (Mux down).

### 4b. Send the file to Mux

```bash
curl -X PUT "<uploadUrl>" -H "Content-Type: video/mp4" --data-binary @episode1.mp4
```

(In a browser, `PUT` the `File`/`Blob`.) This goes **to Mux**, not this backend.

### 4c. Mux webhook flips status — *you never call this*

`POST /webhooks/mux` (server-only, signed, raw body) advances the row
`waiting → preparing → ready` (or `errored`) and stores `mux_playback_id` +
`duration_seconds`. **Do not call it from the client.**

### 4d. Poll until ready

Use `GET /studios/:slug/videos` and watch `status` reach `"ready"` — only then is
`mux_playback_id` populated and the video playable.

---

## Step 5 — Watch

### 5a. List a studio's videos

| | |
|---|---|
| **Endpoint** | `GET /studios/:slug/videos` |
| **Auth** | **Required** — own the studio **or** have an `active` subscription |
| **Query** | `limit` (1–100, default 20), `cursor` (a `created_at` ISO string) |

```bash
curl "https://in-studiio-backend.vercel.app/studios/test/videos?limit=20" \
  -H "Authorization: Bearer $JWT"
```

🟢 **REAL** — not subscribed → **403**:

```json
{ "error": { "code": "forbidden", "message": "subscription required" } }
```

🧪 **REPRESENTATIVE** — subscribed/owner → **200**:

```json
{
  "videos": [
    {
      "id": "b2e7d9a4-1f3c-4a8e-9c12-7d6e5f4a3b2c",
      "studio_id": "c4b33530-473b-40f4-9efd-eb9297a60b47",
      "title": "Episode 1", "description": "Warm-up flow",
      "status": "ready", "mux_playback_id": "AbCdEf01gHiJkLmN02oPqRsT",
      "duration_seconds": 612.3, "error_message": null,
      "created_at": "2026-06-16T18:05:00.000Z"
    }
  ],
  "nextCursor": null
}
```

**Access rules:** not subscribed (and not owner) → **403 `forbidden`**.
Subscribers see only `status: "ready"` videos; owners see everything.
**Paging:** if `videos.length === limit`, pass `nextCursor` back as `?cursor=`;
`null` means end.

### 5b. Get one video

| | |
|---|---|
| **Endpoint** | `GET /videos/:id` |
| **Auth** | **Required** — owner, or active subscriber to the video's studio |

🟢 **REAL** — not entitled (or doesn't exist) → **404** *(not 403 — it won't even
confirm the video exists)*:

```json
{ "error": { "code": "not_found", "message": "video not found" } }
```

🟢 **REAL** — malformed id → **400** `{"error":{"code":"bad_request","message":"invalid video id"}}`

🧪 **REPRESENTATIVE** — entitled → **200** `{ "video": { …same fields as the list… } }`

> **Privacy choice:** a not-yet-`ready` video is also 404 for subscribers. Don't
> render "access denied" — treat it as "not available."

### 5c. Play it

```
https://stream.mux.com/{mux_playback_id}.m3u8
```

e.g. `https://stream.mux.com/AbCdEf01gHiJkLmN02oPqRsT.m3u8` → hand to your HLS
player (AVPlayer on iOS, hls.js / `<video>` on web). Playback policy is
**public**, no signed token needed. If `mux_playback_id` is `null`, it isn't
`ready` — don't try to play it.

---

## Owner housekeeping (not in the main journey)

| Endpoint | Auth | Purpose | Live capture |
|---|---|---|---|
| `GET /me/studios` | required | Studios **owned** by the caller | 🟢 **REAL** non-owner → **200** `{"studios":[]}` |
| `PATCH /videos/:id` | owner | Edit `title`/`description` → `{ "video": {…} }` | — |
| `DELETE /videos/:id` | owner | Delete video (+ its Mux asset) → **204** | — |

---

## ⛔ Server-only endpoints — never call these from a client

| Endpoint | Called by | Why you can't |
|---|---|---|
| `POST /webhooks/stripe` | Stripe's servers | Needs a valid `Stripe-Signature`; raw-body mounted |
| `POST /webhooks/mux` | Mux's servers | Needs a valid Mux signature; raw-body mounted |

Your job is to **poll the read endpoints** (`GET /me/subscriptions`,
`GET /studios/:slug/videos`) until the awaited state appears.

---

## Production caveats (so you're not surprised)

1. **Auth works in prod.** The deployed API verifies the Supabase **ES256**
   access token (and still accepts legacy HS256). Your Supabase `access_token`
   is used verbatim as the Bearer token — confirmed live (`GET /me/subscriptions`
   → 200, `GET /studios/test/videos` → 403 once authenticated).
2. **Stripe is in TEST mode** (`sk_test_…`), so `POST /subscriptions` returns a
   `cs_test_…` Checkout URL — verified live.
3. **Prod Stripe test-mode webhook is not registered yet.** Completing checkout
   won't write the `subscriptions` row, so the poll never resolves on prod. Demo
   the full subscribe loop locally with `stripe listen`.
4. **`CORS_ORIGINS` / `APP_ORIGIN` are placeholder `https://example.com`.** A web
   browser frontend won't pass CORS until these are set to the real site origin,
   and the Stripe success/cancel redirect currently points at `example.com`. The
   **native iOS app is unaffected** — CORS doesn't apply to it. curl/Postman are
   unaffected too.
5. **Email confirmation is required** on the Supabase project — new users need to
   click the emailed link before they can sign in.

---

## Quick reference

| # | User action | Method & path | Auth | Live result |
|---|---|---|---|---|
| 0 | Log in | *(Supabase GoTrue, not this API)* | — | 🟢 200 access_token |
| 1 | Health | `GET /health` | none | 🟢 200 |
| 2 | Browse studios | `GET /studios` | none | 🟢 200 list |
| 3a | Start subscribe | `POST /subscriptions` | ✅ | 🟢 200 `{checkoutUrl: cs_test_…}` |
| 3d | Poll entitlement | `GET /me/subscriptions` | ✅ | 🟢 200 `{subscriptions:[]}` |
| 3e | Cancel | `DELETE /subscriptions/:id` | ✅ | 🧪 200 `{canceled}` |
| 4a | Owner: create upload | `POST /studios/:slug/videos` | ✅ owner | 🧪 201 `{video,uploadUrl,uploadId}` |
| 4b | Owner: send file | `PUT <uploadUrl>` | *(to Mux)* | 200/204 |
| 5a | List videos | `GET /studios/:slug/videos` | ✅ sub/owner | 🟢 403 (unsubscribed) |
| 5b | Get video | `GET /videos/:id` | ✅ sub/owner | 🟢 404 (not entitled) |
| 5c | Play | `https://stream.mux.com/{playback_id}.m3u8` | *(Mux)* | HLS |
| — | Owner's studios | `GET /me/studios` | ✅ | 🟢 200 `{studios:[]}` |
| ⛔ | *(Stripe → backend)* | `POST /webhooks/stripe` | server-only | — |
| ⛔ | *(Mux → backend)* | `POST /webhooks/mux` | server-only | — |

Import `docs/inStudiio.postman_collection.json`, paste your `access_token` into
the `jwt` variable, and click through the same journey.
