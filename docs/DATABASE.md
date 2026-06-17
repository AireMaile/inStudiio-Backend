# Database Schema

inStudiio uses **Supabase** (hosted PostgreSQL) with migrations managed in `supabase/migrations/`. All writes go through the Express API using the **service-role key** (bypasses RLS). RLS policies are SELECT-only for direct Supabase client access.

## Tables

### `profiles`

Mirrors `auth.users`. Auto-populated by a trigger on user signup.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `uuid` | PK, FK → `auth.users(id)` ON DELETE CASCADE | Supabase auth user ID |
| `email` | `text` | NOT NULL | User's email address |
| `stripe_customer_id` | `text` | nullable | Stripe customer ID (set on first checkout) |
| `created_at` | `timestamptz` | NOT NULL, default `now()` | |

**RLS:** User can read only their own profile (`id = auth.uid()`).

---

### `studios`

Content creator channels. Each studio has one owner and a Stripe product/price pair for subscriptions.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `uuid` | PK, default `gen_random_uuid()` | |
| `name` | `text` | NOT NULL | Display name |
| `slug` | `text` | UNIQUE, NOT NULL | URL-safe identifier |
| `description` | `text` | nullable | |
| `price_monthly` | `numeric` | NOT NULL, default `9.99` | Subscription price |
| `stripe_product_id` | `text` | NOT NULL | Stripe product ID |
| `stripe_price_id` | `text` | NOT NULL | Stripe price ID |
| `owner_user_id` | `uuid` | NOT NULL, FK → `profiles(id)` | Studio owner |
| `created_at` | `timestamptz` | NOT NULL, default `now()` | |

**RLS:** Public read access (anyone can browse the catalog).

---

### `subscriptions`

Links a user to a studio via a Stripe subscription. One subscription per user-studio pair.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `uuid` | PK, default `gen_random_uuid()` | |
| `user_id` | `uuid` | NOT NULL, FK → `profiles(id)` ON DELETE CASCADE | Subscriber |
| `studio_id` | `uuid` | NOT NULL, FK → `studios(id)` ON DELETE CASCADE | Subscribed studio |
| `stripe_subscription_id` | `text` | UNIQUE, NOT NULL | Stripe subscription ID |
| `stripe_customer_id` | `text` | NOT NULL | Stripe customer ID |
| `status` | `text` | NOT NULL, CHECK `('active','past_due','canceled','incomplete')` | Normalized via `mapStripeStatus()` |
| `current_period_start` | `timestamptz` | NOT NULL | Billing period start |
| `current_period_end` | `timestamptz` | NOT NULL | Billing period end |
| `cancel_at_period_end` | `boolean` | NOT NULL, default `false` | If true, cancels at period end |
| `created_at` | `timestamptz` | NOT NULL, default `now()` | |

**Unique constraint:** `(user_id, studio_id)` — one subscription per user per studio.

**Indexes:** `user_id`, `studio_id`.

**RLS:** User can read only their own subscriptions (`user_id = auth.uid()`).

**Note:** Stripe sends statuses like `trialing`, `unpaid`, `paused`, `incomplete_expired` that don't match the CHECK constraint. The `mapStripeStatus()` helper (`src/lib/stripeStatus.ts`) normalizes these before DB writes.

---

### `videos`

Video content belonging to a studio. Mirrors Mux asset lifecycle state.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `uuid` | PK, default `gen_random_uuid()` | Also used as Mux `passthrough` to link webhooks back |
| `studio_id` | `uuid` | NOT NULL, FK → `studios(id)` ON DELETE CASCADE | Parent studio |
| `title` | `text` | NOT NULL | |
| `description` | `text` | nullable | |
| `status` | `text` | NOT NULL, CHECK `('waiting','preparing','ready','errored')`, default `'waiting'` | Mux processing state |
| `mux_upload_id` | `text` | nullable | Mux direct upload ID |
| `mux_asset_id` | `text` | nullable | Mux asset ID (set by `video.upload.asset_created` webhook) |
| `mux_playback_id` | `text` | nullable | Mux public playback ID (set by `video.asset.ready` webhook) |
| `duration_seconds` | `numeric` | nullable | Video duration (set by `video.asset.ready` webhook) |
| `error_message` | `text` | nullable | Error details (set by `video.asset.errored` webhook) |
| `created_at` | `timestamptz` | NOT NULL, default `now()` | |
| `updated_at` | `timestamptz` | NOT NULL, default `now()` | Maintained by application code |

**Index:** `(studio_id, created_at DESC)` for paginated listing.

**RLS:** Public read access (access control enforced at the route layer).

**Video lifecycle:**
1. `waiting` — row created, Mux upload URL issued, file not yet uploaded
2. `preparing` — file uploaded, Mux is encoding (`video.upload.asset_created` webhook)
3. `ready` — encoding complete, playback ID available (`video.asset.ready` webhook)
4. `errored` — encoding failed (`video.asset.errored` webhook)

---

### `mux_webhook_events`

Idempotency ledger for Mux webhook deliveries. Prevents duplicate processing on retries.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `event_id` | `text` | PK | Mux event ID |
| `event_type` | `text` | NOT NULL | e.g. `video.asset.ready` |
| `received_at` | `timestamptz` | NOT NULL, default `now()` | |

**RLS:** Enabled, no policies. Only service-role access.

---

### `stripe_webhook_events`

Idempotency ledger for Stripe webhook deliveries. Prevents duplicate processing on retries.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `event_id` | `text` | PK | Stripe event ID |
| `event_type` | `text` | NOT NULL | e.g. `checkout.session.completed` |
| `received_at` | `timestamptz` | NOT NULL, default `now()` | |

**RLS:** Enabled, no policies. Only service-role access.

---

## Triggers

### `on_auth_user_created`

Fires after INSERT on `auth.users`. Creates a matching `profiles` row with the user's `id` and `email`.

### `on_auth_user_updated`

Fires after UPDATE of `email` on `auth.users`. Syncs the email change to `profiles.email`.

---

## Relationships

```
auth.users
    │
    ▼ (trigger creates profile)
profiles
    │
    ├──── owner_user_id ────▶ studios
    │                            │
    │                            ├──── studio_id ────▶ videos
    │                            │
    └──── user_id ──┐            │
                    ▼            │
              subscriptions ◀────┘
                (user_id, studio_id) UNIQUE
```

## Migrations

Located in `supabase/migrations/`, applied in order:

| File | Description |
|------|-------------|
| `0001_schema.sql` | Initial tables: profiles, studios, subscriptions, videos (legacy Cloudflare) |
| `0002_triggers.sql` | Auth user sync triggers (profile creation + email update) |
| `0003_rls.sql` | Row-level security policies (SELECT-only) |
| `0004_owner_user_id_not_null.sql` | Makes `studios.owner_user_id` NOT NULL |
| `0005_videos.sql` | Replaces legacy videos table with Mux-centric schema |
| `0006_mux_webhook_events.sql` | Mux webhook idempotency ledger |
| `0007_stripe_webhook_events.sql` | Stripe webhook idempotency ledger |
