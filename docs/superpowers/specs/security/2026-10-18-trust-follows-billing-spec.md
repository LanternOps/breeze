---
status: draft-for-approval
issue: LanternOps/breeze#8714
related: [8713, 8767]
builds_on: docs/superpowers/specs/security-auth/2026-09-02-partner-trust-probation-design.md
---

# Trust follows billing: demote trusted partners when the subscription lapses

Verified against `origin/main` at `9f9e6c8b18`. Paths are relative to `apps/api/src/` unless they say otherwise. Anything not confirmed in code is marked **(assumption)**. The billing service is a separate, private repository. Nothing here reads its code. Every statement about how it behaves is either a stated assumption or a contract this design asks it to meet (§3.8).

## 1. Problem

A partner's trust state never changes when its subscription does. Once a partner is `trusted`, it stays `trusted` indefinitely. That is true whether it was auto-promoted on a settled card (`tryAutoPromote` → `auto:settled_card_24h`, `services/partnerTrustPromotion.ts`), promoted by an admin (`admin:promote` in `routes/admin/trust.ts`, `admin:approve_link` in `routes/admin/trustAct.ts`), or grandfathered by the column default. It stays `trusted` after a renewal fails and the subscription ends `canceled`, `unpaid` or `incomplete_expired`. The partner also stays `status = 'active'` and keeps every trust-gated capability (`GatedCapability` in `services/partnerTrust.ts`: `remote_control`, `device_execute`, `installer_distribute`, `agent_enroll`, `custom_sending_domain`, `trust_page_publish`).

The activation path already treats those statuses as contradicting payment (`BILLING_STATUS_VETO` / `billingStatusContradictsPayment`, `services/partnerActivation.ts`). Activation uses it (`shouldActivatePendingPartner`, reached from `middleware/partnerGuard.ts` and `services/emailVerification.ts`), and so does admin unsuspend (`routes/admin/abuse.ts`). The trust path never consults it.

Four facts shape the design.

1. **The mirror is written out of tree.** Only the billing service writes `partners.billing_subscription_status`, directly to the database, from its payment-provider webhooks. The migration header says so (`apps/api/migrations/2026-07-25-partner-billing-identity.sql`), and so does the schema comment (`db/schema/orgs.ts`). No API route or service writes it. There is no write path in this repo to hook.
2. **The mirror can stay wrong for a long time** (assumption: a known failure mode, fixed upstream). Some customers have two subscriptions, for example a paid one and a second checkout they abandoned. A status event for the abandoned one (`incomplete_expired`) could overwrite the mirror of the paid one. The wrong value then persists until the next event on the real subscription, which can be a full billing period away. The bug is fixed upstream, but this design must stay correct when the mirror is wrong. Demoting on a wrong mirror takes remote control away from a paying MSP.
3. **Promotion has no current-billing check.** `promotionDecision` requires all of these: a settled card charge at least 24 h old, a classified signup IP that is not hosting/VPN, no unresolved alert, and no billing hold. A partner that paid once, a year ago, still passes. If we demoted a lapsed partner today, it would be promoted straight back, either by the next gated click (`recordCapabilityDenial` fires `tryAutoPromote`) or by the 15-minute `partner-trust-promote` job (`jobs/partnerTrustJobs.ts`).
4. **Many trusted partners could never pass auto-promotion again.** Two groups are affected: partners grandfathered by the `trusted` column default, and partners an admin approved despite a blocker (a hosting signup IP, a wallet payment with no 3DS card). Hard-deny evaluation (`evaluateHardDenies`) also targets `probation` only. So a partner pushed back to `probation` gets re-scored on historical signals that were never applied to it, or were already reviewed. Restore cannot simply reuse the onboarding path.

## 2. Users & scope

- **Partner (MSP) axis only.** Trust is a column on `partners`. Organizations, sites and devices inherit it through `organizations.partner_id`. Nothing in this design is org-scoped. An org-scoped user sees only the downstream effect, such as a refused remote session.
- **Hosted only.** `partnerTrustMode()` (`config/partnerTrustMode.ts`) returns `off` whenever `IS_HOSTED` is not true. A self-hosted install has no billing service and a NULL mirror, so every part of this design is inert there (§3.9).
- **Who it is for:** active, trusted, hosted partners whose subscription has actually ended.
- **Who it must never touch:** partners with a paid subscription and a wrong mirror; partners trusted without a subscription by design (internal, comped, invoiced); grandfathered partners that never subscribed (NULL mirror); suspended or restricted partners, which belong to the abuse path.
- **"Pending review".** There is no `pending_review` state. The enum is `probation | trusted | restricted` (`db/schema/orgs.ts`). The review concept is the partner-initiated request: `trust_review_requested_at`, written by `POST /partner/trust/request-review` (`routes/partnerTrust.ts`) and shown in `GET /admin/trust/queue` (`routes/admin/trust.ts`, `apps/web/src/components/admin/TrustQueue.tsx`). A lapse demotion does not open a review. The partner fixes billing, or an admin sets an exemption (§3.5, §3.7).

## 3. Proposed design

### 3.1 Which statuses count, and why the mirror alone never decides

A partner is a **lapse candidate** when all of these hold:

- `trust_state = 'trusted'`, `status = 'active'` and `deleted_at IS NULL`;
- `billing_subscription_status` is one of **`canceled`, `unpaid`, `incomplete_expired`, `paused`**;
- the partner has no live exemption (§3.5).

These mirror values never make a partner a candidate:

| Mirror value | Why no action |
|---|---|
| `active`, `trialing` | The partner is entitled. |
| `past_due` | Dunning is in progress after a real capture. Dunning ends in `canceled` or `unpaid`, and we act on that end state. |
| `incomplete` | A first invoice or payment authentication is pending. It is transient (assumption: provider behaviour): it becomes `active`, or expires to `incomplete_expired` within about a day. It is in the activation veto, but a trusted partner showing `incomplete` is almost always changing plans, not lapsing. |
| `NULL` | Unknown. This matches the veto's fail-open stance (header of `partnerActivation.ts`). It covers grandfathered never-subscribed partners and deploy skew. |
| any other value | Unrecognised. Log at `warn` and take no action. The list is a denylist on purpose, like `BILLING_STATUS_VETO`. |

A new exported predicate, `billingStatusIndicatesLapse(status)`, sits next to `billingStatusContradictsPayment` in `partnerActivation.ts`. Its set is the veto minus `incomplete`. The activation veto itself does not change.

**The mirror is a hint. Live entitlement decides, in both directions.** The billing service is asked for the partner's *current* entitlement (§3.8). It reads that from the payment provider, across **all** of the customer's subscriptions, not from one mirrored row. Demotion needs three things:

1. **A verified grace window.** Live checks have said "not entitled" continuously for 72 h, and the partner was warned at the start (§3.2).
2. **A fresh negative check at the decision point.** Only an affirmative `entitled: false` from this run's check counts. This is what defeats the overwrite in fact 2. The mirror says `incomplete_expired`, but the provider has one subscription `active`, so the partner is entitled and nothing happens.
3. **Batch limits** (§3.8). A single run demotes a bounded number of partners, and so does a rolling 24 h window.

