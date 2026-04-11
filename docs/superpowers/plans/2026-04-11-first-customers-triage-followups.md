# 2026-04-11: First-customers triage follow-ups

## Context

First real paying signups hit Breeze prod in the 2026-04-10 / 2026-04-11 window.
Triage of a single customer's onboarding experience surfaced a cascade of latent
production bugs, operational gaps, and systemic issues that had been waiting for
real traffic to expose. This doc is the operational tracker for what shipped,
what's in flight, and what still needs attention.

## Shipped in-session

- **Stripe API `2026-03-25.dahlia` shape migration** in `breeze-billing`:
  `current_period_start/end` moved from the top-level Subscription object to
  `subscription.items.data[0]`. Handler crashed with `Invalid Date` → 500 on
  every `customer.subscription.updated` webhook. Fixed via `extractSubscriptionPeriod()`
  helper that accepts either shape. (commit `e00082b` on `breeze-billing:main`)

- **US Stripe webhook endpoint configured** (`engaging-excellence` / `we_1TL407...`)
  pointing at `https://us.2breeze.app/billing/webhooks/stripe`. Before this, only
  the EU endpoint existed, meaning any US payment would have silently failed to
  activate. Signing secret wired into the US billing container's `STRIPE_WEBHOOK_SECRET`
  via `/opt/breeze/.env` on the `breeze-us` droplet; container recreated.

- **Webhook handler hardening** (`breeze-billing` commit `e00082b`):
  - `assertPartnerLocal()` check at every event handler entry. Previously, a
    webhook for a partner that doesn't exist in the local regional database would
    silently `UPDATE ... WHERE partner_id = X` affecting 0 rows and be logged as
    processed. Now logs a structured error and short-circuits.
  - `partnerSync` helpers return booleans reporting row-count, so 0-row updates
    can be detected as a defensive second line.
  - Three cases using `getPartnerBySubscription()` now also log loud errors on
    unresolved partner IDs.

- **Billing Overview success-page race fix** (`breeze-billing` commit `e00082b`):
  `/billing/?result=success` now polls the subscription endpoint for up to 30s and
  shows a tri-state banner: "Finalizing..." while the webhook lands, "Active!" once
  it does, and an amber "payment received but not activated" warning if the poll
  times out. Previously the page showed "Payment successful!" alongside "No active
  subscription" simultaneously for the window between Stripe redirect and webhook
  arrival.

- **EU prod data cleanup**: 10 test partners (all `@breeze.local` email domain,
  from registration flow testing) hard-deleted via a single transaction. 160 rows
  removed total (10 partners + 10 orgs + 10 sites + 10 users + 10 partner_users +
  10 roles + 10 role_permissions + 60 audit_baselines). Kept: `default-partner`
  (seed), `olivetech` (personal), `vix-it` (real abandoned prospect), `biglobe`
  (paying customer).

## In-flight

- **Agent issue #387** — desktop helper reconnect storm on headless Windows Server.
  - **PR #388** — Parts A-F (reconnect hardening, binary path fix, SID retry,
    pre-auth rejection, fatal-exit plumbing, lifecycle cooldown). Draft. Went
    through a 4-agent parallel review (code quality, silent failures, tests,
    types); two critical findings and several important ones queued for a
    review-followup agent pass before ready-for-review.
  - **PR #389** — Part G (heartbeat starvation). Phase 1 (instrumentation:
    heartbeat watchdog + `timedRWMutex` with caller-auto-detection) and Phase 2
    (atomic snapshot refactor for broker session reads, ~157 ns/op under
    10-goroutine write-storm). Draft.

## Deferred (from PR #388 review — not blockers, address later)

These are design/quality suggestions from the PR review that are intentionally
not blocking merge. Worth picking up as a follow-up PR or during a refactor pass.

- **Unify `ErrSIDLookupFailed` with `PermanentRejectError`**. Currently the helper
  has two parallel fatal-exit paths — a sentinel error and a typed error — each
  requiring a separate branch at the consumer (`main.go`). Having
  `lookupSIDWithRetry` return `*PermanentRejectError{Code: "sid_lookup_failed"}`
  directly collapses them into a single `errors.As` check and prevents future
  permanent-error additions from accidentally missing a branch.

- **Add constructors for `ipc.PreAuthReject`**. `NewTransientPreAuthReject(code, reason)`
  and `NewPermanentPreAuthReject(code, reason)` would encode the code/permanence
  coupling that currently lives only in broker call-site conventions. Prevents
  semantically contradictory combinations like `PreAuthCodeRateLimited + Permanent: true`
  from being silently serialized.

