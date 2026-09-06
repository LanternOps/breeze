---
title: Pre-cap AI budget alerts
issue: LanternOps/breeze#4388
tracking_issue: LanternOps/breeze#4388
plan: docs/superpowers/plans/ai-mcp/2026-09-01-ai-budget-threshold-alerts.md
status: approved 2026-09-01 (Todd: all four §9 recommendations accepted)
date: 2026-09-01
advisor_quorum: Fable (author) + Codex gpt-5.6-sol xhigh (read-only, 2026-09-01) — see §10
---

# Pre-cap AI budget alerts (#4388)

## 1. Goal

Warn the MSP **before** an org reaches an AI spend cap, so the hard stop is never a
surprise. Prospect ask (ZTech, ~350 endpoints): AI cost predictability, variance inside
~10%. Concretely:

- Notify partner admins at configurable rungs (default 50 / 80 / 95 %) of an org's
  **daily and monthly AI budget**, and at 100 % when the cap is reached.
- Notify the partner when its **hosted AI credit balance** is running low, before the
  `credits_exhausted` stop.
- Per-org thresholds, partner-wide default + lock (the existing `aiBudgets` inheritance
  model), in-app notification + email to partner admins.

## 2. What exists today (verified 2026-09-01)

Two independent caps, both binary allow/deny at 100 %:

| Cap | Owner | Where enforced | Warning today |
|---|---|---|---|
| Org AI budget (`daily_budget_cents`, `monthly_budget_cents`) | Breeze API, `ai_budgets` (`apps/api/src/db/schema/ai.ts:167-180`), effective value = defaults ← org row ← partner JSONB `partners.settings.aiBudgets` (partner wins + locks) via `getEffectiveAiBudget` (`services/effectiveSettings.ts:290`) | `checkBudgetDetailed` (`services/aiCostTracker.ts:434-507`) denies at ≥ 100 % of `ai_cost_usage.total_cost_cents` for the UTC day/month | `checkCostAnomalies` (`aiCostTracker.ts:1105-1163`) already computes "> 80 % of **daily** budget" after every recorded turn — but only `console.warn`s. It reads the raw org row, not the effective budget, and ignores the monthly cap. `AiCostIndicator.tsx:113-126` colours the monthly bar yellow > 70 % / red > 90 %. |
| Partner AI credits (hosted, platform key only) | breeze-billing (separate repo, node-cron, no BullMQ, **no CI, no migration runner** — boot-time DDL in `src/db/ensureSchema.ts`) | `checkBillingCreditsDetailed` (`aiCostTracker.ts:146-237`) GETs `/api/internal/partners/:id/ai-credits` → `{allowed, remainingCredits, includedBalance, purchasedBalance, plan}`; denies `credits_exhausted` when the total is 0. BYOK (`billing_source='partner_key'`) is exempt. | None. `src/templates/creditsLow.ts` (`creditsLowEmail`) exists and is **never called**. Precedent for a threshold email: `src/jobs/deviceCountReconciler.ts:37-75` (80 % / 100 % device-limit emails to `partners.billingEmail`, 24 h cooldown in `partners.settings.lastLimitEmailAt`). |

Credit model facts that shape wave 2: the included monthly allowance (`AI_CREDITS_PER_MONTH`,
default 1500) exists **only for the `community` plan**; pro/enterprise/unlimited partners run
purely on purchased packs (1000 / 5000 / 10000 credits) which **persist across monthly resets**
(`creditService.ts:182-209`). So "% of cap" has no natural denominator for the prospect's tier.
Also `deductCredits` (`creditService.ts:113-136`) can drive `purchased_balance` negative on the
last turn — `from_purchased` is not clamped to the purchased balance.

Notification infrastructure in the API:

- The `alerts` table is device-scoped (`alerts.device_id NOT NULL`, `schema/alerts.ts:90-122`);
  every channel (email/Slack/Teams/webhook/PagerDuty), routing rule and escalation hangs off an
  `alerts` row, and `notificationDispatcher.ts:221-279` loads the device and routes by its site.
  There is no org-level alert today.
