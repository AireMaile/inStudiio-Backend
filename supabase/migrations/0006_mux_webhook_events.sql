-- Idempotency ledger for Mux webhook deliveries.
-- Handler inserts (event_id, event_type) with ON CONFLICT DO NOTHING — duplicates no-op.
create table public.mux_webhook_events (
  event_id text primary key,
  event_type text not null,
  received_at timestamptz not null default now()
);

alter table public.mux_webhook_events enable row level security;
-- No policies: only service-role (which bypasses RLS) should ever touch this table.