**An unknown result fails open: no demotion.** The result is unknown when the endpoint is unreachable, times out, returns a 404 without the exact domain body, returns a malformed body or a body for a different partner, or has not been deployed. The partner stays `trusted`, and the next run retries. After 7 days of continuous unknowns, the partner is surfaced to operators (§3.7).

This is the opposite of promotion, where `billingHoldUnknown` fails *closed* (`gatherPromotionFacts`). The asymmetry is deliberate. Promotion grants capability to an unvetted account. Demotion removes it from an account we already vetted, and the dominant risk is mass false demotion of paying MSPs. A missed demotion is bounded: the partner did pay at some point, every abuse signal still runs, and an admin can restrict it at any time.

### 3.2 Grace window, warning and clock

- **One uniform 72-hour grace period** for every demoting status. A per-status table adds tuning surface with no clear benefit:
  - `canceled` is already past the paid period. A subscription set to cancel at period end stays `active` until that period ends (assumption: provider behaviour).
  - `unpaid` and `paused` follow failed dunning or an explicit pause.
  - `incomplete_expired` is the status most likely to be an overwrite, and the live check handles it. A longer grace would not.
- **The API's database is the clock.** Billing-side timestamps are not used: the mirror has no "status changed at" column, and `billing_identity_synced_at` is a sync stamp. The grace period must not depend on a clock in another service. Two new columns on `partners` (§4):
  - `trust_lapse_observed_at`: the first **verified** non-entitlement for a candidate, stamped by the reconcile job at the database's `now()`, in `report` or `enforce` mode. It is the episode key. It is cleared as soon as the partner stops being a candidate: the mirror recovers, a live check says entitled, an exemption is set, or the partner is no longer trusted and active.
  - `trust_lapse_warned_at`: stamped **in `enforce` mode only**, and only when the warning sender returns a recipient count above 0. The sender returns the number of addresses it was handed to, as the existing trust senders do, and returns 0 for no email service, no active admin, or a transport failure. A partner with no deliverable admin address is **never** warned, so it is never demoted. It is held and listed in the queue's "Lapse watch" section for an operator to decide (Open Decision 6). **The enforce grace runs from `trust_lapse_warned_at`, not from `trust_lapse_observed_at`.** That gives two guarantees:
    - When the mode flips from `report` to `enforce`, old report-mode observations do not demote anyone on the first enforce run.
    - A crash between the stamp and the send, or a failed send, never leads to a demotion without a warning. The job retries the warning on the next run and does not start the clock until it lands.
- **The mirror does not start the clock.** If the live check says *entitled* while the mirror contradicts, nothing is stamped and no warning goes out. Instead the job writes one `partner.trust.lapse_mirror_disagreement` audit row per partner and mirror value, and checks again once every 24 h.

### 3.3 What "demote" means

**Demote means `trusted` → `probation`**, with reason `billing:lapsed`, written by a guarded update (§3.8). That update re-checks every eligibility condition in the same `UPDATE`. After the write, the side effects are the ones `setTrustState` already performs: publish on `partner-trust:changed`, refresh the Trust Center serving set, and write the audit row. The plan factors those effects out of `setTrustState` so both writers share them. They are not duplicated.

Why `probation` and not `restricted`, and not a new state:

- `restricted` means *suspected abuse*. It never auto-promotes, only an admin can lift it, and the queue copy and evidence cards are written for fraud review. A lapsed payer is not a suspect.
- A new enum value such as `lapsed` would touch every `decide()` branch, the agent WS trust cache (`routes/agentWs.ts` validates the three values), the web `TrustDenyCode` handling and the probation spec's whole capability table, all for semantics `probation` already has. The one difference that matters is how the partner gets back. `trust_reason = 'billing:lapsed'` carries that, and it routes the partner to its own restore branch (§3.4).

What the partner will feel. All of this is existing behaviour, stated here so the rollout is not a surprise:

- **Operator actions stop.** `device_execute` denies every non-lifecycle command (`decide()`, `LIFECYCLE_COMMAND_TYPES`). That includes scripts, patch *installs*, backups, restores and automation execute steps. It applies at the queue and on the agent WS fast path (`agentWs.ts`, `sendCommandToAgent`).
- **Queued work is cancelled, not held.** A pending command that hits a trust denial at claim time is cancelled with reason `trust_denied`, and its payload is erased (`services/commandClaimEligibility.ts`, `assertTrusted` and the cancel loop). Restore does not replay cancelled work. The partner re-runs it.
- **Live desktop and terminal sessions end** at their next continuation check (`services/remoteWsAuthorization.ts` re-proves `remote_control`). **Open tunnels do not.** Tunnels are excluded from live continuation and keep their admission-only gate until they close.
- **The fleet keeps reporting.** The agent tenant gate keys on `partners.status`, not on trust. Heartbeats, inventory, metrics, `patch_scan` and lifecycle commands (`update_agent`, `self_uninstall`, …) all continue. Nothing is uninstalled and no data is lost.
- **Enrollment** comes under the probation cap (`PROBATION_ENROLLMENT_CAP = 5`, counted from `probation_enrollments`). Trusted enrollments never touched that counter, so a grandfathered partner with a large fleet keeps every enrolled device and can enroll up to 5 more.
- **Installer links, custom sending domains and Trust Center pages are gated.** The partner-lane mail lookup returns `partner_ineligible` (`services/emailDomains/partnerLaneLookup.ts`). Published Trust Center pages stop serving, because the predicate requires `trusted` whenever the mode is not `off` (`services/trustPage/predicate.ts`).
- **Residual risk: stale agent WS snapshots.** Agent sockets cache the trust state and update it only from the best-effort `partner-trust:changed` publish. If that publish is missed, the WS fast path keeps the old value until reconnect. The queued-claim path re-evaluates. This gap exists for every trust transition today and is out of scope here (§5).

This is a heavy outcome for an MSP whose customers depend on patching. That is why §3.1–§3.2 are strict, why the partner gets 72 h of warning, and why restore is fast (§3.4).

### 3.4 Re-payment and restore: a distinct branch

**Restore is automatic, but it does not reuse onboarding promotion** (fact 4). `tryAutoPromote` dispatches on `trust_reason`:

- **`trust_reason = 'billing:lapsed'` → `tryBillingRestore`.** It restores to `trusted` with reason **`auto:billing_restored`** when all of these hold:
  1. A **fresh live check returns `entitled: true`.** This overrides the mirror. A paid customer whose mirror is still wrong is restored anyway. An unknown result blocks with `billing_entitlement_unknown`, so the grant path stays fail-closed.
  2. **No current billing hold.** `getSignupRiskHold` returns `none` or `pass`. An unknown result blocks, as it does today.
  3. **No unresolved `alert`-severity abuse signal**, whenever it was raised. This is the same check `gatherPromotionFacts` makes today.
  4. The partner is still `active` and not deleted, re-checked in the guarded update.

  It does **not** re-require the onboarding facts: the settled 3DS card, signup-IP class and account age. The partner was vetted once, automatically, by an admin or by grandfathering. The lapse was about payment, not identity.