- `user_notifications` (`schema/notifications.ts:33-67`) is user + org scoped with a partial
  unique index on `(user_id, dedupe_key)`; `createNotification` (`services/userNotifications.ts:62`)
  is the single producer (system DB context required; `onConflictDoNothing` on the dedupe index).
  Type enum already has `'ai'`. The bell (`apps/web/src/components/layout/NotificationCenter.tsx`)
  polls every 30 s plus a WebSocket nudge.
- Transactional email: `getEmailService()?.sendEmail(params)` (`services/email.ts:169+`) with
  `renderLayout` / `renderButton` from `services/emailLayout.ts` (precedent:
  `services/deploymentInviteEmail.ts`). Emails are English-only; no locale plumbing.
- Recipient resolution precedent that unions org members with partner users covering the org,
  filtered by a permission (wildcard-aware): `resolveIntentApprovers`
  (`services/actionIntents/intentApprovers.ts:64-143`).
- Durable-event → publish precedent: `metricAnomalyIncidents` table + `jobs/metricAnomalyIncidentPublisher.ts`
  (`dispatched_at` marker, publisher re-upsert-inert). Coarse repeatable schedules must be
  allocated in `jobs/scheduleRegistry.ts`.
- Permissions: `PUT /ai/budget` is gated by `organizations:write` + MFA (`routes/ai.ts:127-130,
  1075-1108`). Seeded **Partner Admin** holds `*:*`; seeded **Org Admin** holds neither
  `organizations:write` nor `billing:manage` (`db/seed.ts:299-326`).

Conclusion: **no pre-cap alert exists anywhere** — not in the API, web, or billing service.
The issue's "if threshold alerts already exist somewhere, document them" branch is closed.

## 3. Non-goals

- **Hard spend accuracy.** Enforcement checks before the provider call and records cost after
  it (`aiAgentSdk.ts:377-387`); the SDK path bounds each turn by `maxBudgetUsd = remaining`,
  but N concurrent turns can each be granted the same remaining headroom. Atomic spend
  reservations are a separate issue (file as follow-up if the prospect needs a guarantee).
  Alerts at 95 % + the existing stop at 100 % deliver the practical predictability asked for.
- **Slack / Teams / webhook delivery.** Needs org-level (device-less) alerts through the
  existing channel pipeline — a separate epic (§8). The event-bus publish in wave 1 is the hook
  it will subscribe to.
- **Per-org custom recipient lists.** Recipients are rule-based (§4.6). A `recipients` override
  like AI agents' `{userIds, roleIds}` can be added later without schema churn on the events table.
- **Credits in-app notifications.** Wave 2 is email + UI balance display only (§5.5).

## 4. Wave 1 — org AI budget threshold alerts (API + web)

### 4.1 Configuration

- `ai_budgets.alert_threshold_pcts integer[] NULL` — null = inherit (default `{50,80,95}`);
  empty array = pre-cap warnings off (the 100 % "cap reached" event is always emitted).
- Partner JSONB key `partners.settings.aiBudgets.alertThresholdPercents?: number[]` — same
  semantics, inherits and **locks** through the existing merge (`AI_BUDGET_FIELDS` +
  `getEffectiveAiBudget` + `getEffectiveSettings` `locked[]`).
- Validation (both `routes/ai.ts:1081` and `routes/orgs.ts:684`): `z.array(z.number().int()
  .min(1).max(99)).max(5)`; server normalises to sorted unique. Shared type
  `InheritableAiBudgetSettings` (packages/shared) gains the field.
- Rung 100 is implicit and not configurable.

### 4.2 Evaluation

`evaluateAiBudgetThresholds(orgId)` in a new `services/aiBudgetAlerts.ts`, always under
`withSystemDbAccessContext` (wrap in `runOutsideDbContext` when called from a request —
same caveat as `createNotification`):

```
budget = getEffectiveAiBudget(orgId); if !budget.enabled → return
source = getLlmBillingSourceForOrg(orgId)          // current resolution, not the aggregate stamp
for period in [daily, monthly]:
  cap = budget.<period>BudgetCents; if !cap || cap <= 0 → continue   // mirrors enforcement's truthiness
  used = ai_cost_usage(org, period, periodKey).total_cost_cents ?? 0
  pct  = floor(used * 100 / cap)
  rung = max(r ∈ effective.alertThresholdPercents ∪ {100} where r <= pct); if none → continue
  INSERT INTO ai_budget_alert_events (...)
    SELECT ... WHERE NOT EXISTS (SELECT 1 FROM ai_budget_alert_events e
                                 WHERE e.org_id=$1 AND e.period=$2 AND e.period_key=$3
                                   AND e.threshold_pct >= rung)
    ON CONFLICT DO NOTHING RETURNING id
  if inserted → enqueue delivery job (jobId = event id)
```