- **Unexport `SpawnedHelper.Handle`**. The exported `Handle windows.Handle` field
  bypasses the lifecycle contract (`Close()` zeroing). Making it unexported is
  free and funnels all access through `Wait()` / `Close()`.

- **Thread-safe `SpawnedHelper.Close()`**. Doc says "safe to call more than once"
  but the implementation writes `Handle = 0` without synchronization. Current
  call graph is race-free, but a future concurrent caller would double-close.
  Use `sync.Once` or `atomic.Uint32` to make the doc claim real.

- **`lookupSIDWithRetry` delay slice nitpick**. The delays are `{0, 100ms, 250ms, 500ms, 1s}`
  — 5 attempts total, not the 4 the issue spec described. Behavior is fine; fix
  the comment to say "5 attempts" for accuracy.

- **`helperStableThreshold` naming**. Variable measures time-since-auth-completion,
  not stable-connection duration. Rename / re-comment to align with intent.

- **Add `RejectionKind` enum** on `AuthResponse` / `PreAuthReject` to replace the
  `Permanent bool` field with a machine-readable `"transient"` / `"permanent"`
  axis. Minor expressiveness upgrade, removes the ambiguous `Accepted: true, Permanent: true`
  combination the type currently allows.

## Open — customer-facing

- ~~**Abandoned-cart recovery worker** in `breeze-billing`.~~ **Done.**

- ~~**Region picker UX on `breezermm.com`**.~~ **Done.**

- **`file_list` / `file_list_drives` command timeout**. A real customer hit this
  on her Windows 11 Pro workstation within an hour of signing up — both commands
  timed out (30s and 15s respectively), at 16:12:55 UTC on 2026-04-11. Unknown
  whether it's a product-wide bug, a network flakiness artifact on her side (she
  also had 4 heartbeat errors and 19 websocket warnings in the same 24h window),
  or an agent subsystem issue. Needs investigation — check recent file-transfer /
  remote-browse code paths and whether any first-hour initialization could leave
  the file-listing handler in a bad state.

- **`/billing/?result=success` landing page polish**. The tri-state banner is a
  start, but the full page could be redesigned to be a proper post-purchase
  experience: confirmation of plan, next-step CTA (enroll first device), receipt
  download link, etc.

## Open — not yet scheduled (systemic / infrastructure)

### Test infrastructure gaps surfaced by this triage

- **Synthetic customer-journey nightly test**. Should cover:
  1. POST to `/register-partner` (or the real signup endpoint) with a fresh test
     email
  2. Simulate plan selection → create Stripe Checkout session in test mode
  3. Use Stripe test tokens to complete checkout
  4. Verify webhook delivery lands and activates the partner in the DB within N
     seconds
  5. Verify the `/billing/` page shows "Active" state
  6. Clean up the test partner
  Run nightly in CI. Would have caught both the API version bug and the US
  webhook gap **before** a real customer did. Consider running per-region (US
  and EU independently).

- **Headless Windows pre-launch matrix**. CI runner or a dedicated ephemeral VM
  pool covering: Windows Server 2016 / 2019 / 2022, all headless (no interactive
  RDP session), on Contabo / Vultr / Azure / Hetzner. Run the agent install and
  verify:
  - Device reaches `online` within 2 minutes
  - No desktop helper reconnect storm
  - Heartbeat stays fresh for at least 30 minutes
  - Non-desktop commands (patching, scripts) still work
  Would have caught #387 before it reached prod.

- **Billing service CI check for Stripe SDK drift**. On each bump of the
  `stripe` Node SDK in `breeze-billing`, run a grep that flags reads of known
  deprecated subscription fields (`current_period_start`, `current_period_end`
  at the top level, etc.). Could be a simple Github Action. The 17-day silent
  failure window on the `dahlia` migration could have been caught on day 1 with
  this check.

- **Agent log-storm protection**. The reconnect-loop bug shipped 1,500+ identical
  warnings in 24h from a single device. There should be a per-component,
  per-message-template rate limiter in the agent's logging layer so a broken
  subsystem cannot flood the log-ship pipe and cost money. Emit the first N
  occurrences verbatim, then drop to one-per-minute with a suppressed count.

### Operational / monitoring

