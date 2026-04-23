import { Router, type RequestHandler } from 'express';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { supabase } from '../supabase.js';
import type { MuxClient } from '../mux.js';

export interface MuxWebhookDeps {
  mux: Pick<MuxClient, 'webhooks'>;
}

interface PlaybackId {
  id: string;
  policy: 'public' | 'signed';
}

export function createMuxWebhookRouter(deps: MuxWebhookDeps): Router {
  const router = Router();

  const handler: RequestHandler = async (req, res) => {
    // `express.raw` produces a Buffer; the Mux SDK's unwrap() requires the
    // exact raw JSON string used when signing.
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
    let event: { type: string; id: string; data: any };
    try {
      event = (await deps.mux.webhooks.unwrap(
        rawBody,
        req.headers as Record<string, string | string[]>,
        env.MUX_WEBHOOK_SECRET,
      )) as any;
    } catch (err) {
      logger.warn({ err }, 'mux webhook signature rejected');
      res
        .status(400)
        .json({ error: { code: 'invalid_signature', message: 'invalid webhook signature' } });
      return;
    }

    // Idempotency: try to record the event_id. If it's a duplicate, short-circuit.
    const { data: ledger, error: ledgerErr } = await supabase
      .from('mux_webhook_events')
      .insert({ event_id: event.id, event_type: event.type })
      .select('event_id')
      .maybeSingle();
    if (ledgerErr) {
      // Unique-violation on event_id means "already processed" — treat as success.
      if ((ledgerErr as any).code === '23505') {
        logger.info({ eventId: event.id }, 'mux webhook duplicate (ledger conflict), skipping');
        res.status(200).json({ duplicate: true });
        return;
      }
      logger.error({ err: ledgerErr, eventId: event.id }, 'mux webhook ledger insert failed');
      res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
      return;
    }
    if (!ledger) {
      logger.info({ eventId: event.id }, 'mux webhook duplicate (no ledger row returned), skipping');
      res.status(200).json({ duplicate: true });
      return;
    }

    const passthrough =
      typeof event.data?.passthrough === 'string' ? event.data.passthrough : null;
    if (!passthrough) {
      logger.warn(
        { eventId: event.id, type: event.type },
        'mux webhook missing passthrough; no-op',
      );
      res.status(200).json({ noop: true });
      return;
    }

    // Build the update patch for the event type. Returns null for event types
    // we intentionally don't act on (unknown types, or asset_created without
    // an asset_id — both succeed as acks).
    interface VideoPatch {
      status?: 'preparing' | 'ready' | 'errored';
      mux_asset_id?: string;
      mux_playback_id?: string | null;
      duration_seconds?: number | null;
      error_message?: string;
      updated_at: string;
    }
    let patch: VideoPatch | null = null;
    switch (event.type) {
      case 'video.upload.asset_created': {
        // `data` is the Mux Upload resource; the newly-created asset's id is
        // at `data.asset_id` (NOT `data.id`, which is the Upload's own id).
        const assetId =
          typeof event.data?.asset_id === 'string' ? event.data.asset_id : null;
        if (assetId) {
          patch = {
            status: 'preparing',
            mux_asset_id: assetId,
            updated_at: new Date().toISOString(),
          };
        }
        break;
      }
      case 'video.asset.ready': {
        const ids: PlaybackId[] = Array.isArray(event.data?.playback_ids)
          ? event.data.playback_ids
          : [];
        const publicId = ids.find((p) => p.policy === 'public')?.id ?? null;
        const duration = typeof event.data?.duration === 'number' ? event.data.duration : null;
        patch = {
          status: 'ready',
          mux_playback_id: publicId,
          duration_seconds: duration,
          updated_at: new Date().toISOString(),
        };
        break;
      }
      case 'video.asset.errored': {
        const errs: Array<{ messages?: string[] }> = Array.isArray(event.data?.errors)
          ? event.data.errors
          : [];
        const message =
          errs.flatMap((e) => (Array.isArray(e.messages) ? e.messages : [])).join('; ') ||
          'unknown mux error';
        patch = {
          status: 'errored',
          error_message: message,
          updated_at: new Date().toISOString(),
        };
        break;
      }
      default:
        // Other event types are logged and acknowledged — no row update.
        logger.info(
          { eventId: event.id, type: event.type },
          'mux webhook: unhandled event type',
        );
        break;
    }

    if (patch) {
      const { error: updateErr } = await supabase
        .from('videos')
        .update(patch)
        .eq('id', passthrough);
      if (updateErr) {
        // The DB update failed AFTER we already persisted the ledger row.
        // Roll the ledger back so Mux's retry will be re-processed rather
        // than short-circuited as a duplicate, then return 500 so Mux retries.
        logger.error(
          { err: updateErr, eventId: event.id, type: event.type },
          'mux webhook: videos update failed; rolling back ledger row',
        );
        const { error: rollbackErr } = await supabase
          .from('mux_webhook_events')
          .delete()
          .eq('event_id', event.id);
        if (rollbackErr) {
          logger.error(
            { err: rollbackErr, eventId: event.id },
            'mux webhook: ledger rollback failed; event will be skipped on retry',
          );
        }
        res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
        return;
      }
    }

    res.status(200).json({ ok: true });
  };

  router.post('/', handler);
  return router;
}