- **Hard denies still run, minus the signup-time axis.** `evaluateHardDenies` targets `probation`, so a lapse-demoted partner is evaluated on every path that calls it: `tryAutoPromote`, the promote job, and the ip-classify job (`processPartnerTrustJob` → `restrictOnHardDeny`). The rule is the same on all of them. A `billing:lapsed` partner is **not** restricted on `auto:tor_signup`. That axis is a fixed fact from signup, already accepted when the partner was trusted. Everything else stays in force:
  - the card-fingerprint match against abuse-suspended partners;
  - the corroborated network match, including the device enrollment IPs;
  - `hasFraudulentRefundMatch`.

  Those signals can be new. A cancellation after a chargeback or a fraudulent refund is a common route into `canceled`. A resulting `restricted` is reversible by an admin with the existing override.
- **Every other probation partner** (new signups) goes through the existing `promotionDecision` with one new blocker, **`billing_lapsed`**. It applies when the mirror indicates a lapse *and* a live check does not say entitled. The live check is made only when the mirror indicates a lapse, so a clean mirror adds no billing call. Without this blocker, a signup whose subscription expired could be promoted on a card that settled before the expiry.
- **Rate limit on the lazy path.** `recordCapabilityDenial` fires `tryAutoPromote` on every gated click. Live checks made for restore are throttled to one per partner per 5 minutes, using the last result already recorded (`trust_lapse_verified_at` plus its outcome, or an in-process cache, decided in the plan). A partner clicking around cannot fan out billing calls.
- **Latency.** A partner who fixes billing is restored on their next gated click after the 5-minute throttle, or within 15 minutes by the existing job. Neither waits for the mirror to catch up.

How a lapse-demoted partner differs from a never-trusted one:

| | Never trusted | Lapse-demoted |
|---|---|---|
| `trust_reason` | NULL, `auto:*` restriction, or admin | `billing:lapsed` |
| Audit | no lapse rows | `lapse_observed`, `lapse_warned`, then `partner.trust.probation` with lapse evidence (§3.7) |
| Way back | `promotionDecision` (onboarding facts) | `tryBillingRestore` (live entitlement, holds, fresh alerts) |
| Hard denies | all axes | all axes except `auto:tor_signup`; any unresolved alert blocks restore |
| Banner | probation checklist and Request review | "Paused: subscription not active" and a billing CTA (§3.6) |
| Request review | allowed | `409 billing_lapsed`, pointing to billing (§3.6) |
| Queue | normal review row | badged "Billing lapse", filterable (§3.7) |

### 3.5 Exemptions: explicit, never derived

Some partners are trusted without a paid subscription by design: internal, comped and enterprise-invoiced partners. They need an **explicit, auditable exemption**. Deriving it is rejected:

- `partners.type` (`msp | enterprise | internal`) describes the tenant's shape, not its contract.
- `plan` is billing-written and moves with the subscription.
- `trust_reason` is overwritten by every later transition.

New nullable columns on `partners` (§4): `trust_lapse_exempt_reason` (`internal | comped | invoiced | admin_override`), `trust_lapse_exempt_until` (NULL means indefinite) and `trust_lapse_exempt_note`. An exemption waives lapse enforcement only. It grants nothing else. Setting or clearing one is an MFA-gated admin action that writes an audit row (§3.7). When an `admin_override` expires, the partner can become a candidate again, and the full verified-and-warned grace starts fresh.

**`admin:*` promotions do not survive a lapse unless the partner is exempt.** Every approval writer has to apply this, or the admin is silently overruled 72 h later:

- `POST /admin/partners/:id/trust/promote` (`routes/admin/trust.ts`);
- the signed approve link `POST /admin/trust/act` (`routes/admin/trustAct.ts`), which today calls `setTrustState(…'trusted'…)` with no CAS and without the restricted-override check.

Both return `409 billing_lapse_requires_exemption` when the **target** has no live exemption and either of these holds:

- it is in `probation` with `trust_reason = 'billing:lapsed'` (the common case: an admin trying to promote a lapse-demoted partner);
- its mirror is in a lapse status (`billingStatusIndicatesLapse`).

The check uses the mirror and stored columns only. There is no live billing call on the request path. Without the check, the admin's promotion would be overruled after the next warned grace, which is not what an admin promoting a partner intends. The admin then picks one: set `admin_override` with an expiry, or have the partner fix billing (which restores it through §3.4). The approve link also gains the CAS that the queue route already uses.

**Precondition audit, run before `enforce`.** This spec defines the query but does not run it.

```sql
-- Trusted, active, hosted partners whose mirror is not plainly entitled.
SELECT p.id, p.slug, p.type, p.plan, p.trust_reason, p.trust_changed_at,
       p.billing_subscription_status, p.billing_identity_synced_at,
       p.payment_method_attached_at, p.created_at,
       (SELECT count(*) FROM organizations o JOIN devices d ON d.org_id = o.id
         WHERE o.partner_id = p.id) AS device_count
FROM partners p
WHERE p.trust_state = 'trusted'
  AND p.status = 'active'
  AND p.deleted_at IS NULL
  AND (p.billing_subscription_status IS NULL
       OR p.billing_subscription_status NOT IN ('active', 'trialing', 'past_due'))
ORDER BY p.billing_subscription_status NULLS FIRST, device_count DESC;
```

Classify the output into three buckets:

- **NULL mirror.** No action by design. Listed so operators know how large the grandfathered never-subscribed population is, which is out of scope (§5).
- **Demoting status.** Classify each row as *exempt* (set the reason) or *demote*, after `report` mode has recorded its live check.
- **Other** (`incomplete`, unrecognised). Reviewed by hand.

An operator runs it under a system DB context. The output stays out of the public repo.

### 3.6 Partner notification and in-app copy

- **New mail purposes, platform lane**, in `services/emailDomains/mailPurposes.ts`:
  - `account.trust_billing_lapse_warning`: once per episode, when the enforce grace starts.
  - `account.trust_billing_paused`: on demotion.
  - `account.trust_billing_restored`: on `auto:billing_restored`.

  The existing `account.trust_approved` copy ("has been reviewed and approved") is wrong for a restore. The probation → trusted mail branch in `setTrustState` currently fires on every promotion, so it now picks the template by reason.
- **Senders** follow `services/partnerTrustPartnerMail.ts`. They are Breeze-branded, on the platform lane, inert unless the effective lapse mode is `enforce` (§3.9), and never throw. The deferral to context exit is not inside the sender: `setTrustState` wraps the approval send in `runAfterDbContextExit` itself (`partnerTrust.ts`). The shared transition effects (§3.3) keep that wrapper, and the job calls the warning sender outside any DB context, after phase 1 has released its connection.
- **Delivery guarantees.**
  - The warning is **durable by construction**. Demotion is gated on a fresh `trust_lapse_warned_at` (no older than 14 days). It is stamped only after `sendTrustBillingLapseWarning` returns a recipient count above 0. A lost or undeliverable warning delays demotion. It never skips the warning.
  - The paused and restored notices are best-effort, matching today's approval email. The banner shows the state either way.
  - Deduplication is structural. There is one warning per `observed_at` episode, one paused notice per guarded update that landed, and one restored notice per restore that landed. Flapping is bounded by the 72 h warned grace, so a partner gets at most one warning and one paused notice per 72 h.
