# inStudiio Backend — Local Setup for Frontend Devs

This guide gets the API running on `http://localhost:3000` so your frontend
(Vite, Next.js, etc.) can integrate against it without deploying anything.

**You will not need:** a deploy target, a public URL, AWS, or production
credentials. Everything runs on your laptop.

**You will need:** a Stripe testmode account (free), a Mux account (free
tier OK), and Docker.

---

## 1. Prerequisites

Install these once if you don't already have them:

| Tool | Why | Install |
|---|---|---|
| **Node 20+** | Runs the API | https://nodejs.org or `brew install node@20` |
| **Docker Desktop** | Hosts local Supabase | https://www.docker.com/products/docker-desktop/ |
| **Supabase CLI** | Boots local Supabase | `brew install supabase/tap/supabase` |
| **Stripe CLI** | Forwards Stripe webhooks to localhost | `brew install stripe/stripe-cli/stripe` |
| **pnpm 9** | Package manager | `corepack prepare pnpm@9.15.0 --activate` |

Verify:

```bash
node --version       # should be >= v20
pnpm --version       # should be 9.x
docker ps            # should not error
supabase --version
stripe --version
```

---

## 2. Clone and install

```bash
git clone https://github.com/AireMaile/inStudiio-Backend.git
cd inStudiio-Backend
pnpm install
```

---

## 3. Boot local Supabase

This spins up Postgres, Auth, Storage, and the Studio UI in Docker
containers. First boot takes 1–2 minutes; subsequent boots are fast.

```bash
supabase start
```

When it finishes, **copy the values it prints** — you'll paste them into
`.env` next:

- `API URL` → `SUPABASE_URL`
- `service_role key` → `SUPABASE_SERVICE_ROLE_KEY`
- `JWT secret` → `SUPABASE_JWT_SECRET`

You can also re-print them anytime with `supabase status`.

The Studio UI is at http://127.0.0.1:54323 — useful for browsing tables.

---

## 4. Create your `.env` file

```bash
cp .env.example .env
```

Open `.env` and fill in:

### Supabase (from `supabase status`)

```
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=<paste from supabase status>
SUPABASE_JWT_SECRET=<paste from supabase status>
```

### Stripe (testmode only — never use live keys locally)

Get from https://dashboard.stripe.com/test/apikeys :

```
STRIPE_SECRET_KEY=sk_test_...
```

Leave `STRIPE_WEBHOOK_SECRET` blank for now — you'll fill it in step 6.

### Mux (free tier is fine)

Create access token at https://dashboard.mux.com/settings/access-tokens :

```
MUX_TOKEN_ID=...
MUX_TOKEN_SECRET=...
MUX_WEBHOOK_SECRET=  # leave blank unless testing Mux webhooks
```

### Server

```
PORT=3000
NODE_ENV=development
APP_ORIGIN=http://localhost:5173    # ← set to YOUR frontend dev URL
CORS_ORIGINS=                       # leave blank in dev (allows all origins)
```

> **Why `APP_ORIGIN`?** Stripe redirects users back to
> `${APP_ORIGIN}/subscribe/success?session_id=…` after checkout. Set this
> to the URL your frontend runs on.

---

## 5. Run database migrations

The first time you boot Supabase, the schema is empty. Apply migrations:

```bash
supabase db reset
```

This drops everything and re-runs every migration in `supabase/migrations/`.
Safe — you have no real data yet.

---

## 6. Set up Stripe webhook forwarding

The backend uses Stripe webhooks to update subscription state after
checkout. You need the Stripe CLI to forward testmode webhooks from
Stripe's servers to your localhost:

In **Terminal 1** (leave it running while you develop):

```bash
stripe login           # one-time auth in your browser
stripe listen --forward-to localhost:3000/webhooks/stripe
```

When it starts, **copy the line that says**:

```
> Ready! Your webhook signing secret is whsec_abc123... (^C to quit)
```

Paste that secret into `.env`:

```
STRIPE_WEBHOOK_SECRET=whsec_abc123...
```

> The signing secret is per-CLI-session. If you restart `stripe listen`
> you'll get a new one — just update `.env` and restart the API.

---

## 7. Boot the API

In **Terminal 2**:

```bash
pnpm dev
```

You should see:

```
{"level":30,"msg":"server listening","port":3000}
```

Verify it's healthy:

```bash
curl http://localhost:3000/health
# → {"ok":true}
```

---

## 8. Get a JWT for testing

The API expects `Authorization: Bearer <jwt>` on most endpoints. Two ways
to get one for local testing:

### Option A: Through your frontend's Supabase auth client (preferred)

Your frontend uses `@supabase/supabase-js`:

