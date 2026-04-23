import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { env } from '../env.js';
import { requireAuth } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import { hasActiveSubscription } from '../lib/access.js';
import type { MuxClient } from '../mux.js';

const VIDEO_FIELDS =
  'id, studio_id, title, description, status, mux_playback_id, duration_seconds, error_message, created_at' as const;

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
});

const PatchBody = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(5000).optional(),
  })
  .refine((v) => v.title !== undefined || v.description !== undefined, {
    message: 'at least one of title or description is required',
  });

export interface VideosDeps {
  mux: Pick<MuxClient, 'video'>;
}

export function createVideosRouter(deps: VideosDeps): Router {
  const router = Router();

  async function loadOwnedVideo(userId: string, videoId: string) {
    const { data, error } = await supabase
      .from('videos')
      .select('id, studio_id, mux_asset_id, studios!inner(owner_user_id)')
      .eq('id', videoId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new ApiError(404, 'not_found', 'video not found');
    const studio = Array.isArray(data.studios) ? data.studios[0] : (data.studios as any);
    if (studio.owner_user_id !== userId) {
      throw new ApiError(403, 'forbidden', 'not the owner of this video');
    }
    return {
      id: data.id,
      studio_id: data.studio_id,
      mux_asset_id: data.mux_asset_id as string | null,
    };
  }

  const createVideo: RequestHandler = async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'unauthorized', 'authentication required');

      const slug = String(req.params.slug ?? '');
      const { data: studio, error: studioErr } = await supabase
        .from('studios')
        .select('id, owner_user_id')
        .eq('slug', slug)
        .maybeSingle();
      if (studioErr) throw studioErr;
      if (!studio) throw new ApiError(404, 'not_found', 'studio not found');
      if (studio.owner_user_id !== req.user.id) {
        throw new ApiError(403, 'forbidden', 'not the owner of this studio');
      }

      const parsed = CreateBody.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(400, 'bad_request', parsed.error.issues[0]?.message ?? 'invalid body');
      }

      // 1. Insert row in 'waiting' to obtain the UUID we pass as Mux passthrough.
      const { data: inserted, error: insertErr } = await supabase
        .from('videos')
        .insert({
          studio_id: studio.id,
          title: parsed.data.title,
          description: parsed.data.description ?? null,
          status: 'waiting',
        })
        .select('id')
        .single();
      if (insertErr || !inserted) throw insertErr ?? new Error('videos insert returned no row');

      // 2. Create Mux direct upload.
      const corsOrigin = env.APP_ORIGIN ?? '*';
      let upload: { id: string; url: string };
      try {
        upload = (await deps.mux.video.uploads.create({
          cors_origin: corsOrigin,
          test: env.NODE_ENV !== 'production',
          new_asset_settings: {
            playback_policies: ['public'],
            video_quality: 'basic',
            max_resolution_tier: '1080p',
            mp4_support: 'capped-1080p',
            passthrough: inserted.id,
          },
        } as any)) as { id: string; url: string };
      } catch (muxErr) {
        req.log?.error({ err: muxErr, videoId: inserted.id }, 'mux uploads.create failed');
        throw new ApiError(502, 'upstream_unavailable', 'upload service unavailable');
      }

      // 3. Persist Mux upload id; fetch the whitelisted projection for the response.
      const { data: updated, error: updateErr } = await supabase
        .from('videos')
        .update({ mux_upload_id: upload.id, updated_at: new Date().toISOString() })
        .eq('id', inserted.id)
        .select(VIDEO_FIELDS)
        .single();
      if (updateErr || !updated) throw updateErr ?? new Error('videos update returned no row');

      res.status(201).json({ video: updated, uploadUrl: upload.url, uploadId: upload.id });
    } catch (err) {
      next(err);
    }
  };

  const patchVideo: RequestHandler = async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'unauthorized', 'authentication required');
      const videoId = String(req.params.id ?? '');
      await loadOwnedVideo(req.user.id, videoId);
      const parsed = PatchBody.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(400, 'bad_request', parsed.error.issues[0]?.message ?? 'invalid body');
      }
      const patch: { updated_at: string; title?: string; description?: string } = {
        updated_at: new Date().toISOString(),
      };
      if (parsed.data.title !== undefined) patch.title = parsed.data.title;
      if (parsed.data.description !== undefined) patch.description = parsed.data.description;

      const { data: updated, error: updateErr } = await supabase
        .from('videos')
        .update(patch)
        .eq('id', videoId)
        .select(VIDEO_FIELDS)
        .single();
      if (updateErr || !updated) throw updateErr ?? new Error('update returned no row');
      res.status(200).json({ video: updated });
    } catch (err) {
      next(err);
    }
  };

  const deleteVideo: RequestHandler = async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'unauthorized', 'authentication required');
      const videoId = String(req.params.id ?? '');
      const vid = await loadOwnedVideo(req.user.id, videoId);

      if (vid.mux_asset_id) {
        try {
          await deps.mux.video.assets.delete(vid.mux_asset_id);
        } catch (muxErr) {
          req.log?.warn(
            { err: muxErr, assetId: vid.mux_asset_id },
            'mux assets.delete failed; continuing',
          );
        }
      }

      const { error: delErr } = await supabase.from('videos').delete().eq('id', videoId);
      if (delErr) throw delErr;
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  };

  const listVideos: RequestHandler = async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'unauthorized', 'authentication required');
      const slug = String(req.params.slug ?? '');
      const { data: studio, error: studioErr } = await supabase
        .from('studios')
        .select('id, owner_user_id')
        .eq('slug', slug)
        .maybeSingle();
      if (studioErr) throw studioErr;
      if (!studio) throw new ApiError(404, 'not_found', 'studio not found');

      const isOwner = studio.owner_user_id === req.user.id;
      if (!isOwner) {
        const subscribed = await hasActiveSubscription({ supabase }, req.user.id, studio.id);
        if (!subscribed) throw new ApiError(403, 'forbidden', 'subscription required');
      }

      let q = supabase
        .from('videos')
        .select(VIDEO_FIELDS)
        .eq('studio_id', studio.id)
        .order('created_at', { ascending: false });
      if (!isOwner) q = q.eq('status', 'ready');
      const { data, error } = await q;
      if (error) throw error;
      res.status(200).json({ videos: data ?? [] });
    } catch (err) {
      next(err);
    }
  };

  const getVideo: RequestHandler = async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'unauthorized', 'authentication required');
      const videoId = String(req.params.id ?? '');
      const { data: row, error } = await supabase
        .from('videos')
        .select(`${VIDEO_FIELDS}, studios!inner(owner_user_id)`)
        .eq('id', videoId)
        .maybeSingle();
      if (error) throw error;
      if (!row) throw new ApiError(404, 'not_found', 'video not found');
      const studio = Array.isArray((row as any).studios)
        ? (row as any).studios[0]
        : (row as any).studios;
      const isOwner = studio.owner_user_id === req.user.id;
      if (!isOwner) {
        const subscribed = await hasActiveSubscription(
          { supabase },
          req.user.id,
          (row as any).studio_id,
        );
        if (!subscribed) throw new ApiError(403, 'forbidden', 'subscription required');
        if ((row as any).status !== 'ready') throw new ApiError(404, 'not_found', 'video not found');
      }
      const { studios: _omit, ...video } = row as any;
      res.status(200).json({ video });
    } catch (err) {
      next(err);
    }
  };

  router.post('/studios/:slug/videos', requireAuth, createVideo);
  router.patch('/videos/:id', requireAuth, patchVideo);
  router.delete('/videos/:id', requireAuth, deleteVideo);
  router.get('/studios/:slug/videos', requireAuth, listVideos);
  router.get('/videos/:id', requireAuth, getVideo);

  return router;
}