Properties this gives:

- **One event per crossing, highest rung only.** A jump 40 % → 96 % fires 95 once; lower rungs
  are never created for that period (no three-email burst).
- **Monotonic per period.** Raising the cap mid-period (pct drops) never re-fires a lower rung;
  lowering it fires the newly crossed rung on the next evaluation. Periods roll at UTC
  boundaries with the `period_key`, which re-arms the ladder for free.
- **Exactly-once creation under concurrency** via the unique key
  `(org_id, period, period_key, threshold_pct)` plus the `NOT EXISTS` guard executed in one
  statement.

Trigger points:

1. After every usage upsert in `aiCostTracker.ts` (`recordUsage`, `recordUsageFromSdkResult`,
   `recordSessionlessSdkUsage`, `recordOpenAIUsage`) — replace the daily-80 % `console.warn` in
   `checkCostAnomalies` with a fire-and-forget call. Keep the per-session 10 % anomaly warn.
2. Inline after `PUT /ai/budget` (org row changed) — cap lowered or thresholds added must fire
   immediately, not on the next turn.
3. After a partner settings write that touches `aiBudgets` — enqueue one fan-out job that
   evaluates every org of the partner (rare admin action; never inline).
4. Reconcile: a 15-minute repeatable job (slot allocated in `scheduleRegistry.ts`) re-enqueues
   delivery for events with `delivered_at IS NULL AND delivery_attempts < 5 AND created_at < now()
   - interval '2 minutes'` (covers a crash between insert and enqueue).

### 4.3 Durable event table `ai_budget_alert_events`

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| org_id | uuid NOT NULL FK organizations(id) | RLS shape 1 |
| period | text CHECK IN ('daily','monthly') | |
| period_key | text | `YYYY-MM-DD` / `YYYY-MM`, matches `ai_cost_usage` |
| threshold_pct | smallint CHECK 1..100 | |
| cap_cents | integer | snapshot at crossing |
| used_cents | integer | snapshot at crossing |
| billing_source | text CHECK IN ('platform','partner_key') | drives email copy |
| created_at | timestamptz default now() | |
| delivered_at | timestamptz NULL | set by the worker after in-app + email + publish |
| delivery_attempts | integer NOT NULL default 0 | |
| last_delivery_error | text NULL | |
| recipient_count | integer NULL | for the UI marker and support |

- `UNIQUE (org_id, period, period_key, threshold_pct)`;
  partial index `(created_at) WHERE delivered_at IS NULL` for the reconcile scan.
- Migration: one file, idempotent, RLS enabled + forced + `breeze_has_org_access(org_id)`
  policy in the same file; mirror `2026-09-25-ai-agents-ticket-triage.sql`. **Name it to sort
  after the newest committed migration** (`2026-09-27-technician-ticket-write-permissions.sql`
  as of 2026-09-01), e.g. `2026-09-28-ai-budget-alert-events.sql`; the `ai_budgets` column can
  ride in the same file. No inner `BEGIN/COMMIT`.

Registration checklist (the part review has caught 0/5 times — grep, don't judge):

- `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`), alphabetical; FK has no
  `ON DELETE`, so it must precede `organizations` — the contract test asserts order.
- `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`): new table, every
  column `included` (no jsonb); **and** the new `ai_budgets.alert_threshold_pcts` column on the
  already-registered `ai_budgets` entry (`included`).
- `orgMergeRegistry.ts`: `{ kind: 'repoint-dedupe', key: ['period','period_key','threshold_pct'] }`
  (same shape as `ai_cost_usage`).
- No `device_id` → no device cascade lists. Shape 1 → RLS coverage is auto-discovered.

### 4.4 Delivery worker

`jobs/aiBudgetAlertDelivery.ts` — BullMQ queue `ai-budget-alert-delivery`, `jobId = event id`
(idempotent re-enqueue), 5 attempts, exponential backoff. Under a system DB context:

