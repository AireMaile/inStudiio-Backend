# Captured Stripe webhook payloads

Raw webhook bodies as Stripe actually delivers them. These are reference truth for the test fixtures used in Plan 5+.

## Why this directory exists

Plan 4 shipped with hand-authored Stripe fixtures that *looked* plausible but didn't match real Stripe wire format. That hid a metadata-contract bug (`subscription_data.metadata` written; `session.metadata` read — they're different objects in real Stripe). Plan 5 mandates that high-risk event fixtures derive from captured reality.

See `ClaudeBrain/Plans/2026-04-25-instudiio-plan-5-mvp-hardening.md` §3 Step 1 and §6.5 for the policy.

## Required captures (Plan 5 P0/P1)

- `checkout.session.completed.json` — REQUIRED (highest risk; drove the original bug)
- `customer.subscription.updated.json` — REQUIRED
- `customer.subscription.deleted.json` — REQUIRED (or derived from `.updated`)
- `invoice.payment_succeeded.json` — preferred captured; docs-backed acceptable with declared provenance
- `invoice.payment_failed.json` — preferred captured; docs-backed acceptable with declared provenance

## File format

Each file is a JSON object:

```json
{
  "capturedAt": "2026-04-25T12:34:56.789Z",
  "method": "POST",
  "url": "/webhooks/stripe-capture",
  "headers": { "stripe-signature": "t=...,v1=...", "...": "..." },
  "body": "{\"id\":\"evt_...\",\"type\":\"...\",...}"
}
```

The `body` field is the raw bytes Stripe sent, as a UTF-8 string. Tests should parse `body` to get the event JSON; the wrapper preserves headers (especially `Stripe-Signature`) for any test that wants to exercise real signature verification against the raw bytes.

## How to capture

1. **Set the gate in `.env`:**
   ```
   STRIPE_CAPTURE_ENABLED=true
   ```

2. **Boot the server:**
   ```bash
   pnpm dev
   ```
   You should see: `STRIPE_CAPTURE_ENABLED=true — /webhooks/stripe-capture mounted (dev only)` in the log.

3. **Forward Stripe testmode webhooks to the capture endpoint:**
   ```bash
   stripe listen --forward-to localhost:3000/webhooks/stripe-capture
   ```
   Note the webhook signing secret it prints — you don't need it for capture (signature is not verified at the capture endpoint), but you'll want it later for the real `/webhooks/stripe` tests.

4. **Drive the full lifecycle:**
   - Mint a Checkout Session via your normal flow: `POST /subscriptions` with a real test user + studio (the route already writes both `metadata` and — once Plan 5 P0.1 lands — `subscription_data.metadata`)
   - Open the returned `checkoutUrl` in a browser, pay with test card `4242 4242 4242 4242` (any future expiry, any 3-digit CVC, any zip). This triggers `checkout.session.completed`.
   - Trigger `customer.subscription.updated`:
     ```bash
     stripe subscriptions update <sub_id> --cancel-at-period-end=true
     ```
   - Trigger `invoice.payment_succeeded` (renewal flavor):
     ```bash
     stripe trigger invoice.payment_succeeded
     ```
     Note: triggers may emit `billing_reason: "manual"`; for renewal-shape captures, advance the test clock or use Stripe's [test clock](https://stripe.com/docs/billing/testing/test-clocks) to force `subscription_cycle`.
   - Trigger `invoice.payment_failed`:
     ```bash
     stripe trigger invoice.payment_failed
     ```
   - Trigger `customer.subscription.deleted`:
     ```bash
     stripe subscriptions cancel <sub_id>
     ```

5. **Curate the captures.** The middleware writes timestamped files like `checkout.session.completed.1761480000000.json`. Pick one canonical capture per event type and rename to drop the timestamp:
   ```bash
   cd tests/fixtures/captured
   mv checkout.session.completed.1761480000000.json checkout.session.completed.json
   # ...repeat per event type
   rm *.[0-9]*.json  # remove uncurated timestamped files
   ```

6. **Commit captures in a single dedicated commit:**
   ```bash
   git add tests/fixtures/captured/*.json
   git commit -m "chore(plan5): capture real Stripe testmode webhook payloads"
   ```

7. **Disable the capture gate and remove the scaffolding** before opening the Plan 5 implementation PR:
   - Remove `STRIPE_CAPTURE_ENABLED=true` from `.env`
   - Delete `src/routes/stripeCaptureDev.ts`
   - Remove the `if (process.env.STRIPE_CAPTURE_ENABLED === 'true' ...)` block from `src/index.ts`
   - Captures stay; the middleware does not.

## What to do with captures (next session)

The implementation plan written against these captures will:
- Type each capture's `body` as `Stripe.Event` so TypeScript catches drift
- Build ergonomic test fixtures whose output is asserted structurally compatible with the captured shape (one conformance test, no network)
- Drive all integration tests off the captured-derived fixtures

## PII / secrets in captures

These are testmode-only. Test customers, test cards, fake metadata. No production data. Signing secrets are NOT in the capture body — the `Stripe-Signature` header carries an HMAC, not the secret itself. Safe to commit.

If you accidentally capture against live Stripe — stop, delete the captures, rotate any exposed keys, and only re-capture against testmode.

### Redaction policy for `metadata.user_id` / `metadata.studio_id`

The captured payloads contain real-looking UUIDs in `metadata.user_id` and `metadata.studio_id`. These are **local-only** Supabase auth ids and studio ids — they map to rows in a developer's local DB and grant no access to staging or production. They are not secrets.

That said:
- **Do not capture against staging or shared environments** without redacting these fields first.
- Builders in `tests/fixtures/stripeEvents.ts` override these fields via `structuredClone` — tests never depend on the captured UUIDs, only on the shape. Recapturing with synthetic UUIDs is safe.
- Stripe ids (`sub_*`, `cus_*`, `cs_*`, `evt_*`) are testmode-only by definition and are safe to commit.
