// Minimal Stripe event fixtures. Only the fields our handlers read are populated.
// Each builder accepts overrides for the identifiers the test wants to control.

const nowSec = () => Math.floor(Date.now() / 1000);
const rand = () => Math.random().toString(36).slice(2, 8);

export function checkoutSessionCompleted(opts: {
  userId: string;
  studioId: string;
  subId?: string;
  custId?: string;
  eventId?: string;
}) {
  return {
    id: opts.eventId ?? `evt_p4wh_cs_${rand()}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_test_${rand()}`,
        subscription: opts.subId ?? `sub_test_p4wh_${rand()}`,
        customer: opts.custId ?? `cus_test_p4wh_${rand()}`,
        metadata: { user_id: opts.userId, studio_id: opts.studioId },
      },
    },
  };
}

export function invoicePaymentSucceeded(opts: {
  subId: string;
  billingReason: 'subscription_cycle' | 'subscription_create' | string;
  periodStart?: number;
  periodEnd?: number;
  eventId?: string;
}) {
  const start = opts.periodStart ?? nowSec();
  const end = opts.periodEnd ?? start + 30 * 86400;
  return {
    id: opts.eventId ?? `evt_p4wh_inv_ok_${rand()}`,
    type: 'invoice.payment_succeeded',
    data: {
      object: {
        id: `in_test_${rand()}`,
        subscription: opts.subId,
        billing_reason: opts.billingReason,
        lines: {
          data: [{ period: { start, end } }],
        },
      },
    },
  };
}

export function invoicePaymentFailed(opts: { subId: string; eventId?: string }) {
  return {
    id: opts.eventId ?? `evt_p4wh_inv_fail_${rand()}`,
    type: 'invoice.payment_failed',
    data: {
      object: {
        id: `in_test_${rand()}`,
        subscription: opts.subId,
      },
    },
  };
}

export function customerSubscriptionUpdated(opts: {
  subId: string;
  status: 'active' | 'past_due' | 'canceled' | 'incomplete';
  cancelAtPeriodEnd: boolean;
  periodStart?: number;
  periodEnd?: number;
  eventId?: string;
}) {
  const start = opts.periodStart ?? nowSec();
  const end = opts.periodEnd ?? start + 30 * 86400;
  return {
    id: opts.eventId ?? `evt_p4wh_sub_upd_${rand()}`,
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: opts.subId,
        status: opts.status,
        cancel_at_period_end: opts.cancelAtPeriodEnd,
        current_period_start: start,
        current_period_end: end,
      },
    },
  };
}

export function customerSubscriptionDeleted(opts: { subId: string; eventId?: string }) {
  return {
    id: opts.eventId ?? `evt_p4wh_sub_del_${rand()}`,
    type: 'customer.subscription.deleted',
    data: {
      object: {
        id: opts.subId,
        status: 'canceled',
      },
    },
  };
}
