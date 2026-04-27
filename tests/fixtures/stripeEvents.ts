import type Stripe from 'stripe';
import { loadCapture } from './loadCapture.js';

/**
 * Plan 5 P0.1 + §6.5 fixture provenance: every builder below derives from
 * a captured testmode payload in tests/fixtures/captured/. Overrides only
 * mutate the fields tests need to control (ids, metadata, status, period);
 * all other wire shape is preserved verbatim from real Stripe deliveries.
 *
 * Plan 5 forbids hand-authored fixtures (category c per §6.5). If you need
 * a new event type, capture it via the runbook in
 * tests/fixtures/captured/README.md and add a builder here that derives
 * from the new file.
 */

const rand = () => Math.random().toString(36).slice(2, 8);

export function checkoutSessionCompleted(opts: {
  userId: string;
  studioId: string;
  subId?: string;
  custId?: string;
  eventId?: string;
}): Stripe.Event {
  const { event } = loadCapture('checkout.session.completed');
  const cloned = structuredClone(event);
  cloned.id = opts.eventId ?? `evt_p5wh_cs_${rand()}`;
  const obj = cloned.data.object as { metadata?: Record<string, string>; subscription?: string; customer?: string };
  // Inject test-controlled metadata. The captured shape has session.metadata
  // populated empty {} (Plan 4 bug); Plan 5 P0.1 fixes the create call to
  // write user_id/studio_id here, so test fixtures should reflect that.
  obj.metadata = { user_id: opts.userId, studio_id: opts.studioId };
  if (opts.subId) obj.subscription = opts.subId;
  if (opts.custId) obj.customer = opts.custId;
  return cloned;
}

export function customerSubscriptionUpdated(opts: {
  subId: string;
  status: 'active' | 'past_due' | 'canceled' | 'incomplete';
  cancelAtPeriodEnd: boolean;
  periodStart?: number;
  periodEnd?: number;
  eventId?: string;
}): Stripe.Event {
  const { event } = loadCapture('customer.subscription.updated');
  const cloned = structuredClone(event);
  cloned.id = opts.eventId ?? `evt_p5wh_sub_upd_${rand()}`;
  const obj = cloned.data.object as {
    id: string;
    status: string;
    cancel_at_period_end: boolean;
    items?: { data?: Array<{ current_period_start?: number; current_period_end?: number }> };
  };
  obj.id = opts.subId;
  obj.status = opts.status;
  obj.cancel_at_period_end = opts.cancelAtPeriodEnd;
  // Plan 5 P0.1: in Stripe API 2026-03-25.dahlia, period fields live at
  // items.data[0]. Override only when caller provided values.
  const item = obj.items?.data?.[0];
  if (item) {
    if (opts.periodStart !== undefined) item.current_period_start = opts.periodStart;
    if (opts.periodEnd !== undefined) item.current_period_end = opts.periodEnd;
  }
  return cloned;
}

export function customerSubscriptionDeleted(opts: { subId: string; eventId?: string }): Stripe.Event {
  const { event } = loadCapture('customer.subscription.deleted');
  const cloned = structuredClone(event);
  cloned.id = opts.eventId ?? `evt_p5wh_sub_del_${rand()}`;
  (cloned.data.object as { id: string }).id = opts.subId;
  return cloned;
}

export function invoicePaymentSucceeded(opts: {
  subId: string;
  billingReason: 'subscription_cycle' | 'subscription_create' | string;
  periodStart?: number;
  periodEnd?: number;
  eventId?: string;
}): Stripe.Event {
  const { event } = loadCapture('invoice.payment_succeeded');
  const cloned = structuredClone(event);
  cloned.id = opts.eventId ?? `evt_p5wh_inv_ok_${rand()}`;
  const obj = cloned.data.object as {
    billing_reason?: string;
    parent?: {
      subscription_details?: {
        subscription?: string;
        metadata?: Record<string, string> | null;
      };
    };
    lines?: {
      data?: Array<{
        period?: { start?: number; end?: number };
        parent?: { subscription_item_details?: { subscription?: string } };
      }>;
    };
  };
  obj.billing_reason = opts.billingReason;
  // Plan 5 P0.1: invoice.subscription is null in API 2026-03-25.dahlia.
  // The subscription id lives at parent.subscription_details.subscription,
  // and also at lines.data[0].parent.subscription_item_details.subscription.
  // Both paths are populated for redundancy; the handler reads the former
  // with a fallback to the latter.
  if (!obj.parent) obj.parent = {};
  if (!obj.parent.subscription_details) obj.parent.subscription_details = {};
  obj.parent.subscription_details.subscription = opts.subId;
  const line = obj.lines?.data?.[0];
  if (line) {
    if (!line.period) line.period = {};
    if (opts.periodStart !== undefined) line.period.start = opts.periodStart;
    if (opts.periodEnd !== undefined) line.period.end = opts.periodEnd;
    if (line.parent?.subscription_item_details) {
      line.parent.subscription_item_details.subscription = opts.subId;
    }
  }
  return cloned;
}

export function invoicePaymentFailed(opts: { subId: string; eventId?: string }): Stripe.Event {
  const { event } = loadCapture('invoice.payment_failed');
  const cloned = structuredClone(event);
  cloned.id = opts.eventId ?? `evt_p5wh_inv_fail_${rand()}`;
  const obj = cloned.data.object as {
    parent?: { subscription_details?: { subscription?: string } };
    lines?: {
      data?: Array<{ parent?: { subscription_item_details?: { subscription?: string } } }>;
    };
  };
  if (!obj.parent) obj.parent = {};
  if (!obj.parent.subscription_details) obj.parent.subscription_details = {};
  obj.parent.subscription_details.subscription = opts.subId;
  const line = obj.lines?.data?.[0];
  if (line?.parent?.subscription_item_details) {
    line.parent.subscription_item_details.subscription = opts.subId;
  }
  return cloned;
}
