# Mux playback reconciliation runbook

The reconciliation worker repairs signed `video.asset.ready` deliveries that
do not contain a usable playback ID. The webhook only persists durable work;
the worker reads Mux and commits its result through lease-fenced database RPCs.

## Release order

1. Apply only migration `0012_mux_playback_reconciliation.sql` using the
   predeploy mechanics below. Do not run a normal `supabase db push` yet.
2. Set the same strong random `CRON_SECRET` in Vercel Production and Supabase
   Vault. Do not commit the value.
3. Deploy the backend and verify `POST /internal/jobs/mux-reconciliation`
   rejects missing/wrong authorization and succeeds with the secret.
4. Create the Supabase Cron schedule below and verify a controlled workflow is
   claimed and finished.
5. Review the production audit queries. Then apply the separately gated
   `0013_videos_ready_requires_playback.sql` migration.

An application rollback does not remove the database schedule. Disable the
schedule separately before rolling back if the deployed endpoint is unhealthy.

## Predeploy migration mechanics

Both 0012 and 0013 are intentionally versioned in this branch so the final
schema and generated types can be tested together. Consequently, a standard
`supabase db push` while both are pending would apply both and violate the
release gate. **Do not use `db push` for the predeploy migration.**

Apply exactly 0012 through a direct production PostgreSQL connection. Keep the
connection string out of shell history and logs:

```bash
psql "$SUPABASE_DB_URL" \
  --set ON_ERROR_STOP=1 \
  --single-transaction \
  --file supabase/migrations/0012_mux_playback_reconciliation.sql

supabase migration repair 0012 --status applied --linked
supabase db push --linked --dry-run
```

The dry run must report **only**
`0013_videos_ready_requires_playback.sql` as pending. If it reports 0012,
anything earlier, or no pending 0013, stop and inspect migration history. Do
not repair history unless the corresponding SQL was successfully applied and
verified.

After the 0012-aware application is deployed, the authenticated scheduler has
completed a controlled enqueue/claim/finish cycle, and the audit is approved,
run another dry run and then apply the single remaining migration:

```bash
supabase db push --linked --dry-run
supabase db push --linked
```

Confirm the interactive plan contains only 0013 before approving it. This is
the only point in the release where a linked `db push` is permitted.

## Scheduler configuration

The production project is on Vercel Hobby, whose native cron cadence is not
frequent enough for this workflow. Supabase Cron invokes the authenticated
endpoint every five minutes; `next_attempt_at` remains the authority for when
individual rows are eligible.

Enable the `pg_cron`, `pg_net`, and Vault extensions, then create two Vault
secrets in the Supabase dashboard:

- `mux_reconciliation_url` =
  `https://in-studiio-backend.vercel.app/internal/jobs/mux-reconciliation`
- `mux_reconciliation_cron_secret` = the exact Vercel `CRON_SECRET`

Create the schedule once:

```sql
select cron.schedule(
  'mux-playback-reconciliation',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'mux_reconciliation_url'
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'mux_reconciliation_cron_secret'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);
```

Verify or disable it with:

```sql
select jobid, jobname, schedule, active
from cron.job
where jobname = 'mux-playback-reconciliation';

select cron.unschedule('mux-playback-reconciliation');
```

## Monitoring

```sql
select state, count(*)
from public.mux_playback_reconciliations
group by state
order by state;

select
  min(next_attempt_at) filter (where state = 'pending') as oldest_due,
  count(*) filter (
    where state = 'leased' and lease_expires_at <= now()
  ) as expired_leases,
  max(reopen_count) as max_reopen_count
from public.mux_playback_reconciliations;

select id, video_id, mux_asset_id, state, attempt_count,
       infra_attempt_count, not_found_attempt_count, last_error_class,
       last_error_code, last_error_message, updated_at
from public.mux_playback_reconciliations
where state in ('blocked', 'failed')
order by updated_at desc;
```

Review recent scheduler requests:

```sql
select id, status_code, timed_out, error_msg, created
from net._http_response
order by created desc
limit 20;
```

## Blocked recovery

Only `blocked` workflows can be manually requeued. First resolve the reported
infrastructure or integrity condition, then run:

```sql
select public.requeue_mux_playback_reconciliation('<job-id>'::uuid);
```

Expected results are `requeued`, `already_resolved`, or `obsolete`.
`not_requeueable` means the row is not operationally blocked. Failed content
work requires new signed upstream evidence or a separately reviewed recovery
procedure; do not mutate it directly.