- **Copy.** It says what pauses, says that devices keep reporting, and gives the billing link. It never names the internal status string.
- **Banner.** `GET /partner/trust` (`routes/partnerTrust.ts`) adds a derived `pausedFor: 'billing' | null` and, during the enforce grace, `lapseGraceEndsAt`. It never returns the raw `trust_reason`, which also carries risk codes such as `auto:tor_signup`. `apps/web/src/components/trust/TrustProbationBanner.tsx` gets two new variants:
  - a billing variant: "Paused because your subscription is not active", a billing-page CTA in place of Request review, and no probation checklist;
  - a grace-warning variant, shown while `lapseGraceEndsAt` is set.

  New strings go into all 8 locales (`apps/web/src/lib/i18n/localeParity.test.ts`), and new elements carry `data-testid`.
- **Request review, server side.** `POST /partner/trust/request-review` returns `409 billing_lapsed`, with a pointer to billing, for a lapse-demoted partner whose last recorded entitlement is not `true`. A partner that billing already reports entitled, but that is held back by a billing hold or an alert, can still request a review. Billing cannot unblock it, so a human has to. Hiding the button alone would not stop the request, and a review would send the "review received" email and an evidence card for what is a billing matter.

### 3.7 Audit, evidence, admin override and queue visibility

**Audit actions.** These are immutable `audit_logs` rows, the convention from the probation spec §3.1. Evidence is bounded: statuses and timestamps, never raw provider payloads. Every row carries the episode key (`observedAt`).

| Action | When | Details |
|---|---|---|
| `partner.trust.lapse_observed` | first verified non-entitlement | `mirrorStatus`, `verification`, `mode` |
| `partner.trust.lapse_warned` | warning handed to the transport (enforce) | recipient count, `graceEndsAt` |
| `partner.trust.probation` (existing action) | demotion | `reason: 'billing:lapsed'`, `mirrorStatus`, `observedAt`, `warnedAt`, `graceHours`, `verification: { entitled: false, subscriptionStatuses, checkedAt }`, prior `trust_reason` and `trust_changed_at` (approval provenance) |
| `partner.trust.promoted` (existing action) | restore | `reason: 'auto:billing_restored'`, `verification`, hold status |
| `partner.trust.lapse_cleared` | episode cleared before demotion | why: mirror recovered, entitled, exemption, or left eligibility |
| `partner.trust.lapse_mirror_disagreement` | mirror contradicts, live says entitled | `mirrorStatus`, `subscriptionStatuses` (one row per mirror value) |
| `partner.trust.lapse_would_demote` | `report` mode, demotion conditions met | same evidence as a real demotion |
| `partner.trust.lapse_would_block_promotion` | `report` mode, the new blocker would have fired | `blocker`, `mirrorStatus` |
| `partner.trust.lapse_verification_unknown` | first unknown, then at 7 days | `why`: `unreachable`, `timeout`, `404`, `malformed` or `partner_mismatch` |
| `partner.trust.lapse_circuit_open` | a batch limit tripped | candidate count, limit, denominator, held-back ids |
| `partner.trust.lapse_exemption_set` / `…_cleared` | admin route | reason, until, note, actor |

**Admin override.** Add `PUT /admin/partners/:id/trust/lapse-exemption` and `DELETE /admin/partners/:id/trust/lapse-exemption` to `routes/admin/trust.ts`:

- Same gating as the existing promote and restrict routes in that file: `requireMfa()` behind the platform-admin admin mount.
- Zod-validated. `reason` and `note` are both required, the note at least 8 characters.
- Writes run under `withSystemDbAccessContext`.
- `admin/trust.ts` is already in `MCP_COVERAGE` (`services/mcpCoverage.ts`) as a platform-admin exemption, so no new coverage entry is needed. The web calls go through `runAction`.

**Queue.** `GET /admin/trust/queue` already lists every non-trusted partner, so lapse-demoted partners appear there with `billing:lapsed` in the reason column. Add:

- a `billing_lapse` badge, and a filter `?reason=billing_lapse|abuse|all` (default `all`), so fraud reviewers can hide billing rows;
- a read-only **"Lapse watch"** section. This is the only place a still-trusted partner appears in the queue. It lists trusted partners that are in an enforce grace, have 7 or more days of continuous unknown verification, or were held back by a batch limit.
- billing evidence on the evidence card (`services/partnerTrustEvidenceCard.ts`): mirror status, observed and warned times, and the last verification result.

### 3.8 Trigger: a periodic reconcile job

**Use a reconcile job only. Do not hook the write path.**

- The writer is out of tree (fact 1). An in-repo hook on the mirror write would have to be a Postgres trigger on `partners`. That puts hidden logic on a hot table, runs inside the billing service's transaction under its role, and still cannot make the live check. Rejected.
- A billing → API callback would be a new cross-service contract, and its only benefit is latency. A 72 h grace makes latency irrelevant. The job also covers missed webhooks and existing rows, both of which the issue requires.

**The job.** It is named `partner-trust-lapse-reconcile` and runs hourly. It is a new job name on the existing abuse-signals queue: `processPartnerTrustJob` dispatches it, `schedulePartnerTrustJobs` schedules it (`jobs/partnerTrustJobs.ts`), and it gets a new `jobSchedule('partner-trust-lapse-reconcile')` entry in `jobs/scheduleRegistry.ts`. That entry needs an hourly cron string that no other entry uses, because the registry contract test enforces unique values. It adds no worker initializer. The existing `abuseSignalsWorker` entry in `jobs/workerReadinessManifest.ts` (rule `abuse_or_partner_trust_enabled`) already covers this queue. The plan confirms that, and adds a manifest entry if the job moves to a new queue.

That worker runs with **concurrency 1** (`jobs/abuseSignalsSweep.ts`), and it is shared with the abuse sweep and the promote job. So each run has a hard budget:

- **Per call:** the live check gets an explicit deadline. `AbortSignal` with 5 s is a starting point. `internalGet` in `breezeBillingClient.ts` sets no deadline today.
- **Per run:** bounded concurrency (for example 4) and a wall-clock budget (for example 5 minutes). Partners not reached carry over to the next run, keyset-ordered.

Each run is two-phase:

