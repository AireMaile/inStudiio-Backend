import { Router, type RequestHandler } from 'express';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { supabase } from '../supabase.js';
import { pickPlayback } from '../lib/playbackIds.js';
import type { MuxClient } from '../mux.js';

export interface MuxWebhookDeps {
  mux: Pick<MuxClient, 'webhooks'>;
}

export function createMuxWebhookRouter(deps: MuxWebhookDeps): Router {
  const router = Router();

  const handler: RequestHandler = async (req, res) => {
    const ct = req.header('content-type') ?? '';
    if (!/^application\/json(\s*;|$)/i.test(ct)) {
      res.status(400).json({ error: { code: 'bad_request', message: 'content-type must be application/json' } });
      return;
    }
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

    const passthrough =
      typeof event.data?.passthrough === 'string' ? event.data.passthrough : null;

    // Build the update patch for the event type. Returns null for event types
    // we intentionally don't act on (unknown types, or asset_created without
    // an asset_id — both succeed as acks).
    interface VideoPatch {
      status?: 'preparing' | 'ready' | 'errored';
      mux_asset_id?: string;
      mux_playback_id?: string | null;
      mux_playback_policy?: 'public' | 'signed' | null;
      duration_seconds?: number | null;
      error_message?: string;
      set_media?: boolean;
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
          };
        }
        break;
      }
      case 'video.asset.ready': {
        const ids: unknown[] = Array.isArray(event.data?.playback_ids)
          ? event.data.playback_ids
          : [];
        const playback = pickPlayback(ids);
        const duration = typeof event.data?.duration === 'number' ? event.data.duration : null;
        patch = {
          status: 'ready',
          // Signed preferred; public still honored for pre-migration assets.
          mux_playback_id: playback?.id ?? null,
          mux_playback_policy: playback?.policy ?? null,
          duration_seconds: duration,
          set_media: true,
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

    let videoId: string | undefined;
    if (patch && passthrough) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(passthrough)) {
        logger.error(
          { eventId: event.id, type: event.type, passthrough },
          'mux webhook handled event has invalid passthrough UUID',
        );
        res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
        return;
      }
      videoId = passthrough;
    }

    const { data: result, error: rpcErr } = await supabase.rpc('process_mux_webhook_event', {
      p_event_id: event.id,
      p_event_type: event.type,
      p_video_id: videoId,
      p_status: patch?.status,
      p_mux_asset_id: patch?.mux_asset_id,
      p_error_message: patch?.error_message,
      p_set_media: patch?.set_media,
      p_mux_playback_id: patch?.mux_playback_id ?? undefined,
      p_mux_playback_policy: patch?.mux_playback_policy ?? undefined,
      p_duration_seconds: patch?.duration_seconds ?? undefined,
    });
    if (rpcErr) {
      logger.error(
        { err: rpcErr, eventId: event.id, type: event.type },
        'mux webhook atomic persistence failed',
      );
      res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
      return;
    }

    switch (result) {
      case 'duplicate':
        logger.info({ eventId: event.id }, 'mux webhook duplicate, skipping');
        res.status(200).json({ duplicate: true });
        return;
      case 'no_video':
        logger.warn(
          { eventId: event.id, type: event.type, videoId },
          'mux webhook video not found; event recorded as no-op',
        );
        res.status(200).json({ ok: true });
        return;
      case 'recorded':
        if (!passthrough) {
          logger.warn(
            { eventId: event.id, type: event.type },
            'mux webhook missing passthrough; event recorded as no-op',
          );
          res.status(200).json({ noop: true });
          return;
        }
        res.status(200).json({ ok: true });
        return;
      case 'processed':
        res.status(200).json({ ok: true });
        return;
      default:
        logger.error(
          { eventId: event.id, type: event.type, result },
          'mux webhook atomic persistence returned unknown result',
        );
        res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
        return;
    }
  };

  router.post('/', handler);
  return router;
}