1. Load event + org (name, partner) ; skip if already `delivered_at`.
2. Resolve recipients (§4.6). Zero recipients → mark delivered with `recipient_count = 0`
   and log at warn (Sentry message, hourly-throttled per partner).
3. In-app: `createNotification` per recipient — `type: 'ai'`, `dedupeKey:
   ai-budget-alert:<eventId>`, `priority: 'high'` for rung ≥ 95 else `'normal'`, link to the
   org's AI usage settings page (`/settings/ai-usage`; verify it resolves for partner users
   viewing another org). Idempotent by
   dedupe key, so retries are safe.
4. Email (policy in §4.5): **one message with all recipients in `to`** (colleagues of the same
   MSP; one SMTP call, so a retry after a mid-send failure cannot half-duplicate). Skip silently
   when `getEmailService()` is null (self-hosted without SMTP) — in-app still counts as delivered.
5. `publishEvent('ai.budget.threshold_crossed', {...})` — new `EVENT_TYPES` entry, payload
   `{orgId, period, periodKey, thresholdPct, capCents, usedCents, billingSource}`. Future
   org-level channel routing (§8) subscribes here.
6. `UPDATE ... SET delivered_at = now(), recipient_count = n`. Failures: increment
   `delivery_attempts`, store `last_delivery_error`, rethrow for BullMQ retry; the reconcile job
   (§4.2 #4) is the backstop.

### 4.5 Email policy (noise control)

| Ladder | In-app | Email |
|---|---|---|
| monthly 50/80/95 | yes | yes |
| monthly 100 | yes | yes |
| daily 50/80/95 | yes | **no** |
| daily 100 | yes | yes |

Rationale: a daily ladder that emails at three rungs every day is fatigue, not predictability.
Not configurable in this wave.

### 4.6 Recipients

`resolveUsersWithPermissionForOrg(orgId, PERMISSIONS.BILLING_MANAGE)` — generalise
`resolveIntentApprovers` (wildcard-aware role lookup; active org members holding a granting
role ∪ active partner users of the owning partner whose `org_access`/`org_ids` cover the org).

- Seeded Partner Admin (`*:*`) qualifies → matches the issue's "partner admins".
- Seeded Org Admin does not (no `billing:manage`) — a client-side org login cannot raise a
  partner-locked cap anyway.
- Why not `organizations:write` (the permission that gates `PUT /ai/budget`)? It is held by
  every technician who can edit orgs: 10 techs × 50 orgs × 3 rungs is spam, and money alerts
  belong with the money permission. Open question §9 Q1.

### 4.7 Copy

- Title: `AI budget at 80% — <Org name> (monthly)`; 100 %: `AI budget reached — <Org name> (monthly)`.
- Body: used `$X.XX of $Y.YY` this `<period>`; resets `<UTC date>`; "Billed to Breeze AI
  credits" **or** "Billed to your Anthropic API key" from `billing_source`; at 100 %: "AI
  features are paused for this organization until the period resets or the cap is raised."
- CTA button → the org's AI usage page. English only (matches every existing transactional
  email). Web UI strings go into **all** locale files (tr-TR parity test).

### 4.8 API changes

- `PUT /ai/budget` and partner settings `aiBudgets` accept `alertThresholdPercents` (§4.1).
- `GET /ai/usage` gains `alerts: { thresholds: number[], fired: Array<{period, periodKey,
  thresholdPct, createdAt, deliveredAt}> }` for the current daily + monthly periods.
- **Bug fix in the same wave:** `getUsageSummary` (`aiCostTracker.ts:1274+`) returns the raw
  `ai_budgets` row as `budget`, not the effective (partner-overridden) values, so the page's
  "of $limit" is wrong under a partner lock. Use `getEffectiveAiBudget`.

### 4.9 Web

- `PartnerAiBudgetsTab.tsx` (partner-wide) and `AiUsagePage.tsx` (org):
  a "Warn at" chip/multi-value input (defaults shown greyed when inheriting), lock indicator
  from `locked[]`, helper text "Partner admins with billing access are notified in-app; monthly
  and cap-reached alerts are also emailed." Mutations via `runAction`.