1. **Evaluate.** Under a system DB context, select the candidates, plus every row that has `trust_lapse_observed_at` set. Page by keyset in batches of 200, the same pattern as `runPartnerTrustPromote`. For each row, run the live check and apply the state machine: *clear*, *observe* (stamp `observed_at`, guarded by `IS NULL`), *warn* (enforce only; send, then stamp `warned_at`), *hold*, or *ready to demote*. A row is ready to demote when all of these hold: the mode is enforce, `now() - warned_at` is between 72 h and 14 days, and this run's check returned `entitled: false`. A `warned_at` older than 14 days is stale. That happens when enforce was paused, the partner left eligibility, or the job was unscheduled. A stale `warned_at` is cleared, and the partner is warned again with a fresh grace. A run in `report` mode clears any `warned_at` it finds, so returning to `enforce` always re-warns. Phase 1 writes nothing else. It assembles the full ready set.
2. **Limit, then act.** The denominator is the trusted, active partners with a non-NULL mirror. Two limits apply:
   - **Per run:** if the ready set is larger than `max(3, 2% of the denominator)`, demote none.
   - **Rolling 24 h:** if the ready set plus the lapse demotions already landed in the last 24 h exceed `max(5, 3% of the denominator)`, demote none. The landed count is the number of `partner.trust.probation` audit rows with `reason = 'billing:lapsed'` and `timestamp` in the last 24 h.

   If either limit trips, write `lapse_circuit_open`, report it to Sentry, and leave the decision to an operator. While the breaker stays tripped, it re-alerts at most once per 24 h, or sooner if the held-back set changes. The floors keep a small population from tripping on one or two real lapses. The rolling limit stops repeated runs from causing damage just under the per-run threshold. A systematic error, such as a billing deploy that writes `canceled` everywhere or an endpoint that wrongly says `entitled: false`, becomes an alert rather than a mass demotion. When the limits pass, demote each ready partner with the guarded update.

**The guarded update** re-checks everything at write time. The trust-only CAS in `writeTrust` (`services/partnerTrust.repo.ts`) would miss a suspension, a newly granted exemption, a same-state admin change, or a trusted → probation → trusted round trip:

```sql
-- ms(x) = date_trunc('milliseconds', x). The API round-trips timestamps as JS Dates
-- (millisecond precision) while Postgres stores microseconds, so every comparison
-- against a loaded value truncates both sides, and every stamp this feature writes
-- is written truncated. A plain `=` would never match, and the feature would
-- silently never demote.
UPDATE partners SET trust_state = 'probation', trust_reason = 'billing:lapsed',
       trust_changed_by = NULL, trust_changed_at = ms(now()), updated_at = now(),
       trust_lapse_observed_at = NULL, trust_lapse_warned_at = NULL
WHERE id = $1
  AND trust_state = 'trusted' AND status = 'active' AND deleted_at IS NULL
  AND billing_subscription_status IN ('canceled','unpaid','incomplete_expired','paused')  -- mirror not corrected meanwhile
  AND ms(trust_changed_at) IS NOT DISTINCT FROM ms($loaded_trust_changed_at)   -- trust version
  AND ms(trust_lapse_observed_at) = ms($episode) AND ms(trust_lapse_warned_at) = ms($warned)
  AND trust_lapse_warned_at > now() - interval '14 days'                        -- warning still fresh
  AND (trust_lapse_exempt_reason IS NULL
       OR (trust_lapse_exempt_until IS NOT NULL AND trust_lapse_exempt_until <= now()))
RETURNING id;
```

If the update matches zero rows, the row changed underneath us. Skip it, with no audit row and no mail. `tryBillingRestore` uses the same pattern for restore: `trust_state = 'probation' AND trust_reason = 'billing:lapsed' AND status = 'active'`, plus the version check. Where the audit service can join the system-context transaction, the audit row is written in the same transaction as the state change. Otherwise the existing `setTrustState` order is kept. The plan decides which.

**Idempotency.** Every write is guarded: `IS NULL` on the stamps and the full predicate on the transition. Overlapping runs, retries and repeated mirror writes cannot demote twice, audit twice or mail twice. A failure on one partner is logged and that partner is skipped. A failure never aborts the batch and never falls through to a demotion.

**The contract asked of the billing service (out of tree).** One endpoint, `GET /internal/partners/:id/subscription-entitlement`, using the existing service bearer key:

- **Response:** `{ partnerId, entitled: boolean, subscriptions: [{ status, currentPeriodEnd }], checkedAt }`.
- **Source:** it reads the payment provider live and pages through every subscription for the partner's customer. It never reads only its own mirror table.
- **Rule:** `entitled` = at least one subscription is `active`, `trialing` or `past_due`.
- **Other cases:** a partner with no customer gets a *distinct, exact* 404 body. A provider error or an incomplete page gets a 5xx, never `entitled: false`.

The client method is `getSubscriptionEntitlement` in `breezeBillingClient.ts`. It follows the discipline of `getSignupRiskHold`: only an exact domain body is a definite answer, and anything else is `null`, meaning unknown. Until the billing service ships the endpoint, every check is unknown and nothing is demoted. That lets the API ship first.

### 3.9 Modes: self-hosted, parent `off`/`shadow`, and a separate lapse flag

`PARTNER_TRUST_MODE=shadow` cannot dry-run this feature, for three reasons:

- Shadow still writes real trust transitions. New signups enter probation and promotion runs (probation spec §5, amended 2026-09-03).
- Shadow is not side-effect-free. The Trust Center predicate requires `trusted` in every mode except `off` (`services/trustPage/predicate.ts`).
- Production is expected to run the parent flag at `enforce`, or to be moving there (assumption). Stepping the whole gate back to shadow to rehearse this is not an option.

The new optional env var is **`PARTNER_TRUST_LAPSE_MODE = off | report | enforce`**, default `off`. It follows the env-var rule in the probation spec §5: optional, never fails config validation, never logs above `warn`. An unrecognised value resolves to `off`, not `report`, because this flag only ever takes capability away. The **effective** mode is the lower of this flag and the parent mode:

| Parent `partnerTrustMode()` | Effective lapse mode |
|---|---|
| `off` (incl. every self-hosted install) | `off` |
| `shadow` | at most `report` |
| `enforce` | the flag's value |

Unit tests pin each row of that table.

- **`off`:** the job is not scheduled, or no-ops if a job is already queued. Promotion ignores the new blocker, and `tryBillingRestore` is not used. A self-hosted install never calls billing and never shows the billing banner.
- **`report`:** the whole state machine runs: live checks, `observed_at`, the batch limits and the audit rows. Where enforce would act, report writes `lapse_would_demote` or `lapse_would_block_promotion` instead. It never writes `warned_at`, never demotes, never mails, never shows the banner, and the **new promotion blocker does not block**. Report changes no access outcome. Operators read real would-demote decisions on production data.
- **`enforce`:** warning, demotion, restore, mail and banner, all as specified above.

**Rollback.** Setting `PARTNER_TRUST_LAPSE_MODE=off` stops new warnings and demotions at once. It does **not** undo demotions that have already landed. With the mode `off`, `tryBillingRestore` is not used, and many lapse-demoted partners cannot pass the onboarding path (fact 4). So the rollback runbook includes a reviewed batch that re-promotes every `trust_reason = 'billing:lapsed'` partner through the shared transition writer, which writes the audit rows and the publish, with reason `admin:lapse_rollback`.

