# Payment Model Trade-offs — inStudiio (iOS app + Stripe backend)

**Status:** Decision recorded — see "Decision" below.
**Last reviewed:** 2026-06-16
**Owner:** Christian
**Applies to:** How users pay for studio subscriptions when the consumer client is a **native iOS app** and the backend bills via **Stripe**.

> ⚠️ **Not legal advice.** Apple's rules and the surrounding litigation (Epic v.
> Apple in the US, the EU Digital Markets Act) are actively changing. Treat the
> commission numbers and "what's allowed" sections as a snapshot, not gospel —
> confirm against [Apple's current App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
> (esp. §3.1) before you submit a build, and loop in counsel before launch.

---

## TL;DR

| | **Web-signup + Stripe** *(chosen)* | **Apple In-App Purchase (StoreKit)** |
|---|---|---|
| Who takes a cut | Stripe (~3%) | Apple (15–30%) |
| On a $9.99/mo sub, you keep | **~$9.40** | ~$8.49 (Small Business) / ~$6.99 (standard, year 1) |
| You own the customer & their data | ✅ Yes | ❌ No (Apple does) |
| Works on web/Android too | ✅ One system | ❌ iOS-only; re-do per platform |
| Sales-tax/VAT handled for you | ❌ You handle (Stripe Tax) | ✅ Apple remits globally |
| In-app purchase UX | ⚠️ Friction (subscribe on web first) | ✅ One tap, native |
| App Store rejection risk | ⚠️ Must follow "reader app" rules | ✅ The blessed path |
| Engineering effort | ✅ Mostly built already | ❌ New StoreKit + receipt/notification pipeline |

**Bottom line:** For an early-stage product the web-signup + Stripe model keeps
~12% more revenue per dollar, keeps you in control of pricing/customers/data,
and reuses the backend you've already built. The price you pay is **purchase
friction** (users can't buy inside the app) and the discipline of following
Apple's reader-app rules. Revisit IAP if in-app conversion friction starts
costing you more growth than Apple's cut would cost you in margin.

---

## Decision (2026-06-16)

We are going with the **web-signup / "reader app"** model **for now**:

- Users subscribe to a studio on the **website** via Stripe Checkout (outside the app).
- The **iOS app only authenticates** (log in) and plays the content they're entitled to.
- The existing Stripe backend (`/subscriptions`, `/webhooks/stripe`, the
  `subscriptions` table) is the source of truth for entitlement.

This keeps the iOS app out of the "selling digital goods in-app" bucket that
would trigger Apple's mandatory In-App Purchase rule.

---

## Background: why this is even a question

Apple's App Review Guideline **§3.1.1** says: if your app unlocks digital
content or features *used inside the app* (subscriptions, premium content, etc.),
you must sell it through Apple's **In-App Purchase (IAP)**, on which Apple takes
a commission. inStudiio subscriptions unlock studio **videos that play inside the
app**, so by default that's IAP territory.

There are two legitimate ways to avoid handing Apple a cut, and one hybrid:

1. **Reader-app / web-signup model** — sell on the web, app only logs people in. *(our choice)*
2. **Apple IAP** — sell inside the app through Apple, eat the commission.
3. **External purchase link (hybrid)** — app links out to a web purchase. Newer, region-specific, see below.

---

## Option 1 — Web-signup + Stripe (the "reader app" model) ✅ chosen

The model used by Netflix, Spotify, Kindle, etc. Apple explicitly carves out
"reader" apps (§3.1.3(a): magazines, newspapers, books, audio, music, **video**)
that let users access content purchased elsewhere.

**How it works for us**
1. User goes to the inStudiio **website**, picks a studio, pays via Stripe Checkout.
2. Stripe webhook writes the `subscriptions` row (already built).
3. User opens the iOS app, logs in with the same account, and watches.

**Pros**
- **Lowest fees.** Stripe is ~2.9% + $0.30 per charge (+ ~0.5% if using Stripe
  Billing) vs Apple's 15–30%. On $9.99/mo that's keeping **~$9.40 vs ~$6.99–8.49**.
- **You own the customer relationship and data** — email, payment method, full
  billing history. Critical for retention, win-back, support, and analytics.
- **Full pricing control** — trials, coupons, proration, annual plans, dunning,
  regional pricing — all yours, changeable instantly, no Apple approval.
- **Cross-platform by default.** One Stripe subscription entitles the user on
  web, iOS, and a future Android app. No per-store re-implementation.
- **Reuses what's built.** The backend payment path is done; remaining work is
  config (webhook secret) and the website checkout page.

**Cons / risks**
- **Purchase friction.** Users can't subscribe in the app. They must go to the
  website, pay, come back, and log in. This *will* lower conversion vs one-tap IAP.
- **Anti-steering rules (the sharp edge).** Historically the app could **not**
  show a "Subscribe" button, link to your pricing page, show prices, or even
  *tell* users that subscriptions exist elsewhere. The safe baseline is: the app
  only offers **"Log in"** — no purchase UI, no prices, no outbound links to buy.
  Getting this wrong is the #1 reason reader apps get rejected. *(See "What's
  changed in 2025" — this has loosened in the US/EU.)*
- **You handle tax.** Sales tax / VAT is on you (use [Stripe Tax](https://stripe.com/tax)
  to calculate + help remit). Apple would have done this for you.
- **You handle compliance plumbing** — PCI scope (minimal with Stripe Checkout),
  chargebacks, refunds, SCA/3DS in the EU.

---

## Option 2 — Apple In-App Purchase (StoreKit)

Sell the subscription inside the app through Apple.

**Pros**
- **Frictionless, native UX.** One tap, Face ID, done. Best conversion.
- **Apple handles tax globally**, billing retries, refunds, receipts, and is a
  trusted payment UI users don't hesitate at.
- **Zero App Store rejection risk** on the payment front — it's the sanctioned path.

**Cons**
- **The commission.** 30% standard; **15%** if you're in the [Small Business
  Program](https://developer.apple.com/app-store/small-business-program/) (under
  $1M/yr proceeds); auto-renewing subs drop to 15% after a subscriber's first 12
  months. Still 5–10× Stripe's fee.
- **Apple owns the customer.** You don't get their email or card; limited data;
  Apple mediates refunds (more refund abuse, less control).
- **iOS-only.** Web and Android need entirely separate billing. Syncing a
  user's entitlement across platforms means mapping Apple transactions to your
  own accounts server-side.
- **Real engineering cost.** You'd build a **second** payment pipeline:
  StoreKit 2 in the app, server-side receipt validation, and
  [App Store Server Notifications V2](https://developer.apple.com/documentation/appstoreservernotifications)
  to keep the `subscriptions` table in sync (the Apple equivalent of Stripe
  webhooks). Pricing is managed in App Store Connect, not your code.
- **Less billing flexibility** — promo codes, trials, and proration all work
  Apple's way, not yours.

---

## Option 3 — External purchase link (hybrid) ⚖️ watch this space

A middle path: the app stays "reader-style" but is allowed to **link out to your
website** to subscribe. Whether this is allowed — and whether Apple still takes a
cut — depends heavily on region and is in flux:

- **United States:** After the April 2025 *Epic v. Apple* contempt ruling, Apple
  was ordered to let US apps link to external web purchases **with no Apple
  commission** and without restrictive "scare screen" formatting. (Apple is
  appealing, but is complying in the meantime.) In practice this means a US build
  can include a "Subscribe on our website" link today.
- **European Union (DMA):** External links and alternative payments are allowed,
  but Apple layers on its own fee structure (reduced commission tiers + a "Core
  Technology Fee"). Complex; model the economics before relying on it.
- **Rest of world:** Generally still the strict reader-app rules — log-in only.

**Why it matters for us:** it lets you *reduce the purchase friction* of Option 1
(a tappable link to the web checkout) without adopting IAP — at least in the US
and EU. It does **not** change the backend; Stripe stays the engine. Treat it as
an optimization to layer on later, region-gated, once the basic flow ships.

---

## Money, worked out (real numbers, $9.99/mo studio sub)

| Model | Platform fee | **You keep / month** | You keep / year |
|---|---|---|---|
| Stripe (web) | 2.9% + $0.30 (+~0.5% Billing) | **~$9.40** | ~$112.80 |
| Apple IAP — Small Business (15%) | $1.50 | ~$8.49 | ~$101.88 |
| Apple IAP — standard, year 1 (30%) | $3.00 | ~$6.99 | ~$83.88 |
| Apple IAP — standard, after 1 yr (15%) | $1.50 | ~$8.49 | ~$101.88 |

At 1,000 active subscribers, the gap between Stripe and standard-rate IAP is
roughly **$29k/year** in retained revenue. Even vs the 15% Small Business rate,
Stripe retains ~$11k/year more per 1,000 subs. That margin is the whole reason
to accept the friction of the web-signup model.

> The flip side: if IAP's frictionless checkout converts even ~10–15% more
> trials into paid subscribers, that lift can outweigh Apple's cut. The right
> answer is partly empirical — measure web-checkout conversion before assuming
> Stripe "wins."

---

## What Option 1 requires us to do (practical checklist)

**Backend (mostly done)**
- [x] Stripe Checkout session creation (`POST /subscriptions`)
- [x] Stripe webhook handler + idempotency ledger
- [ ] Register a Stripe webhook endpoint + set the real `STRIPE_WEBHOOK_SECRET` (still placeholder in prod)
- [ ] A public **website** with the pricing/checkout page (where the purchase actually happens)

**iOS app — review-safety rules (the part that keeps you approved)**
- ✅ Offer **"Log in"** with an existing account.
- ✅ Play content the logged-in user is entitled to.
- ⚠️ **Do not** show prices, a "Subscribe" button, or in-app purchase UI for the
  digital subscription (outside the US/EU external-link allowance).
- ⚠️ **Do not** route users to Stripe/Apple Pay inside the app for the subscription.
- 🔎 If you want an in-app "Subscribe on our website" link, gate it to **US (and
  possibly EU)** builds and confirm against the current entitlement rules first.
- 💡 Consider applying for Apple's **External Link Account Entitlement** if you
  want a sanctioned single link to your site for account management.

**Auth**
- The website checkout and the iOS login must resolve to the **same user account**
  (same Supabase user), so the entitlement written by Stripe is visible to the app.

---

## When to revisit this decision

Switch to (or add) **Apple IAP** if any of these become true:
- Web-checkout conversion is measurably throttling growth and the friction clearly
  costs more than Apple's commission would.
- You want a true one-tap in-app purchase and can absorb 15–30%.
- Apple rejects builds or tightens reader-app enforcement in a way that blocks you.

Lean harder into **external links (Option 3)** if:
- Most revenue is US/EU, where linking out is now permitted commission-free (US)
  or under DMA terms (EU) — capture some of IAP's convenience without the cut.

---

## References

- Apple — App Review Guidelines §3.1 (Payments): https://developer.apple.com/app-store/review/guidelines/#payments
- Apple — Small Business Program: https://developer.apple.com/app-store/small-business-program/
- Apple — App Store Server Notifications V2: https://developer.apple.com/documentation/appstoreservernotifications
- Apple — External purchase / link entitlements: https://developer.apple.com/support/external-purchase/
- Stripe — Pricing: https://stripe.com/pricing
- Stripe — Billing (subscriptions): https://stripe.com/billing
- Stripe — Tax: https://stripe.com/tax
- Epic v. Apple (US external-link ruling, Apr 2025) — verify current status; under appeal.