- `AiUsagePage.tsx`: show fired markers for the current periods ("80 % alert sent 3 Sep").
- `data-testid`s on the new inputs for Playwright.

### 4.10 Tests

- Unit (`services/aiBudgetAlerts.test.ts`): boundary (79.99 % no, 80 % yes), jump 40→96 fires
  95 only, cap raised → no re-fire, cap lowered → fires, disabled org, `0`/null cap treated as
  no cap, empty ladder still fires 100, BYOK `billing_source` stamped from the resolver, UTC
  rollover re-arms.
- Worker: retry idempotency (second run creates no new notifications, sends no second email),
  email skipped without email service, zero-recipient path marks delivered.
- Recipients: partner admin yes; org admin no; inactive user no; partner user whose `org_ids`
  exclude the org no; custom role with `billing:*` yes.
- Integration (need a DB, run `vitest.integration.config.ts` locally): RLS coverage (auto),
  `tenantCascade.integration.test.ts`, `tenant-export-policy` + `tenantExportErasureRoundtrip`,
  org-merge registry, migration idempotency (`autoMigrate.test.ts`), one test that a real
  `recordUsage` crossing 80 % produces exactly one event row under two concurrent recorders.
- Web: form round-trip + lock rendering (Vitest); Playwright spec for the settings input.
- Verify as `breeze_app`: cross-tenant insert into `ai_budget_alert_events` fails with 42501.

## 5. Wave 2 — partner AI credit low-balance alerts (breeze-billing + small API surface)

### 5.1 Semantics: replenishment epoch, not billing period

Percent consumed is measured against the balance at the **last replenishment**:

- `billing_credit_balances` gains `epoch_baseline integer NOT NULL DEFAULT 0`,
  `epoch_started_at timestamptz`, `notified_threshold_pcts integer[] NOT NULL DEFAULT '{}'`
  (boot-time idempotent DDL in `ensureSchema.ts`; there is no migration runner).
- Baseline := `included + purchased` immediately after `resetIncludedCredits`,
  `addPurchasedCredits`, and any admin grant; on first creation baseline := initial balance.
  On re-baseline, clear rungs **> current pct** and keep rungs ≤ it (a small top-up must not
  re-fire 50 %).
- `pct = floor((baseline - remaining) * 100 / baseline)` when `baseline > 0`, else no alerts.
- Fixed ladder `{50, 80, 95, 100}` for this wave (per-partner config later if asked).

This works for community (allowance resets monthly → new epoch), for purchased-only wallets
(epoch = last pack), and for mixed wallets, without reconstructing history from
`billing_credit_transactions`.

### 5.2 Evaluation and delivery

- Evaluate **inside `deductCredits`** right after the balance UPDATE (authoritative
  post-deduction number; the API pre-check is stale by one turn). Claim rungs with one atomic
  `UPDATE ... SET notified_threshold_pcts = (SELECT array_agg(DISTINCT x) FROM unnest(... || $rungs) x)
  WHERE NOT ($rung = ANY(notified_threshold_pcts)) RETURNING` — highest rung only, monotonic.