### 3.10 Abuse-sweep and suspension interaction

- **Lapse acts only on `status = 'active'` partners, and demotes only from `trusted`.** It never reads or writes `status`, never touches `restricted` partners or probation partners that were not lapse-demoted, and never unsuspends. The guarded update enforces this at write time (§3.8), so a suspension that lands mid-run is respected.
- **Suspension.** `suspendPartnerForAbuse` (`routes/admin/abuse.ts`) cancels the subscription, so the mirror then reads `canceled`. The partner is `suspended`, so it is not a candidate and nothing is done twice. When a partner leaves `active`, its lapse stamps are cleared. Lapse never reuses the abuse-suspension path: that path queues an uninstall across the whole fleet.
- **Unsuspend is unchanged.** It already routes a vetoed mirror to `pending`. If an admin unsuspends to `active` while the partner is `trusted` and the mirror reads `canceled`, the partner becomes a candidate and gets the full verified-and-warned grace. That is correct for a reinstated non-payer. **A pre-existing gap, not fixed here:** unsuspend trusts the mirror alone. A paid customer with a wrong mirror lands in `pending` (§5, follow-up).
- **Restore never overrides a restriction.** `tryBillingRestore` acts only on `probation` + `billing:lapsed`. If an admin restricts a lapse-demoted partner, it stays restricted, and paying again does not lift that.
- **Detection signals are unchanged.** `invariant.suspended_partner_active_subscription` (`services/abuseSignals/invariants.ts`) still covers the inverse case: suspended but still billed. No new sweep signal is needed. The queue's "Lapse watch" section is the operator surface.

### 3.11 Failure modes (high blast radius)

| Failure | Guard |
|---|---|
| Mirror overwritten with a lapse status while another subscription is paid | Live check across all subscriptions. A disagreement row is written, no clock starts, and restore ignores the mirror. |
| A billing deploy or bug writes a lapse status for many partners | Live check, then the per-run and rolling-24 h limits. Result: an alert, never a mass demotion. |
| The entitlement endpoint wrongly returns `entitled: false` for payers | Batch limits, plus at least 7 days of `report` mode before `enforce`, compared against the precondition audit. |
| Billing endpoint down, slow or not deployed | Unknown means no demotion (deadlines and run budget apply). Escalation after 7 days. Restore blocks as `billing_entitlement_unknown`. |
| A paid customer stays locked out because the mirror is still wrong | A live `entitled: true` overrides the mirror on restore. |
| A paid customer stays locked out because onboarding facts or hard denies fail | Restore is a distinct branch with no onboarding facts. The signup-time Tor axis is not re-applied, and every other hard deny stays in force (it is admin-reversible). |
| A lapse partner has no deliverable admin address | It is never warned, so it is never demoted. It is held in "Lapse watch" for an operator. |
| Stale warning (enforce paused, then resumed) | `warned_at` must be no older than 14 days. Report mode clears it, and the partner is warned again. |
| Mirror corrected between phase 1 and phase 2 | The guarded update re-checks the mirror status. |
| The old promotion path re-promotes a demoted partner at once | `tryAutoPromote` routes `billing:lapsed` partners to `tryBillingRestore`, and new signups get the `billing_lapsed` blocker. |
| An exempt partner is demoted | Explicit exemption columns, re-checked in the guarded update, plus the precondition audit before `enforce`. |
| An admin's approval is silently overruled | Both approval writers return 409 `billing_lapse_requires_exemption`. |
| Concurrent suspension, exemption or admin change during a run | The guarded update re-checks status, exemption, trust version and episode. |
| Demotion without warning (crash, failed send, flip from report to enforce) | The grace runs from `warned_at`, which is stamped only after the send, in enforce. |
| Job double-runs or retries | `IS NULL` guards and the guarded transition. Mail is tied to transitions that landed. |
| A legitimate MSP's patching stops | 72 h warning by email and banner. Restore on the next click, or within 15 minutes of paying. |

## 4. Tenancy & data model impact

**No new table.** All state is per partner and lives on `partners`. That table already has RLS enabled and forced, and it is the root of the partner axis. The cascade code handles it specially (`services/tenantCascade.ts`); it is not an entry in `CORE_ORG_CASCADE_DELETE_ORDER`. Partner-Wide First does not apply, because no config or policy table is added.

One migration adds nullable columns to `partners`:

```sql
ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS trust_lapse_observed_at   timestamptz,
  ADD COLUMN IF NOT EXISTS trust_lapse_warned_at     timestamptz,
  ADD COLUMN IF NOT EXISTS trust_lapse_exempt_reason text,
  ADD COLUMN IF NOT EXISTS trust_lapse_exempt_until  timestamptz,
  ADD COLUMN IF NOT EXISTS trust_lapse_exempt_note   text;
-- Idempotent CHECKs (guarded by pg_constraint lookups):
--   trust_lapse_exempt_reason IS NULL OR IN ('internal','comped','invoiced','admin_override')
--   trust_lapse_exempt_until IS NULL OR trust_lapse_exempt_reason IS NOT NULL
--   trust_lapse_warned_at IS NULL OR trust_lapse_observed_at IS NOT NULL
-- Partial indexes for the reconcile scans:
--   (id) WHERE trust_state = 'trusted' AND billing_subscription_status IS NOT NULL
--   (trust_lapse_observed_at) WHERE trust_lapse_observed_at IS NOT NULL
```

The plan may add the restore throttle's stamp (`trust_lapse_verified_at` and its outcome) or use an in-process cache instead (§3.4).

- **The prefix is deliberate.** `billing_*` columns are written by the billing service. `trust_lapse_*` columns are written only by the API: the reconcile job, the restore branch and the admin exemption route. The schema comment says so.
- **Migration rules.** The migration writes no rows, so it needs no system-scope `set_config` preamble. It is idempotent with no inner `BEGIN`/`COMMIT`. It is named to sort after the newest committed migration (`apps/api/migrations/README.md`). Run `pnpm db:check-drift` after it.
- **Export policy.** `partners` is partner-axis, so it is not in the per-org `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`). Follow the precedent comment there, the Autopay partner-axis note, and add a comment recording these columns as platform risk and billing-enforcement metadata outside the per-org export. In any future partner-axis export they belong with the probation spec's excluded risk-metadata bucket. `trust_lapse_exempt_note` is free text written by an operator, so it is never tenant-visible.
- **No new registrations needed.** There are no new `json`/`jsonb`/`bytea` columns, no new `org_id` or `device_id` columns, and no change to the cascade, merge or `rls-coverage` lists: the table and its policies already exist.
- **Not exposed to partners.** None of the new columns goes into any partner-scoped projection. That includes the explicit allowlist `partnerPublicColumns()` (`routes/orgs.ts`), which already excludes the `billing_*` columns. `GET /partner/trust` exposes only the derived `pausedFor` and `lapseGraceEndsAt`.
- **Contract registries the plan must update:**
  - `__tests__/orgSettingsWriters.contract.test.ts`. Widen the reason on the existing `src/jobs/partnerTrustJobs.ts` entry to cover the `trust_lapse_*` columns. Add a `no-agent-settings` entry for `src/routes/admin/trust.ts` if the exemption route writes `partners` directly. A write through an already-listed service needs no new entry.
  - `jobs/scheduleRegistry.contract.test.ts`. The new schedule key must be registered and used, and its cron string must be unique in the registry.
  - `__tests__/parkedFanout.contract.test.ts` needs an entry only if the job's code reads the `devices` table. A job that reads only `partners` is not discovered by that scan.

