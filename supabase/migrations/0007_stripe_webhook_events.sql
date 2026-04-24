-- Idempotency ledger for Stripe webhook deliveries.
-- Handler inserts (event_id, event_type); unique-violation on retry → short-circuit as duplicate.
create table public.stripe_webhook_events (
  event_id   text primary key,
  event_type text not null,
  received_at timestamptz not null default now()
);

alter table public.stripe_webhook_events enable row level security;
-- No policies: only service-role (which bypasses RLS) should ever touch this table.
