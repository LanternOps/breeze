# Signup Flow Design — Registration, Payment, Onboarding

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:writing-plans to create an implementation plan from this design.

**Goal:** End-to-end flow from visitor → paying customer with first device enrolled. Credit card required for all accounts to prevent abuse.

**Architecture:** Two-step registration (account creation → Stripe Checkout), with pending account guards and simplified post-payment onboarding. Changes span both breeze (OSS) and breeze-billing (private) repos.

---

## Plans & Pricing

| Tier | Price | Devices | Support |
|------|-------|---------|---------|
| Starter | $20/year | 3 | Community (forums/docs) |
| Community | $99/month | 250 | Community (forums/docs) |

Additional tiers can be added later. The existing `free` plan concept is removed — all accounts require payment.

---

## Flow: Registration → Payment → Activation

```
Marketing site (breezermm.com/pricing)
  → "Get Started" → app.breezermm.com/register-partner

1. Register Partner (existing form, unchanged UI)
   → POST /auth/register-partner
   → Creates user + partner with status = "pending"
   → JWT issued (limited access)
   → Redirect to plan selection + Stripe Checkout

2. Plan Selection (new page in billing SPA)
   → User picks Starter ($20/yr) or Community ($99/mo)
   → POST /api/billing/checkout creates Stripe Checkout Session
   → Redirect to Stripe hosted checkout

3. Stripe Checkout (hosted by Stripe)
   → Collects payment info, processes charge
   → On success → redirect to /setup (simplified onboarding)
   → On cancel → redirect back to plan selection

4. Stripe Webhook: checkout.session.completed
   → Activates account: partner.status = "active"
   → Creates billing_subscription row
   → Sets partner.plan + partner.maxDevices (3 or 250)

5. Stale Cleanup Cron (daily)
   → Deletes pending partners + users older than 48 hours
```

---

## Flow: Simplified Onboarding (post-payment)

Replaces the existing 4-step setup wizard with a focused 2-step flow:

**Step 1: Create Organization + Site**
- Company name (pre-filled from partner registration)
- First organization name
- First site name
- Single form, single submit

**Step 2: Enroll Your First Device**
- Auto-generated enrollment key displayed
- Platform-specific install commands (macOS / Windows / Linux tabs)
- Copy-to-clipboard for one-liner install
- "I'll do this later" skip button

After step 2 (or skip) → redirect to dashboard.

---

## Flow: Auto-Upgrade (Starter → Community)

When a Starter user tries to enroll device #4:

1. Agent enrollment returns 403 with `upgrade_required` error code
2. UI shows upgrade modal: "You've reached your 3-device limit. Upgrade to Community (250 devices) for $99/mo?"
3. "Upgrade" button → POST /api/billing/partners/:id/subscribe (plan change in Stripe)
4. On success → retry enrollment automatically
5. "Not now" → dismiss modal

**Downgrade protection:** Community users with >3 devices cannot downgrade to Starter. Must decommission devices first.

---

## Account States & Guards

**Partner statuses:**
- `pending` — registered, hasn't paid
- `active` — paid, fully functional
- `past_due` — payment failed, Stripe dunning (existing grace period logic)
- `suspended` — grace period expired, enrollment blocked (existing enforcement)

**Pending account middleware:**
- Checks `partner.status === 'pending'`
- Allows: `/auth/*`, `/billing/*`, `/api/portal/*`, `/api/billing/*`
- Blocks all other routes → 403 + redirect to checkout
- Frontend: pending user landing on dashboard → redirect to checkout page

**Stale cleanup:**
- Daily cron in breeze-billing
- Deletes partners + users where status = 'pending' AND created > 48 hours ago
- No Stripe cleanup needed (checkout never completed)

---

## Changes by Repo

### Breeze (OSS)

| File | Change |
|------|--------|
| `apps/api/src/routes/auth.ts` | Set new partners to `status: 'pending'` instead of `'active'` |
| `apps/api/src/middleware/` | New `pendingGuard` middleware — blocks pending partners from non-auth/billing routes |
| `apps/api/src/routes/agents/enrollment.ts` | Return `upgrade_required` error code when at device limit (not just 403) |
| `apps/web/src/pages/setup/` | Replace 4-step wizard with 2-step onboarding (org+site, enroll device) |
| `apps/web/src/components/` | New upgrade modal component for device limit hit |

### Breeze-Billing (Private)

| File | Change |
|------|--------|
| `src/routes/checkout.ts` | New — creates Stripe Checkout Session with plan metadata |
| `src/routes/stripeWebhooks.ts` | Handle `checkout.session.completed` → activate partner |
| `src/jobs/staleAccountCleanup.ts` | New — daily cron to purge 48h+ pending accounts |
| `src/services/stripeSync.ts` | Create Stripe products/prices for Starter + Community |
| `ui/src/pages/Checkout.tsx` | New — plan selection page before Stripe redirect |
| `ui/src/pages/Plans.tsx` | Update with Starter + Community tiers |

---

## Email Verification

Not included. Stripe validates identity via credit card. Stale pending accounts are cleaned up by cron. Email verification can be added later if needed.

---

## What This Does NOT Cover (future work)

- Additional plan tiers (Pro, Enterprise, custom)
- Annual billing option for Community tier
- SSO/SAML registration flow
- Invite-based registration (org admin invites sub-users)
- Usage-based AI billing (already implemented separately)
- Marketing site pricing page (lives on breezermm.com, separate repo)