```ts
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'http://127.0.0.1:54321',
  '<the SUPABASE_ANON_KEY from `supabase status`>',
);

await supabase.auth.signUp({ email: 'test@example.com', password: 'testtest' });
const { data: { session } } = await supabase.auth.getSession();
const jwt = session?.access_token;   // pass this in Authorization header
```

> Use the **anon key** in your frontend, NOT the service-role key. The
> anon key is safe to ship to the browser.

### Option B: Manually mint a test user via the helper script

```bash
pnpm tsx scripts/mint-test-subscriber.ts
```

It prints a JWT and a ready-to-paste curl command for `POST /subscriptions`.

---

## 9. Try the API end-to-end

With Supabase up, the API running, and a JWT:

```bash
JWT="ey..."

# Get current user
curl http://localhost:3000/me -H "Authorization: Bearer $JWT"

# List public studios
curl http://localhost:3000/studios

# Create a Checkout Session (returns a stripe.com URL to open)
curl -X POST http://localhost:3000/subscriptions \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"studioId":"<a studio uuid>"}'
```

To get a `studioId`, either browse the `studios` table in
http://127.0.0.1:54323 or onboard a test studio:

```bash
pnpm onboard:studio
```

---

## 10. The full subscribe flow (what your frontend will do)

1. User clicks "Subscribe" → frontend calls `POST /subscriptions` with
   `{ studioId }` and the JWT
2. Backend returns `{ checkoutUrl }`
3. Frontend redirects browser to `checkoutUrl`
4. User pays with test card `4242 4242 4242 4242` (any future expiry,
   any CVC, any zip)
5. Stripe redirects back to `${APP_ORIGIN}/subscribe/success?session_id=…`
6. Stripe sends `checkout.session.completed` webhook to the backend
   (forwarded by `stripe listen`)
7. Backend writes a row in the `subscriptions` table
8. Frontend polls `GET /me/subscriptions` until the row shows up
   (typically <2 seconds)

If step 7 doesn't fire, check the `stripe listen` terminal — Stripe
prints every event it forwards.

---

## API surface (current)

All routes return JSON. Errors follow `{ error: { code, message } }`.

### Public (no auth)

- `GET /health` — liveness
- `GET /studios` — list public studios
- `GET /studios/:slug` — single studio by slug

### Authenticated (`Authorization: Bearer <jwt>`)

- `GET /me` — current user profile
- `GET /me/studios` — studios owned by current user
- `GET /me/subscriptions` — current user's subscriptions
- `POST /subscriptions` `{ studioId }` → `{ checkoutUrl }`
- `DELETE /subscriptions/:id` → `{ canceled, cancelAtPeriodEnd }`
- `POST /studios/:slug/videos` `{ title, description? }` (owner only) → Mux direct-upload URL
- `PATCH /videos/:id` (owner only)
- `DELETE /videos/:id` (owner only)
- `GET /studios/:slug/videos` — list videos in a studio
- `GET /videos/:id` — single video (subscribers + owner only for
  non-public statuses)

### Server-only (don't call from the frontend)

- `POST /webhooks/stripe` — Stripe webhook receiver
- `POST /webhooks/mux` — Mux webhook receiver

---

## Common gotchas

**"CORS error"** — you set `APP_ORIGIN` but not `CORS_ORIGINS`. In dev,
leave `CORS_ORIGINS` blank to allow all origins. Or set it explicitly:
`CORS_ORIGINS=http://localhost:5173`.

**"Invalid signature" on Stripe webhooks** — your `.env` has a stale
`STRIPE_WEBHOOK_SECRET`. Restart `stripe listen` and copy the new
`whsec_…`.

**"Authorization required" / 401** — JWT is missing, malformed, or
expired. Supabase JWTs default to 1-hour TTL. Refresh via your frontend's
Supabase client.

**`supabase start` hangs** — Docker isn't running. Open Docker Desktop,
wait for the whale icon to settle, retry.

**`pnpm install --frozen-lockfile` fails on a teammate's machine** —
they're on a pnpm version mismatch. Run
`corepack prepare pnpm@9.15.0 --activate` once, then re-run install.

**Subscription created in Stripe but no row in DB** — `stripe listen`
isn't running, or webhook secret is wrong. Check Terminal 1.

---

## Reset everything

If your local DB gets weird:

```bash
supabase db reset      # drops + re-migrates the local DB
```

If Supabase containers get weird:

```bash
supabase stop
supabase start
```

---

## Need help?

Ping the backend team with:
- Output of `supabase status`
- Last 50 lines of the API server log
- Last 20 lines of the `stripe listen` terminal
- The exact request you sent (curl/fetch) and the response you got