## 5. Out of scope

- Writing the plans. This document is the spec only.
- Changing the activation veto (`BILLING_STATUS_VETO`) or the `partners.status` lifecycle. Whether to suspend or churn a lapsed partner is the billing service's business decision.
- **Stale-positive mirrors**, where the mirror says `active` but the provider says ended. Catching those means live-checking every trusted partner periodically. That could be a later extension of the same job, but it is not required by the issue.
- Unsuspend trusting the mirror alone (§3.10). Follow-up: route it through the same live entitlement check.
- Versioned trust invalidation and refresh for agent WS snapshots (§3.3). This is a residual risk for every trust transition, not only lapse.
- Back-filling `probation` for grandfathered partners with a NULL mirror (probation spec §5 step 5 stays a separate reviewed batch).
- Plan or device-limit entitlement, meaning what a lapsed partner may *use*, as opposed to what it may *do* to devices.
- The billing service's fix for the mirror overwrite, and any change to its webhooks beyond the one read endpoint in §3.8.
- A new trust enum state, and a partner-axis tenant export.

## 6. Open Decisions

1. **Which statuses demote, and how they are verified.**
   - (a) Mirror ∈ {`canceled`, `unpaid`, `incomplete_expired`, `paused`}, plus a verified 72 h grace, plus a fresh live `entitled: false`.
   - (b) The mirror alone, with a longer grace of 7–14 days.
   - (c) The full veto set, including `incomplete`.

   **Recommend (a).** The overwrite leaves the mirror wrong for a whole billing period, so a longer grace (b) does not make it trustworthy. `incomplete` (c) is a transient state during plan changes. Unknown verification and a NULL mirror both mean no demotion.
2. **Grace and clock.**
   - (a) Uniform 72 h, starting at the warning that was sent (`warned_at`), on the API's clock.
   - (b) Per-status windows.
   - (c) No grace; rely on the live check alone.

   **Recommend (a).** The live check handles the overwrite case. The grace gives a real customer time to fix a card after a warning they really received. Report-mode observations never use up the grace (§3.2).
3. **What demotion moves the partner to.**
   - (a) `probation`.
   - (b) `restricted`.
   - (c) A new `lapsed` state with narrower gates, for example one that keeps patch installs.

   **Recommend (a).** Patch installs pausing is the strongest argument for (c). But a lapsed non-payer keeping remote execution on customer endpoints is exactly the gap the issue describes, and a new state multiplies the gate surface. The mitigations are the warning, the fast restore and the explicit consequence list (§3.3, including cancelled queued work).
4. **How restore works.**
   - (a) A distinct `tryBillingRestore`: fresh live `entitled: true` overrides the mirror, no current hold, no unresolved alert, no onboarding facts. Hard denies run except the signup-time `auto:tor_signup` axis.
   - (b) Reuse `promotionDecision` with a mirror blocker.
   - (c) Human review.

   **Recommend (a).** (b) locks out paid customers whose mirror is still wrong, plus every grandfathered or admin-approved partner that never met the onboarding facts, and it re-applies the signup-time Tor axis to history that was already reviewed. (c) turns a billing event into an operator ticket. This was the main disagreement in the quorum. It was resolved in favour of (a) (§8).
5. **Exemption shape.**
   - (a) Explicit nullable columns with a reason enum and an expiry.
   - (b) Derive it from `type`, `plan` or `trust_reason`.
   - (c) A separate exemptions table.

   **Recommend (a).** Derivation is fragile (§3.5), and a table is overbuilt for one row per partner. `admin:*` promotions do not survive a lapse without an exemption. Both approval writers return 409 to make that visible.
6. **Notifications.**
   - (a) Three new `account.trust_billing_*` purposes, with the warning made durable by the `warned_at` gate.
   - (b) Reuse the existing trust purposes.
   - (c) A durable notification outbox for all three.
   - (d) Banner only.

   **Recommend (a).** The existing copy is false for a lapse or a restore. Gating demotion on `warned_at` gives the one guarantee that matters, "never demoted unwarned", without new outbox infrastructure. The paused and restored notices stay best-effort, like today's approval email. A partner with zero deliverable admin addresses is held in "Lapse watch" and never auto-demoted. The alternative is to demote it with only the banner as notice. That is rejected, because it breaks "never demoted unwarned".
7. **Operator surface.**
   - (a) Audit rows only.
   - (b) Audit rows plus a queue badge, a filter, the "Lapse watch" section and evidence-card fields.
   - (c) A separate admin page.

   **Recommend (b).** Operators already work the trust queue. A separate page splits one concept across two homes.
8. **Trigger.**
   - (a) An hourly reconcile job only.
   - (b) A Postgres trigger on the mirror write.
   - (c) A billing → API callback.
   - (d) The job plus a callback.

   **Recommend (a),** with per-call deadlines, a run budget and two-phase batch limits. The writer is out of tree, the grace makes latency irrelevant, and the job covers existing rows and missed webhooks.
9. **Dry-run and self-hosted.**
   - (a) A separate `PARTNER_TRUST_LAPSE_MODE` (`off | report | enforce`, default `off`), capped by the parent mode: off → off, shadow → at most report.
   - (b) Reuse the parent shadow.

   **Recommend (a).** The parent shadow changes trust state and Trust Center serving. Report must also shadow the new promotion blocker, so W1 changes no access outcome. Rollback includes a reviewed re-promotion batch.
10. **Abuse interaction.**
    - (a) Act only on active partners, demote only from trusted, re-check at write time, never touch status.
    - (b) Also move suspended partners to probation.

    **Recommend (a).** Suspension already cancels billing, and unsuspend already applies the veto. Acting on suspended rows is a double action. The unsuspend mirror gap is a separate follow-up.
11. **Waves.**
    - (a) Observe, then act, then polish.
    - (b) A single wave.
    - (c) Ship the queue UI with the act wave.

    **Recommend (a).** Exemption management and every safety guard must exist before anything is demoted. Queue polish can follow:
    - **W1 — observe (no partner-visible change).** Prerequisite outside this repo: the billing service ships the entitlement endpoint. In this repo: `getSubscriptionEntitlement` with deadlines; the migration; `billingStatusIndicatesLapse`; the effective-mode resolver; the reconcile job and state machine with batch limits in `report`; the report-only promotion-blocker audit; all audit rows.
    - **W2 — act (the full cycle and every guard, before `enforce`).** The guarded demotion update and shared transition effects; the warning, `warned_at` and grace; `tryBillingRestore` with its throttle; the `billing_lapsed` blocker for new signups; the three mail purposes and the template switch in `setTrustState`; the exemption admin routes; the 409s on both approval writers and on request-review; `GET /partner/trust` `pausedFor` and `lapseGraceEndsAt`; the banner variants in all locales. Gate: the precondition audit is classified and its exemptions are set, and 7 days of `report` show no would-demote on a partner that the live check or an operator considers paid.
    - **W3 — operate.** The TrustQueue badge, filter, "Lapse watch" section and evidence-card billing section. This can land after `enforce`. Until then, operators read the audit rows.