- On claim → `sendEmail` to `partners.billingEmail` using `creditsLowEmail` (subject/body
  revised to "used X of Y credits since your last top-up/reset; ~N days at the last 7 days'
  burn"), and a new `creditsExhaustedEmail` at 100 %. If the send throws, `array_remove` the
  rung so the repair job retries.
- Hourly node-cron repair job (pattern: `deviceCountReconciler`) re-evaluates every balance
  and re-attempts unclaimed rungs; also the only path when deductions stop (nothing to
  trigger inline).
- **Pre-requisite fix:** clamp `from_purchased` to `purchased_balance` in `deductCredits` and
  return the true `creditsDeducted`, so the balance stops at 0 and "exhausted" means exhausted.

### 5.3 API surface

- `checkBillingCreditsDetailed` already receives `remainingCredits/includedBalance/purchasedBalance`;
  cache the last response per partner in Redis (60 s) and expose it as `GET /ai/usage.credits`
  (`null` when no billing service — self-hosted — or when `billedTo === 'partner_key'`).
- Web `AiUsagePage.tsx` + `AiCostIndicator.tsx`: "Breeze AI credits: 1,240 remaining" for
  platform-billed orgs.

### 5.4 Tests

breeze-billing has no CI: run `vitest` locally and paste output in the PR. Cases: epoch
re-baseline on reset/purchase/grant, rung claim monotonicity, top-up keeps rungs ≤ pct,
send-failure un-claims, clamp fix (no negative purchased balance), cron repair fires after an
inline failure.

### 5.5 Deferred

In-app notifications for credits (billing has no clean write path into `user_notifications`;
the right seam is an internal API endpoint or event that wave 3 can add).

## 6. Edge cases

- **Self-hosted:** no billing service → `credits` is `null`, org-budget alerts unaffected.
- **BYOK:** org budgets still apply (unchanged since #3228), so wave 1 fires for BYOK partners
  with the Anthropic-key copy; credit alerts (wave 2) never fire for them.
- **Partner-locked cap:** recipients are partner-side by construction (§4.6), so the people
  notified can act.
- **Cap = 0:** validators accept `0`, enforcement treats it as unlimited (truthiness at
  `aiCostTracker.ts:458,483`); the evaluator mirrors enforcement. Tightening validators to
  `min(1)` is a separate hygiene change (existing rows may hold `0`).
- **Org deleted mid-flight:** worker finds no org → mark delivered with `recipient_count 0`.
- **Notification link scoping:** the link must resolve for partner users viewing another
  org; confirm the `/settings/ai-usage` link carries the org context the way other
  org-scoped notification links do.

## 7. Rollout

- Wave 1 ships behind nothing: defaults fire only for orgs that already have a cap set (most
  orgs have `null` caps → no events). No backfill.
- Wave 2 requires a breeze-billing deploy (manual, both regions) **before** the API surfaces
  `credits`; the API tolerates the old response shape (fields already present).
- Docs: `update-breeze-docs` for the AI usage page; release notes entry.

## 8. Follow-ups to file (not in scope)

1. Org-level (device-less) alerts through the channel/routing pipeline → Slack/Teams/webhook
   for budget and credit events (subscribe to `ai.budget.threshold_crossed`).
2. Atomic spend reservation for concurrent turns (the "within 10 %" hard guarantee).
3. Per-org recipient overrides for budget alerts.
4. Validator `min(1)` for budget cents.

## 9. Decisions (approved by Todd 2026-09-01 — the recommendation in each is final)

**Q1 — Recipients: `billing:manage` holders covering the org (partner admins), or
`organizations:write` (the permission that can actually edit the cap)?**
- **A — billing:manage**: pro: matches "partner admins", low noise; con: a custom tech role
  that can edit budgets but lacks billing gets nothing.
- **B — organizations:write**: pro: everyone who could raise the cap; con: every org-editing
  tech is spammed, seeded Org Admin still excluded.

**Recommend A** — money alerts follow the money permission; overrides come later (§8.3).

**Q2 — Daily-ladder emails: in-app only for daily 50/80/95 (email only at daily 100 and all
monthly rungs), or email everything?**

**Recommend in-app only for daily pre-cap rungs** — a daily cap emails three times a day
otherwise.

**Q3 — Build wave 2 (credits) now, in the no-CI billing repo, or ship wave 1 alone?**

**Recommend both** — the credits stop is the same surprise, the prospect is hosted, and the
over-deduct clamp is a real bug regardless. Sequence wave 1 first.

**Q4 — Credit ladder fixed at {50,80,95,100} vs partner-configurable?**

**Recommend fixed** for this wave.

## 10. Advisor quorum record

Codex (gpt-5.6-sol, xhigh, read-only) reviewed the initial Fable position on 2026-09-01.
Adopted from Codex: durable `ai_budget_alert_events` table with delivery state instead of an
`int[]` claim on `ai_cost_usage` (crash and delivery-failure holes); credits measured against a
persisted replenishment baseline instead of the Stripe billing-period opening balance
(purchased credits persist across resets); recipients narrowed from `organizations:write`;
evaluate credits inside `deductCredits` with cron as repair; `/ai/usage` effective-budget bug;
`deductCredits` negative-balance bug; separate daily/monthly email policy; explicit zero-cap
semantics; `billing_source` from the live resolver. Rejected: none. Both agree wave 1 uses
`user_notifications` + transactional email and that org-level channel routing is a separate epic.