- **Customer onboarding watcher**. Daily cron that generates a report of all
  partners in `pending` for >24h and emails it to the operator. Prevents the
  current workflow where problems are only caught when an operator manually
  queries the DB. Related: the abandoned-cart worker should probably generate
  the same signal via different means, so either merge these or make them
  complementary (worker handles the email-the-customer side, watcher handles
  the email-the-operator side).

- **Prod partner-growth dashboard**. A simple internal dashboard showing: new
  partners/day, pending → active conversion, active → churned, MRR, device
  counts per partner. With two paying customers and 14 total partners on EU,
  this is currently trivially understandable by query, but won't scale.

- **Region misrouting detector**. Periodic job that scans recent signups on
  each region and correlates the partner's inferred timezone / IP geo against
  the region they signed up in. Alert on mismatches — they are UX bugs even if
  payment works.

## Session findings detail (reference)

### 1. Stripe API version shape migration (critical, shipped)

Stripe API `2026-03-25.dahlia` removed `current_period_start` / `current_period_end`
from the top-level Subscription and moved them to `subscription.items.data[0]`.
The webhook handler in `breeze-billing/src/routes/stripeWebhooks.ts` read them
from the top level:

```ts
currentPeriodStart: new Date(subscription.current_period_start * 1000),
```

With the new shape, `subscription.current_period_start` is `undefined`, so
`undefined * 1000 === NaN`, and `new Date(NaN)` is an Invalid Date that Postgres
rejects — 500. Silently failing for **every** `customer.subscription.updated`
webhook since March 25.

`checkout.session.completed` still worked because that handler calls
`stripe.subscriptions.retrieve()` server-side, and the Stripe Node SDK pins its
own API version (older than `2026-03-25.dahlia`), which returns the old shape.
That's why the first paying customer appeared to activate correctly but had a
`billing_subscriptions` row with `updated_at === created_at` — the
`customer.subscription.updated` event never successfully landed.

Fix: `extractSubscriptionPeriod()` helper that reads either shape and returns
`{ start: Date | null, end: Date | null }`.

### 2. US Stripe webhook endpoint missing (critical, shipped)

Single Stripe account shared between US and EU regional billing services.
Only one webhook endpoint existed, pointed at `https://eu.2breeze.app/billing/webhooks/stripe`.
**The US billing service had never processed a Stripe webhook in prod.** Next US
customer to pay would have silently failed to activate (broker handler would
`UPDATE ... WHERE partner_id = X` affecting 0 rows in the US database — where
the partner didn't exist because the customer signed up on US, whose partner
was in the US DB, but the webhook went to EU which has no such partner).

Fixed by registering a second Stripe webhook endpoint (`engaging-excellence` /
`we_1TL407...`) pointing at `https://us.2breeze.app/billing/webhooks/stripe` and
setting the US billing service's `STRIPE_WEBHOOK_SECRET` to the new endpoint's
signing secret.

### 3. Webhook handler silent failures on misrouted events (latent, hardened)

See `assertPartnerLocal()` change in `stripeWebhooks.ts`. 0-row UPDATEs used to
be treated as success.

### 4. Success page race condition (shipped)

See Overview.tsx tri-state banner fix.

### 5. Agent desktop helper reconnect storm on headless Windows Server (#387, fix in progress)

See issue #387 for the complete root cause analysis and layered fix plan.
Summary: on a headless Windows Server VPS, the desktop helper spawns, fails
broker auth due to four compounding Windows-specific bugs (tight backoff,
silent rejection paths, path-verification canonicalization mismatch, SID
lookup race), enters a reconnect storm at ~15/min with no log rate limiting,
and the parent agent's heartbeat stops because the broker mutex is contended.

### 6. `file_list` / `file_list_drives` command timeouts (open, needs investigation)

Two commands timed out on a real customer's Windows 11 Pro workstation within
an hour of her first login. Root cause unknown. Possibly related to agent
heartbeat warnings (she had 4 heartbeat errors and 19 websocket warnings in
the same 24h window, suggesting some network flakiness), but could also be a
product bug.

### 7. Region picker on marketing site routes by user click, not geo (open)

`breezermm.com` has a two-button region picker. US is labeled "Recommended"
but a real US-IP customer clicked EU anyway. This is a UX funnel leak that
will result in wrong-region signups forever at some rate.

### 8. EU prod test partner pollution (cleaned)

11 test partners in EU prod, all with `@breeze.local` emails, from registration
flow testing on April 7-8. Cleaned in-session; would have otherwise polluted
dashboards, abandoned-cart recovery, and any lifecycle email automation.