## 7. Test & rollout notes

**Unit tests** (Vitest, alongside source):

- `billingStatusIndicatesLapse` against every provider status, NULL and an unknown string. The activation veto is unchanged.
- The state machine, as a pure function of (row, mirror, verification, mode, now):
  - observe, warn, hold and clear on every recovery path;
  - ready at exactly 72 h after `warned_at`;
  - a report-mode `observed_at` with no `warned_at` is never ready in enforce;
  - an unknown result is never ready;
  - an exemption with and without an expiry, and an expired exemption restarting the grace.
- Batch limits: per run and rolling 24 h, at and above each threshold, with the small-population floors. Phase 1 writes nothing before the limit check.
- The guarded update loses the race to each of these, with no audit row and no mail: a concurrent suspension, a newly granted exemption, a same-state admin change, and a trusted → probation → trusted round trip.
- **Idempotency.** Repeated runs produce one `lapse_observed`, one warning, one demotion and one paused notice.
- Restore:
  - a live `entitled: true` restores even while the mirror still says `incomplete_expired`;
  - unknown → `billing_entitlement_unknown`, and a current hold blocks;
  - a fresh alert blocks;
  - a grandfathered or admin-approved partner with no 3DS card is restored;
  - `auto:tor_signup` is not applied to `billing:lapsed` partners, and the card-fingerprint, network and refund matches are, on every caller of `restrictOnHardDeny`;
  - any unresolved alert blocks restore;
  - timestamp comparisons in the guarded updates match values round-tripped through a JS `Date` (the microsecond-precision trap);
  - a `warned_at` older than 14 days never demotes, and zero warning recipients never stamp `warned_at`;
  - request-review returns 409 only when billing is the sole blocker;
  - a restricted partner is never restored;
  - the throttle allows one live check per 5 minutes.
- New-signup promotion: the `billing_lapsed` blocker applies in enforce, only audits in report, and is ignored in off.
- Approval writers: promote and the approve link return 409 for an unexempted candidate, and the approve link uses the CAS. Request-review returns 409 for `billing:lapsed`.
- The client returns `null` for each of these: a 404 without the exact body, a malformed body, a partner mismatch, a timeout and a 5xx.
- The effective-mode table: not hosted → off; parent off → off; parent shadow caps at report; an unrecognised value → off.
- Mail: inert unless the effective mode is `enforce`, never throws, template selected by reason, and `warned_at` stamped only after a send that succeeded.
- Banner: the billing variant and the grace variant, plus locale parity across all 8 locales.

**Integration** (real Postgres, see `docs/agents/testing.md`): run the job against seeded partners in every bucket of the precondition audit, under the `breeze_app` role with system context. That proves the scans and the guarded update see the rows under forced RLS. Suspended, restricted and non-lapse probation partners are never stamped, demoted or restored.

**Scenario tests the plan must include:**

- the abandoned-checkout overwrite;
- a provider outage across one full grace period;
- repayment while the mirror stays wrong;
- an admin-approved, hosting-IP partner that lapses and then repays;
- a suspension that lands between phase 1 and phase 2;
- a missed `partner-trust:changed` publish (the WS fast path behaves as documented in §3.3).

**Rollout:**

1. The billing service ships the entitlement endpoint and verifies it in the provider's test mode (out of tree).
2. W1 deploys with `PARTNER_TRUST_LAPSE_MODE=report`.
3. Run the precondition audit, classify every row, and set exemptions (a reviewed batch, or the W2 route once it ships).
4. Read `lapse_would_demote`, `lapse_mirror_disagreement`, `lapse_would_block_promotion` and `lapse_verification_unknown` for at least 7 days. The target: every would-demote is a partner an operator confirms has no paid subscription, and every disagreement matches a known mirror defect.
5. Deploy W2, then flip to `enforce`. The first demotions can land no earlier than 72 h after the first warnings. Watch for limit trips and false-demotion reports in the first two weeks.
6. Rollback: set the mode to `off`, then run the reviewed re-promotion batch for `billing:lapsed` partners (§3.9).

## 8. Advisor quorum

I formed a position independently first. A read-only `codex exec` at `xhigh` reviewed it against the same code.

**Agreed:** the demoting status set; live verification that fails open for demotion; one 72 h grace; demoting to `probation`, not `restricted` or a new state; explicit exemptions that `admin:*` promotions do not bypass; a reconcile job with no write hook; a separate lapse flag; acting only on active partners and demoting only from trusted.

**Amendments from the second opinion, all adopted after checking the cited code:**

- Grace runs from a warning that was actually sent, so a flip from report to enforce cannot demote anyone unwarned.
- Queued commands are cancelled with their payload erased (`commandClaimEligibility.ts`), and open tunnels are not cut. Both are now stated.
- The guarded update re-checks status, exemption, trust version and episode.
- The signed approve link is the second approval writer.
- Deadlines and a run budget, because the shared worker runs at concurrency 1.
- A rolling 24 h limit on top of the per-run limit.
- The parent shadow caps the lapse mode at report.
- Report mode must not apply the new promotion blocker.
- Rollback needs an explicit re-promotion batch.
- Request-review is handled on the server.

**Disagreement, resolved on the merits:** restore. My first draft reused `promotionDecision` with a mirror-based blocker, plus a live-positive requirement. The second opinion showed that this design locks out paid customers whose mirror stays wrong. It also locks out every partner that is grandfathered or admin-approved and lacks the onboarding facts, and it re-exposes them to permanent hard-deny restriction. Adopted: a distinct `tryBillingRestore`, in which live entitlement overrides the mirror (§3.4). The spec review then narrowed the hard-deny exemption, and only the signup-time Tor axis is skipped. The refund and fingerprint matches can be new evidence, and a cancellation after a chargeback is a common lapse route. A resulting restriction stays admin-reversible.

**Spec review round (Sonnet).** 11 findings were confirmed and fixed:
- millisecond vs microsecond timestamp equality in the guarded update;
- a stale `warned_at` after enforce is paused;
- zero-recipient warnings;
- the scope of the hard-deny exemption;
- the alert window;
- 409 semantics on a lapse-demoted target;
- the mirror re-check at write time;
- request-review stranding;
- the sender's return contract;
- the rolling-count source;
- the observed-at index.

**Not adopted:**

- Periodic live checks for apparently healthy partners (stale-positive mirrors). This is out of scope (§5).
- A full durable outbox for every notice. The `warned_at` gate covers the one guarantee that matters (Open Decision 6).
