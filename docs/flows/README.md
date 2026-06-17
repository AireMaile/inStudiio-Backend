# inStudiio — Flow Documentation

Per-flow guides for the inStudiio backend, written for frontend / client devs.
Each flow doc has a **mermaid diagram**, a **step-by-step** with the exact
endpoint + method + auth, and **real example responses** captured against
production.

## The flows

| # | Flow | Who | Doc |
|---|---|---|---|
| 1 | **Authentication** — get a token | Every client | [01-authentication.md](./01-authentication.md) |
| 2 | **Subscribe & Watch** — browse, subscribe, watch videos | Subscriber | [02-subscribe-and-watch.md](./02-subscribe-and-watch.md) |
| 3 | **Owner Upload** — upload videos to a studio | Studio owner | [03-owner-upload.md](./03-owner-upload.md) |
| 4 | **Studio Onboarding** — register a studio | Operator / backend | [04-studio-onboarding.md](./04-studio-onboarding.md) |

> Looking for the single-page version? See [`../FRONTEND_WORKFLOW.md`](../FRONTEND_WORKFLOW.md).
> Setting up locally? See [`../FRONTEND_LOCAL_SETUP.md`](../FRONTEND_LOCAL_SETUP.md).

## How the flows connect

```mermaid
flowchart TD
    A[1. Authentication<br/>get access_token] --> B[2. Subscribe & Watch<br/>subscriber]
    A --> C[3. Owner Upload<br/>studio owner]
    OP[4. Studio Onboarding<br/>operator CLI] -. creates the studio<br/>+ owner account .-> C
    OP -. studio appears in .-> B
    C -. videos become watchable in .-> B
```

## Shared concepts (read once)

### Base URLs

| Piece | Value |
|---|---|
| **API (Vercel, prod)** | `https://in-studiio-backend.vercel.app` |
| **Supabase project (prod)** | `https://iijhljehoqceownoeauu.supabase.co` |
| **Supabase anon key** (public, browser-safe) | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlpamhsamVob3FjZW93bm9lYXV1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4NDA3MTUsImV4cCI6MjA5NTQxNjcxNX0.dXYdlEZB17eE3kzKE-LGoe9Mz4DsYYikqKcGC_b-HZ8` |

### Auth model (one paragraph)

Auth lives in **Supabase, not this backend**. The client signs in with
`@supabase/supabase-js` (anon key) and gets an **access token (JWT)**. Send it on
every authenticated call as `Authorization: Bearer <token>`. The API verifies it
(prod tokens are **ES256**, verified against Supabase's JWKS; legacy **HS256** is
also accepted) and reads the user id from the `sub` claim. There is **no
login/signup endpoint here**, and **no `GET /me`**.

### Error shape (everywhere)

```json
{ "error": { "code": "stable_code", "message": "Human-readable message" } }
```

Branch on `code`; the HTTP status carries the category (400/401/403/404/409/5xx).

### Two roles

| Role | Created by | Can |
|---|---|---|
| **Subscriber** | Supabase sign-up (anon key) | browse, subscribe, watch |
| **Studio owner** | `pnpm onboard:studio` (operator script) | upload videos to **their** studio |

### Endpoint map

| Method | Path | Auth | Flow |
|---|---|---|---|
| `GET` | `/health` | none | — |
| `GET` | `/studios` | none | 2 |
| `POST` | `/subscriptions` | ✅ | 2 |
| `GET` | `/me/subscriptions` | ✅ | 2 |
| `GET` | `/me/subscriptions/:id` | ✅ | 2 |
| `DELETE` | `/subscriptions/:id` | ✅ | 2 |
| `GET` | `/me/studios` | ✅ | 3 |
| `POST` | `/studios/:slug/videos` | ✅ owner | 3 |
| `PATCH` | `/videos/:id` | ✅ owner | 3 |
| `DELETE` | `/videos/:id` | ✅ owner | 3 |
| `GET` | `/studios/:slug/videos` | ✅ sub/owner | 2, 3 |
| `GET` | `/videos/:id` | ✅ sub/owner | 2, 3 |
| ⛔ `POST` | `/webhooks/stripe` | server-only | 2 |
| ⛔ `POST` | `/webhooks/mux` | server-only | 3 |

### Production status (verified 2026-06-16)

| Capability | Prod status |
|---|---|
| Public reads (`/health`, `/studios`) | ✅ works |
| Auth (sign up / confirm / sign in) | ✅ works (email confirmation required) |
| Authenticated reads | ✅ works (ES256 verified) |
| `POST /subscriptions` → checkout URL | ✅ works (Stripe **test mode**, `cs_test_…`) |
| **Completing a paid subscription** | ❌ blocked — prod Stripe webhook not registered (see flow 2) |
| Owner upload | ⚠️ works, but video reaching `ready` depends on the Mux webhook being pointed at prod (unverified — see flow 3) |
| Web-browser CORS | ⚠️ `CORS_ORIGINS`/`APP_ORIGIN` are placeholder `example.com`; native iOS + curl/Postman unaffected |
