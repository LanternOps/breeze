---
title: Alert re-arm lifecycle — anchored episodes + partner/org lifecycle defaults
status: draft (Gate A, awaiting owner approval)
date: 2026-10-29
origin: "#10538 (an MSP migrating from ConnectWise Automate: UPS 'On Battery' event_log alert must clear on 'Power Restored' and close the PSA ticket); owner direction 2026-10-29"
related: "#10499 (alert → PSA ticket, close-on-resolve), 2026-09-19-alerting-consolidation-design.md, 2026-09-21-metric-anomaly-episodes-design.md"
tracking_issue: (assigned by feature-lifecycle after plan approval)
effort: M (3 waves)
---

# Alert re-arm lifecycle

## 1. Problem

An MSP migrating its UPS alerting from ConnectWise Automate wants an `event_log` monitor
("APC: On Battery") to resolve itself when the recovery event ("Power Restored") arrives, and
— once #10499 lands — to close the PSA ticket it opened. Breeze has most of the parts, but the
lifecycle around them is wrong for event-shaped evidence:

1. **A stale recovery event resolves a new alert.** Auto-resolve conditions are evaluated with
   only a device id. The `event_log` handler counts events in a rolling window ending *now*, so a
   "Power Restored" left in the window by the previous outage satisfies the recovery condition
   on the first auto-resolve sweep of the next outage.
2. **A resolved alert re-fires on the same evidence.** The trigger is the same rolling-window
   count. After the alert resolves, the original "On Battery" event is still inside the window;
   dedupe only looks at open alerts, and the post-resolve cooldown is a few minutes. When the
   cooldown expires the alert reopens, auto-resolves again, and loops until the trigger event
   ages out of the window. With PSA close-on-resolve, every loop opens and closes a ticket.
3. **Noise controls exist only per object.** Cooldown, auto-resolve and recurrence are set per
   monitor (and per legacy template/rule). An MSP cannot say "across my partner, alerts re-arm
   only on new evidence" once and have every org inherit it. No "re-arm" concept exists.
4. **The recovery condition is API-only.** The monitor editor exposes only the `autoResolve`
   switch; `autoResolveConditions` is accepted as an untyped record and copied raw onto the
   compiled template, never compiled through the kind spec.

The owner's direction: fix (1) and (2) in the engine — an alert re-arms only on *new evidence*
by default, without a setting to opt into correctness — then add standard lifecycle settings
with one home per level (partner default → org override → per-monitor override), and fold the
`event_log` "Clears when" editor work of #10538 into the same program.

## 2. Current state

Read on `main` @ `41c790d3cd` (2026-10-29). "Verified" = read in code at the cited lines;
"inferred" = follows from the code read but not executed.

| # | Fact | Evidence | Label |
|---|---|---|---|
| C1 | Monitor noise/recovery fields: `cooldownMinutes` (default 5), `autoResolve` (default false), `autoResolveConditions` (`z.record(unknown)`), `recurrenceThreshold/WindowHours/Actions`. | `packages/shared/src/validators/monitors.ts:313-332` | verified |
| C2 | `event_log` monitor condition: `category, level, sourcePattern?, messagePattern?, countThreshold (≥1, default 1), windowMinutes (1–1440, default 60)`. No event-id field. | `packages/shared/src/validators/monitors.ts:80-91` | verified |
| C3 | Monitor compile copies `autoResolve`, `autoResolveConditions` (raw) and `cooldownMinutes` onto the alert template; the trigger condition goes through the kind spec (`toAlertCondition`), the recovery condition does not. | `apps/api/src/services/monitors/monitorCompiler.ts:136-142, 162-164` | verified |
| C4 | The same three fields also live on `alert_templates` (NOT NULL defaults), `alert_rules.override_settings` (jsonb) and `config_policy_alert_rules` (NOT NULL defaults). | `apps/api/src/db/schema/alerts.ts:61-63`; `apps/api/src/db/schema/configurationPolicies.ts:233-235`; `apps/api/src/services/alertService.ts:243-245` | verified |
| C5 | No partner- or org-level default for any of them; no "re-arm" concept anywhere (`grep -ri rearm\|re-arm` empty outside this spec). | `apps/api/src/db/schema/orgs.ts` (partners, organizations) | verified |
| C6 | Web: only the monitor editor edits cooldown/auto-resolve; it exposes the `autoResolve` checkbox and never the recovery condition. | `apps/web/src/components/monitoring/MonitorEditor.tsx:78-79, 118-119, 403-404, 516-517, 900-916` | verified |
| C7 | Cooldown is a Redis key per `ruleId:deviceId[:subject]` with TTL; adaptive multiplier doubles it (cap 4×) on re-trigger within an hour; in-memory fail-closed fallback. | `apps/api/src/services/alertCooldown.ts:65-137` | verified |
| C8 | Flapping: Redis ring buffer of trigger/resolve transitions; hard-coded 4 transitions in 10 min; not configurable. | `apps/api/src/services/alertCooldown.ts:337-399` | verified |
| C9 | `createAlert` order: rule active → cooldown → dedupe against OPEN alerts (`active`/`acknowledged`/`suppressed`) for rule+device+subject → flapping → insert (`ON CONFLICT` on the open-alert unique index) → publish → cooldown set. | `apps/api/src/services/alertService.ts:202-378`; unique index `apps/api/src/db/schema/alerts.ts:195-197` | verified |
| C10 | Sweep: every 60 s, `evaluateDeviceAlertsInMode` evaluates `effectiveConditions` for each applicable rule, records the monitor breach/ok observation, then calls `createAlert`. | `apps/api/src/jobs/alertWorker.ts:425-431`; `apps/api/src/services/alertService.ts:1187-1400` (evaluate `:1243`, episode `:1309`, create `:1365`) | verified |
| C11 | Auto-resolve runs only for `status = 'active'` — an **acknowledged** alert never auto-resolves. | `apps/api/src/services/alertService.ts:524, 1470` | verified |
| C12 | `checkAutoResolve` passes only `alert.deviceId` to the evaluator (inverse-of-trigger at `:581`, explicit recovery at `:592`); the alert's `triggeredAt` and any evidence watermark are never consulted. | `apps/api/src/services/alertService.ts:516-600`; `apps/api/src/services/alertConditions/index.ts:338-361` | verified |
| C13 | `ConditionHandler.evaluate(condition, deviceId)` has no context parameter. | `apps/api/src/services/alertConditions/registry.ts:10-15` | verified |
| C14 | `event_log` handler counts rows with device `timestamp >= now − windowMinutes`; returns `passed = count ≥ countThreshold`. | `apps/api/src/services/alertConditions/handlers/eventLog.ts:14-58` | verified |
| C15 | `device_event_logs.timestamp` is the device clock (timestamptz); `created_at` is server ingest time (timestamp, no tz); unique `(device_id, source, event_id)`, insert `ON CONFLICT DO NOTHING`. | `apps/api/src/db/schema/eventLogs.ts:30, 34, 37, 45`; `apps/api/src/routes/agents/eventLogs.ts:356` | verified |
| C16 | `resolveAlert` sets a post-resolve cooldown from rule/template with fallback **15** (create path falls back to **5**), records a `resolved` flap transition and publishes `alert.resolved`. Manual-resolve routes repeat the same cooldown write. | `apps/api/src/services/alertService.ts:815-958` (cooldown `:909-925`); `apps/api/src/routes/alerts/alerts.ts:1025-1043`; `apps/api/src/routes/mobile.ts:1271` | verified |
| C17 | Resolution reasons: `condition_cleared`, `source_retired`, `expired`, `manual`. | `packages/shared/src/constants/fixMemory.ts:49` | verified |
| C18 | `alerts.triggered_at`/`resolved_at`/`dismissed_at` are `timestamp` without tz (server clock). Indexes: `(device_id, triggered_at DESC)`, `(rule_id)`, `(org_id, rule_id, triggered_at)`; none covers "newest closed alert for rule+device". | `apps/api/src/db/schema/alerts.ts:153-165`; `apps/api/migrations/2026-05-17-b-alerts-scale-indexes.sql`; `2026-10-16-183500-impact-measured-indexes.sql:23-24` | verified |
| C19 | Monitor breach episodes (`monitor_episodes`, `monitor_device_state`) are driven by the sweep's breach/ok observation, not by alert status; an `ok` observation closes the open episode as `recovered`; recurrence counts episodes in a window. | `apps/api/src/services/monitors/episodeService.ts:1-20, 136-300` | verified |
| C20 | Consequence (a) of #10538: a recovery event left in the window resolves a new alert on the first auto-resolve sweep. | C12 + C14 | inferred |
| C21 | Consequence (b): after resolve, the trigger event is still in the window → trigger stays true → the alert reopens when the post-resolve cooldown (5–15 min, up to 4× adaptive) lapses, and resolves again; the loop ends only when the trigger event ages out. Because the trigger stays true, the breach episode also stays open through the loop. | C9 + C14 + C16 + C19 | inferred |
| C22 | Suppression expiry returns the alert to `active` (does not close it). | `apps/api/src/jobs/suppressionExpiryReaper.ts:65-77` | verified |
| C23 | `APCPBEAgent` (APC PowerChute) is already on the Application **Information** provider allowlist, so "Power Restored" (Information level) is collected on Windows. | `packages/shared/src/validators/eventLogProviders.ts:37` | verified |
| C24 | PSA close-on-resolve does not exist yet; #10499 proposes a subscriber on `alert.resolved`. Any open/resolve loop becomes ticket churn once it does. | `gh issue view 10499` (Gap 1, W2) | verified (issue text) |

## 3. Goals and non-goals

**Goals**

- G1. An alert from an evidence-based condition re-opens only on evidence it has not already
  consumed, and resolves only on recovery evidence newer than its own trigger evidence.
- G2. One lifecycle model for every alert rule, with state-based conditions keeping their
  current (naturally correct) behaviour.
- G3. Lifecycle settings — auto-resolve, re-arm, cooldown — with one home per level:
  partner default → org override → per-monitor override, one resolver, effective values
  snapshotted on the alert.
- G4. The `event_log` "Clears when" condition is authorable in the monitor editor, validated
  against the kind's schema, compiled through the kind spec, and documented.

**Non-goals**

- Configurable flapping thresholds (C8 stays hard-coded; follow-up if asked).
- PSA ticket creation/closure itself (#10499). This spec only guarantees that `alert.resolved`
  fires once per real recovery.
- Lifecycle inheritance for legacy, non-monitor alert paths (built-in templates, policy and
  compliance bridges, patch alerts, `config_policy_alert_rules`). They get the engine fix
  (anchoring) but keep their explicit cooldown/auto-resolve values (§6.7).
- Event-id matching for `event_log` conditions (follow-up §13).

## 4. Decisions

| ID | Decision | Owner direction / quorum |
|---|---|---|
| D1 | Re-arm on new evidence is an **engine property**, not an opt-in: every evidence-based condition is anchored to its episode. | Owner (2026-10-29). Codex: see §12. |
| D2 | Conditions are classified **evidence** vs **state** in the handler registry; only evidence handlers consume anchors. `event_log` is the only evidence handler today. | Own position; quorum §12 |
| D3 | Both anchors are one **consumed-evidence cursor** per episode (per evidence leaf), set at creation, advanced by the sweep while open, frozen at close; read from the newest closed alert for rule+device+subject. No server-clock comparison against `resolved_at`. | Revised after quorum (§12) |
| D4 | Evidence ordering uses the device's own event order — Windows `(logName, recordId)` where available, else `(timestamp, created_at, id)` — never `alerts.triggered_at`. Ties resolve toward ending churn. | Own position, tie rule from quorum |
| D8 | Re-arm adds "at least one unconsumed matching event" to the trigger; it does not filter the rolling count, so `countThreshold > 1` keeps its meaning. | Revised after quorum (§12) |
| D9 | Acknowledged and suppressed alerts auto-resolve on recovery (as subject alerts already do); `requiresHuman` alerts never do. | Own position + quorum agree; OD3 |
| D5 | Lifecycle settings live in **dedicated columns** on `partners` (NOT NULL defaults) and `organizations` (NULL = inherit), plus nullable per-monitor overrides on `monitor_definitions`. No new table; not a configuration-policy feature. | Own position; quorum §12; OD2 |
| D6 | Effective lifecycle is snapshotted onto `alerts.context.lifecycle` at creation (settings rule 6). | Own position |
| D7 | The "Clears when" recovery condition is authored in the monitor's kind shape and compiled through the kind spec, like the trigger. | Own position (fixes C3) |

## 5. Episode anchoring (engine, W1)

### 5.1 Vocabulary

- **Episode** — the life of one alert for one rule + device (+ subject): opens at insert, closes
  when the alert reaches `resolved` or `dismissed`. (Distinct from the monitor breach episode of
  C19, which tracks raw observations; §5.5 and §5.8 keep the two aligned.)
- **Evidence condition** — a leaf whose truth is a count of discrete, timestamped events in a
  window (`event_log`). Old events stay true until they age out, so "true" does not mean
  "happening now".
- **State condition** — a leaf that reads current or recent sampled state (thresholds, metrics,
  offline, service/process, patch compliance, cert expiry, AV, backup continuity, network
  errors as a rate over samples, script results). It is true only while the state holds.
- **Evidence cursor** `K` — the newest trigger-matching event the episode has observed, in
  the device's event order (§5.3).

### 5.2 Handler contract

`ConditionHandler` gains an optional context and an optional result field:

```ts
interface ConditionEvalContext {
  /** Evidence handlers additionally require >= 1 matching row ordered after this cursor. */
  evidenceAfter?: EvidenceCursor;   // { ts, createdAt, id, logName?, recordId? }
}
interface ConditionHandler {
  type: string;
  evidence?: boolean;              // D2 — true only for event-shaped handlers
  evaluate(condition: unknown, deviceId: string, ctx?: ConditionEvalContext): Promise<ConditionResult>;
}
// ConditionResult gains: evidenceWatermark?: EvidenceCursor  (newest row it matched)
```

`evaluateConditions` and `evaluateAutoResolveConditions` thread `ctx` to every leaf; state
handlers ignore it. The `event_log` handler keeps its windowed count unchanged and, when a
cursor is given, also requires one matching row ordered after it (§5.4; the window still
applies — an anchor narrows, never widens). It returns the newest matching row as
`evidenceWatermark`. A rule whose condition tree contains no evidence leaf skips all
anchor lookups (zero added cost for the common case).

### 5.3 The evidence cursor (revised after quorum, §12)

Each episode carries an **evidence cursor** `K`: the newest trigger-matching event the episode
has *observed*. It is the single anchor for both sides of the lifecycle; no server-clock
comparison against `resolved_at` is used (the first draft did, and the quorum showed it
swallows a trigger ingested in the seconds between the last sweep and a manual resolve).

- **Ordering key.** Events are ordered by `(timestamp, created_at, id)` from `device_event_logs`,
  except that two Windows events from the same `details.logName` are ordered by
  `details.recordId` (the log's own sequence, `agent/internal/collectors/eventlogs_winstreams.go:53-58`).
  Reason: ingest clamps unparseable or future timestamps to the batch receipt time
  (`apps/api/src/routes/agents/eventLogs.ts:50-56, 273-276`), so a trigger and its recovery can
  carry identical timestamps; the record id breaks that tie causally. Where neither the record
  id nor the timestamp separates two events, the tie is treated as **consumed** on the trigger
  side (no re-open) and as **after** on the resolve side (recovery wins) — both choices end
  churn rather than start it.
- **Set** at alert creation from the trigger evaluation's `evidenceWatermark`.
- **Advanced** by every sweep while the alert is open: the sweep already evaluates the trigger
  for open alerts and dedupe stops the insert; the evaluation's watermark is written back to
  the open alert with an advance-only guarded update (`... WHERE status IN (open) AND
  cursor < new`). The write happens only when the watermark moves.
- **Frozen** when the alert reaches `resolved` or `dismissed`. For a recovery close, the cursor
  is set to `max(K, recovery event)` in the same CAS update that resolves the alert.
- **Never advanced by a blocked admission.** If cooldown, flapping or the maintenance window
  stops an insert, no episode exists, nothing is consumed, and the evidence is still new on the
  next sweep (it fires once the block lifts, while it is still in the window).

Because the cursor lives on the alert row and is maintained by the sweep, terminal writers
(HTTP and mobile resolve, bulk and correlation actions, the `manage_alerts` AI tool, Partner API
write-back at `routes/partnerApi/alertWrites.ts:128`, a future PSA close sync) need no change
to be correct; only the recovery path writes it. This matters because the HTTP resolve route
writes the row directly instead of calling `resolveAlert` (`routes/alerts/alerts.ts:1005-1015`).

### 5.4 Trigger side: when may a closed episode re-open?

Before evaluating a rule with an evidence leaf for a device, the sweep reads `K` from the
newest closed alert for `(rule_id, device_id, subject_key)`. The evidence leaf then passes when:

```
count(matching events in window) >= countThreshold      -- unchanged rolling-count meaning
AND exists(matching event in window ordered after K)    -- at least one unconsumed event
```

This keeps `countThreshold` a rolling count (five errors in 60 minutes still means five in the
window, old ones included) and adds only "something happened that this rule has not already
alerted on". The first draft filtered the count itself to post-close events, which the quorum
showed would delay a legitimate threshold alert (five old errors + one new no longer reaches
five); the `exists` form removes that change for `countThreshold > 1` and is identical for the
common `countThreshold = 1`.

The effective **re-arm** setting (§6.1) selects the anchor:

- `new_evidence` (default): apply the `exists after K` clause.
- `after_delay N`: apply it until N minutes after the close; after that, evaluate without it, so
  evidence still in the window may re-open the alert (today's behaviour, as an explicit choice).

No closed episode → no clause (the first alert behaves as today). Ack and suppress are open
states and are not re-arm boundaries.

### 5.5 Resolve side: what may clear an open episode?

When the rule has an explicit recovery condition with an evidence leaf, the auto-resolve check:

1. Re-reads `K` from the open alert (already advanced by the sweep; the check also advances it
   from a fresh trigger read so a repeat "On Battery" between sweeps is not missed).
2. Evaluates the recovery condition with "at least one matching recovery event ordered after
   `K`" (plus its own `countThreshold`/window).
3. Resolves in one CAS update that also freezes `K = max(K, recovery event)`, and records an `ok`
   observation for the monitor breach episode in the same step (§5.8), so the breach episode
   cannot outlive the alert and absorb the next outage.

`alerts.triggered_at` is not used as the resolve anchor: it is server time at the inserting
sweep, which lags the device event by up to one sweep plus ingest delay, so a recovery logged
30 s after the trigger could be older than `triggered_at` and never clear the alert.

The inverse-of-trigger path (no recovery condition) is unchanged: the trigger is evaluated with
the clause anchored to the *previous* episode, so it stays true while this episode's own
evidence is in the window and clears when that evidence ages out.

Recovery requires affirmative evidence; an `unknown` data state never resolves.

### 5.6 State conditions

State conditions are not anchored. They already need a fresh breach: after an inverse
auto-resolve the condition is false until the state breaches again. A **manual** resolve while
the state still breaches re-opens after the cooldown, as today (C16): the operator resolved
something that is still true, and acknowledge or suppress is the tool for "I know". OD4 asks
whether to make state conditions edge-triggered; recommendation is to keep today's behaviour.

Mixed trees (`and`/`or` of evidence and state leaves): each evidence leaf carries its own clause
and contributes its own watermark; the episode's cursor is per evidence leaf, keyed by the
leaf's path in the compiled condition (`K` is a small map, not a scalar). State leaves are not
anchored; the tree combines as today. A condition edit that changes a leaf's path resets that
leaf's cursor to "none" (fires as today once, then anchors).

### 5.7 Where the cursor lives, and cost

- `alerts.context.lifecycle = { cursor: { <leafPath>: {ts, createdAt, id, logName?, recordId?} },
  rearm, cooldownMinutes, autoResolve, sources, monitorCompiledHash }`. `alerts.context` is
  already `excludedOpen` in the export policy (no classification change). OD12 asks whether the
  cursor deserves a dedicated column instead of jsonb.
- Close lookup index (W1, built `CONCURRENTLY` with the migration runner's supported directive):
  `alerts_rule_device_subject_closed_idx ON alerts (rule_id, device_id, COALESCE(subject_key,''), COALESCE(resolved_at, dismissed_at) DESC) WHERE rule_id IS NOT NULL AND status IN ('resolved','dismissed')`.
- `device_event_logs` has only `(device_id)`, `(org_id, timestamp)` and `(category, level)`
  indexes (`apps/api/src/db/schema/eventLogs.ts:39-45`). The `exists after K` probe is cheap on
  the device index for typical per-device volumes; W1 benchmarks it against a seeded high-volume
  device and adds `(device_id, timestamp DESC)` concurrently only if the plan needs it.
- The anchor read runs only for rules with an evidence leaf; closed-alert reads and partner/org
  lifecycle rows are batched per device per sweep (one query for all evidence rules on the
  device). No Redis state, so a Redis outage cannot reset anchors (unlike C7).

### 5.8 Interactions

| Mechanism | Behaviour after this spec |
|---|---|
| Dedupe (C9) | Unchanged; still the first gate while an episode is open. The cursor only matters after close. |
| Cooldown (C7, C16) | Unchanged meaning: minimum quiet time after an alert opens or closes, including the adaptive multiplier. The 15-vs-5 fallback split is removed — every read goes through the lifecycle resolver (§6.3). A genuinely new event inside the cooldown is delayed until it lapses, not lost — unless `windowMinutes` is shorter than the (multiplied) cooldown, in which case it ages out first. OD5. |
| Flapping (C8) | Unchanged. Loops caused by stale evidence disappear, so flap suppression only sees real flaps. A flap-suppressed evaluation consumes nothing (§5.3). |
| Acknowledge | Open; dedupe holds. Auto-resolves on recovery (OD3, recommended yes). |
| Suppress / suppression expiry (C22) | Open; dedupe holds. Auto-resolves on recovery (OD3), matching what subject alerts already do (`alertSubjects.ts:70-80` resolves any `RESOLVABLE_ALERT_STATUSES` alert). Expiry still returns an unrecovered alert to `active`. |
| `requiresHuman` recurrence alerts | Never auto-resolved (unchanged, `alertService.ts:536`, `:1470`). |
| Monitor breach episodes / recurrence (C19) | The sweep's breach/ok observation comes from the anchored trigger, and a recovery close records `ok` in the same step (§5.5). The breach episode ends with the alert instead of at window age-out, so recurrence counts real outages. Behaviour change for event-based monitors with `recurrenceThreshold` — §8. |
| Maintenance window | Sweep skips non-subject rules while suppressed (`alertService.ts:1224, 1289`); nothing is consumed, so events logged during the window are new afterwards. Same as today. |
| Subject (hardware) alerts | Own path (`evaluateSubjectAlerts`); `checkAutoResolve` skips them (`:530`). No evidence handler is a subject handler today; the index and cursor key include `subject_key` so one can be added later. |
| #10499 PSA close-on-resolve | One `alert.resolved` per real recovery. A PSA- or Partner-API-originated close is a `manual` resolve; the frozen cursor stops the same outage from re-opening a ticket, and a trigger the sweep never observed still re-opens it. |
| Partner-wide monitors | One compiled template serves every org; lifecycle values are resolved per alert against the **device's** org and its partner at evaluation time, never at compile time (§6.3). |
| Monitor edited mid-incident | The open alert keeps its snapshotted lifecycle values (§6.4); the recovery condition is evaluated as currently defined, so an operator fixing a wrong recovery pattern fixes the open alert too. `monitorCompiledHash` in the snapshot records which definition opened it. OD11 records the stricter alternative (snapshot predicates too). |

### 5.9 Worked example (UPS)

Window 60 min, `new_evidence`, `countThreshold` 1, recovery "message contains Power Restored".

| Device time | Event | Before (today) | After |
|---|---|---|---|
| 10:00 | On Battery | Alert A opens 10:01 | A opens; `K` = 10:00 |
| 10:04 | Power Restored | A resolves 10:05 | A resolves; `K` frozen at 10:04 |
| — | (no events) | Cooldown lapses ~10:10–10:20 → A' opens (10:00 still in window), resolves on 10:04; loop until 11:00 | No trigger event after `K` → no alert; breach episode already closed `recovered` |
| 13:00 | On Battery | B opens; **resolves on its first auto-resolve sweep** if a Power Restored is still in its window | B opens; `K` = 13:00; the 10:04 recovery is before `K` → B stays open |
| 13:02 | On Battery (flap) | — | next sweep advances `K` to 13:02 |
| 13:01 | Power Restored (ingested late) | — | before `K` (13:02) → B stays open — correct, power dropped again at 13:02 |
| 13:10 | Power Restored | B resolves | B resolves; `K` frozen at 13:10 |

## 6. Lifecycle settings (W2)

### 6.1 Settings group "Alert lifecycle"

| Setting | Values | Built-in default | Levels |
|---|---|---|---|
| Auto-resolve | on / off | off | partner, org, monitor |
| Clears when (recovery condition) | kind-shaped condition, optional | none (inverse of trigger) | monitor only (it names monitor-specific evidence) |
| Re-arm after resolve | `new_evidence` \| `after_delay` + minutes (1–1440) | `new_evidence` | partner, org, monitor |
| Cooldown | minutes 0–1440 | 5 | partner, org, monitor |

### 6.2 Storage (D5)

- `partners.alert_auto_resolve boolean NOT NULL DEFAULT false`,
  `partners.alert_rearm_mode text NOT NULL DEFAULT 'new_evidence' CHECK (... IN ('new_evidence','after_delay'))`,
  `partners.alert_rearm_delay_minutes integer NULL CHECK (1..1440)` (required iff `after_delay`),
  `partners.alert_cooldown_minutes integer NOT NULL DEFAULT 5 CHECK (0..1440)`.
- `organizations.*` — the same four columns, all nullable, NULL = inherit.
- `monitor_definitions.cooldown_minutes` and `auto_resolve` become nullable (NULL = inherit);
  add `rearm_mode`/`rearm_delay_minutes` nullable. `auto_resolve_conditions` unchanged.
- Dedicated columns, not `partners.settings` JSONB: settings cards replace JSONB sub-objects
  wholesale (#3597, documented on the neighbouring columns at `orgs.ts:56-75`), and the sweep
  needs typed reads. Precedent: `partners.invoice_terms_days` / `organizations.invoice_terms_days`
  with one resolver (`services/invoiceTerms.ts`).

**Why no new table.** These are scalar defaults with exactly one row per partner and per org —
the owners already exist. A `partner_id XOR org_id` table would add RLS, the partner-wide
SELECT branch, cascade/merge/export registration and a CRUD surface to hold four scalars per
owner, and would invite a second row per owner. The Partner-Wide First rule targets
row-shaped config (policies, templates, rules); this is a partner default with an org override,
which the settings rules already model with columns. Tenancy obligations that do apply:
`organizations` is in `CORE_TENANT_EXPORT_POLICY` (`tenantExportPolicyRegistry.ts:1152`), so the
four new org columns are classified `included` (scalars, no secrets); `monitor_definitions`
new columns likewise (`:684`). `partners` is not in the export registry. No cascade/merge
change: org merge keeps the surviving org's columns (OD7 asks whether merge should copy).

**Why not a configuration-policy feature** (the `configuration-policy` skill's "don't skip the
config policy system" guidance argues the other way — recorded as OD2): config policies
resolve per **device** through site/group/device assignments. A lifecycle default resolved per
device would make two devices on the same monitor re-arm differently depending on which policy
won, would put a fourth level (device) under a concept the settings rules cap at partner → org
→ object, and would require a per-device effective-config read on the 60 s sweep for every
alert. Monitors themselves are already attached through config policy; the per-object override
is the monitor.

### 6.3 Resolver (settings rule 5)

`resolveAlertLifecycle({ monitor, rule, template, org, partner })` in `@breeze/shared`
(pure) plus a service loader in `apps/api/src/services/alertLifecycle.ts`:

```
value = monitorOverride ?? orgOverride ?? partnerDefault          // monitor-managed rules
value = rule.override_settings ?? template value                  // legacy rules (§6.7)
```

Returns `{ autoResolve, rearm, cooldownMinutes, source: { autoResolve: 'monitor'|'org'|'partner'|'legacy', ... } }`.
It is the only reader: `createAlert` (`:243-245`), `getApplicableRules` (`:1135`),
`checkAutoResolve` (`:566-576`), `resolveAlert` (`:871-925`), the manual-resolve routes
(`alerts.ts:1025-1043`, `mobile.ts:1271`), `alertSubjects.ts` and `offlineAlertEffects.ts`.
A contract test fails if any other file reads `cooldownMinutes`/`autoResolve` off a rule,
template or monitor row (same shape as `invoiceTerms.test.ts`). The org and partner are the
**device's** org and that org's partner, resolved at evaluation time: a partner-wide monitor
compiles to one shared template (`monitorCompiler.ts:144-170`), so resolving at compile time
would give every org the same answer. Partner and org rows are loaded once per sweep per org,
not per rule.

Settings rule 3 says the org always wins; here a **monitor** override beats the org override.
That is a stated exception (the monitor is the object, like a line on a document), and the UI
must say so where it applies: the monitor editor shows "This monitor overrides the org default
(X)" when a value is set, and the lifecycle card lists the count of monitors overriding each
field.

### 6.4 Snapshot (settings rule 6)

The effective lifecycle and its sources are written to `alerts.context.lifecycle` at creation.
The episode keeps the lifecycle it opened with: a later settings change affects the next
episode, not an open one. The alert detail page shows "Re-arms on new evidence (partner
default)" from the snapshot.

### 6.5 UI home (settings rules 1, 2, 4, 7, 8)

- **Partner default and org override**: a "Lifecycle defaults" card at the top of
  `/alerts/monitors` (Alerts domain, rule 2). At partner scope it edits the partner default;
  with an org selected it edits that org's override, each field showing the inherited value and
  its source, blank = inherit (rule 4). Form card, page Save (rule 7). No new URL, so no new nav
  entry; the card is anchored as `#lifecycle` (OD6 offers a dedicated `/alerts/lifecycle` tab).
- **Monitor override**: the monitor editor's existing noise section becomes "Alert lifecycle":
  auto-resolve (Inherit / On / Off), Clears when (§7), Re-arm (Inherit / New evidence / After N
  minutes), Cooldown (blank = inherit, placeholder shows the inherited value).
- Every field renders the source of its effective value; new locale keys in all 8 locales.

### 6.6 Settings rule 9 statement

- **Home:** Alerts → Monitors → "Lifecycle defaults" card (partner and org); monitor editor
  "Alert lifecycle" section (per monitor).
- **Level:** partner default → org override → monitor override → snapshot on the alert.
- **Resolver:** `resolveAlertLifecycle` (`@breeze/shared`) via `services/alertLifecycle.ts`.
- **Count of places configured, before → after** (UI places a user can edit the concept):

| Concept | Before | After | Notes |
|---|---|---|---|
| Cooldown | 1 (monitor editor) | 2 (lifecycle card at partner/org scope; monitor editor) | +1 = the new partner/org levels; one place per level |
| Auto-resolve | 1 (monitor editor) | 2 (same) | same |
| Recovery condition | 0 (API only) | 1 (monitor editor) | |
| Re-arm | 0 | 2 (same as cooldown) | new concept |

API/storage places that remain and are **not** user-editable in the UI: `alert_templates`,
`alert_rules.override_settings`, `config_policy_alert_rules`. Removal plan: these are the legacy
authoring paths the alerting-consolidation program retires; this spec adds no UI for them and
routes all reads through the one resolver, so retiring them later removes storage only.

### 6.7 Scope of inheritance

Inheritance applies to monitor-managed rules (`alert_rules.managed_by_monitor_id IS NOT NULL`).
Legacy rules keep their explicit template/rule values for cooldown and auto-resolve and get
`new_evidence` re-arm from the engine (their template has no re-arm field; the built-in default
applies). OD8 asks whether legacy rules should inherit the partner/org default instead.

## 7. "Clears when" for event_log (W3, folds in #10538)

- Validator: `autoResolveConditions` becomes kind-aware — for kind `event_log` it must parse
  as the `event_log` monitor condition schema (C2) with `countThreshold` defaulting to 1; for
  other kinds it stays rejected-unless-schema'd (W3 enables `event_log` only; other kinds keep
  inverse-of-trigger). Validation lives in `monitorService` next to the trigger's
  `conditionSchema.parse`.
- Compiler: `buildCompiledTemplate` compiles the recovery condition through
  `spec.toAlertCondition` (D7), so the stored template carries `{ type: 'event_log', ... }` and
  the evaluator recognises it. Existing raw `autoResolveConditions` rows are left untouched
  (they already work or already fail the same way); the editor re-saves them through the new path.
- Editor: when auto-resolve is on and kind is `event_log`, show "Clears when" with category,
  level, source contains, message contains and window, prefilled from the trigger's category
  and source. Inline hint: "Clears only on an event logged after the alert's trigger event."
- Docs: `apps/docs/src/content/docs/features/monitors.mdx` and `alerts.mdx` — the lifecycle
  model (episodes, new evidence, re-arm, cooldown), the defaults card, and a UPS recipe
  (PowerChute provider `APCPBEAgent`, Information level is collected by default, C23).

## 8. Migration, backfill and behaviour change

- **W1 behaviour change (all evidence-based alerts, all customers):** an `event_log` alert no
  longer re-opens unless at least one matching event arrived that the previous episode did not
  observe, and an explicit recovery condition no longer clears an alert with recovery evidence
  older than the trigger. Acknowledged and suppressed alerts start auto-resolving on recovery
  (D9). Observable effects: fewer alerts and `alert.resolved` events for `event_log` monitors
  with auto-resolve or frequent manual resolves; breach episodes for `event_log` monitors end at
  close instead of at window age-out, so `recurrenceThreshold` may count more (shorter,
  separate) episodes. Because the rolling count is unchanged (D8), the only alerts that stop
  are re-opens made entirely of events an earlier episode already observed. The first draft
  claimed "nothing legitimate is delayed"; that was false for its count-filtering form and is
  why D8 exists. **Recommendation:** ship as the default for everyone with a release note
  (self-hoster section); W2's `after_delay` restores the old behaviour per partner/org/monitor.
  OD1 records the quorum's alternative (no blanket conversion of existing monitors).
- **W1 has no setting**, so between W1 and W2 the only behaviour is `new_evidence`. Acceptable:
  no customer can be depending on the loop.
- **W2 migration** (named after the newest committed migration at write time; idempotent;
  elects system scope before the backfill UPDATE): add the partner/org columns; make
  `monitor_definitions.cooldown_minutes`/`auto_resolve` nullable; add monitor re-arm columns;
  `pnpm db:check-drift`.
- **Monitor backfill:** set `cooldown_minutes = NULL` where it equals 5 and `auto_resolve = NULL`
  where false (the old column defaults), so existing monitors inherit. Effective behaviour is
  unchanged at migration time because the partner defaults equal the old defaults; it changes
  only when a partner or org sets a default — which is the point of the feature. A monitor
  whose author deliberately chose 5/false is indistinguishable and will follow the partner
  default (OD9; alternative: keep every existing value explicit).
- Alert templates, rules and config-policy rules: no data change.
- Existing open alerts: no cursor in their context; the first sweep after deploy sets it from the
  trigger evaluation (the newest matching event), so recovery must be newer than that.
- Existing closed alerts: no cursor; the first re-arm read falls back to "events ingested at or
  before the close time are consumed" for that one episode only (a one-time server-clock
  fallback, logged), so deploy day does not produce a burst of re-opens from events still in
  the window.

## 9. Waves

Each wave is independently mergeable, in this order.

| Wave | Scope | Depends on | Effort |
|---|---|---|---|
| W1 — Anchored episodes (engine) | Handler `evidence` flag + context; `event_log` `exists after cursor` clause + watermark + Windows record-id ordering; cursor set/advance/freeze; closed-alert read + concurrent index; recovery close writes the cursor and the breach-episode `ok` in one step; legacy-row fallback; remove the 15/5 cooldown fallback split (single constant until W2); ack/suppressed auto-resolve (D9); release note | — | M |
| W2 — Lifecycle settings | Migration (partner/org/monitor columns + backfill); `resolveAlertLifecycle` + loader + single-reader contract test; re-arm `after_delay`; snapshot; partner/org "Lifecycle defaults" card; monitor editor "Alert lifecycle" section (Inherit/On/Off, re-arm, cooldown); export-policy classification; AI-tool schema update for monitor tools; locales | W1 | M |
| W3 — Clears when + docs | Kind-aware `autoResolveConditions` validation for `event_log`; compile through the kind spec; editor "Clears when"; alert-detail lifecycle line; docs (monitors, alerts, UPS recipe) | W1 (W2 for the editor section layout; can land on W1 alone with the current checkbox) | S |

## 10. Test plan (red first)

Write each assertion first and watch it fail on `main`.

**W1**

- `eventLog.test.ts`: `with a cursor, requires one matching row ordered after it`;
  `with a cursor, still counts old rows toward countThreshold` (guards D8);
  `orders same-log Windows events by recordId when timestamps tie`;
  `window still applies under a cursor`; `returns the newest matching row as evidenceWatermark`.
- `alertService.rearm.test.ts`:
  `does not re-open after condition_cleared when every trigger event precedes the recovery event` (fails today: re-opens after cooldown);
  `does not re-open on a delayed trigger event that predates the recovery event but was ingested after the close`;
  `re-opens on a trigger event logged after the recovery event even if ingested before the resolve sweep`;
  `re-opens after a manual resolve on a trigger event the sweep never observed` (the race the quorum found);
  `does not re-open after a manual resolve on events the sweep observed while open`;
  `a cooldown- or flap-blocked evaluation consumes nothing` (fires once the block lifts);
  `skips the cursor lookup for rules with no evidence leaf` (query count);
  `state condition re-opens after cooldown when still breaching after a manual resolve` (pins current behaviour).
- `alertService.autoResolveAnchor.test.ts`:
  `a recovery event older than the cursor does not resolve a new alert` (fails today);
  `a recovery event logged after the trigger but ingested before triggered_at resolves it` (guards D4);
  `a repeat trigger event during the episode advances the cursor and blocks an earlier recovery`;
  `a recovery event with the same clamped timestamp as the trigger resolves it` (tie rule);
  `recovery close records an ok observation and closes the breach episode`;
  `acknowledged alert auto-resolves`, `suppressed alert auto-resolves` (D9; both fail today);
  `requiresHuman alert never auto-resolves` (pins current behaviour).
- `alertCooldown` fallback: `resolveAlert and createAlert use the same cooldown fallback`.
- Integration (real Postgres, `alertRearm.integration.test.ts`): the §5.9 timeline end to end
  through the sweep and auto-resolve job — exactly two `alert.resolved` events, and the breach
  episode closes `recovered` when A resolves. The cursor lookup uses
  `alerts_rule_device_subject_closed_idx` (`EXPLAIN`); the `exists after cursor` probe is
  benchmarked on a seeded high-volume device.

**W2**

- `alertLifecycle.test.ts` (shared, pure): `monitor override wins`, `org override beats partner`,
  `blank inherits`, `after_delay requires minutes`, `legacy rule ignores partner/org`, `returns sources`.
- `alertLifecycle.singleReader.test.ts`: fails if any file other than the resolver reads
  `cooldownMinutes`/`autoResolve` off a rule, template or monitor row.
- `alertService.rearmDelay.test.ts`: `after_delay re-opens on old evidence once N minutes have passed`;
  `after_delay still fires immediately on new evidence`.
- `createAlert snapshots the effective lifecycle and its sources on context.lifecycle`.
- Migration: `backfill nulls cooldown 5 and auto_resolve false only`; `migrationRlsScope` passes;
  export-policy suite classifies the new `organizations` and `monitor_definitions` columns
  (Integration Tests job).
- Routes: partner-scope write gated on partner admin permission; org-scope write rejected for
  another partner's org; org user reads the inherited value.
- Web: `LifecycleDefaultsCard.test.tsx` (`shows inherited value and source`, `blank saves NULL`);
  `MonitorEditor.lifecycle.test.tsx` (`Inherit sends null`, `after_delay shows minutes`);
  `settingsPageRegistry` unaffected (no new URL); locale parity.

**W3**

- `monitors.test.ts` (shared): `event_log autoResolveConditions must parse as the event_log schema`;
  `rejects autoResolveConditions on kinds without a recovery schema`.
- `monitorCompiler.test.ts`: `compiles the recovery condition through toAlertCondition` (fails
  today: copied raw, no `type`).
- `MonitorEditor.clearsWhen.test.tsx`: `shows Clears when only for event_log with auto-resolve on`;
  `prefills category and source from the trigger`; `round-trips an existing recovery condition`.
- E2E (Playwright, `data-testid`): create an `event_log` monitor with Clears when, inject
  On Battery → alert, Power Restored → resolved, no re-open after the cooldown.

## 11. Risks

| Risk | Mitigation |
|---|---|
| A device clock jump backwards makes new events look older than the cursor. | Same-log Windows events order by `recordId`, which does not move with the clock. Elsewhere a jump larger than the gap between two outages is required; W1 logs (and counts) events whose `created_at` is after the cursor's but whose `timestamp` is before it. OD10. |
| Cursor write per sweep for open evidence alerts. | Only when the watermark moves, advance-only guarded update, open evidence alerts only (a small set). |
| Linux/macOS agents build `event_id` from identifier + PID (`agent/internal/collectors/eventlogs_linux.go:120`, `eventlogs_darwin.go:128`), so a long-running daemon logging the same message twice may hit the `(device_id, source, event_id)` unique index and drop the second event. Not caused by this spec; it hides new evidence on those platforms. | Inferred from code read, not run. File as a follow-up; Windows uses `Id:RecordId` (`eventlogs_winstreams.go:53`) and is unaffected. |
| Hot-path cost of cursor reads. | Only for rules with evidence leaves; one batched closed-alert read per device per sweep; measured in the W1 integration test. |
| Behaviour change surprises a customer relying on reminders. | Release note; `after_delay` in W2. |

## 12. Advisor quorum

Independent review: `codex exec -m gpt-6-astra -c model_reasoning_effort=xhigh -s read-only`,
2026-10-29, given the code paths and my first-draft position (close-time anchors, count
filtering, blanket rollout, columns as the settings home).

| Question | Codex | Outcome |
|---|---|---|
| Q1 Anchoring semantics | **Disagree.** Close-time anchors fail three ways: a delayed trigger that predates the recovery but is ingested after the close passes the `created_at > close` arm and restarts the loop; clamped timestamps can tie trigger and recovery; a trigger ingested between the last sweep and a manual resolve is swallowed. Persist the evidence actually consumed, advance it atomically, prefer the source sequence (Windows `recordId`/`logName`). Episodes must use the same reconciled observation. | **Adopted.** §5.3 replaces close-time anchors with a consumed-evidence cursor, Windows record-id ordering and an explicit tie rule; §5.5 closes the breach episode in the recovery step. |
| Q1b Count semantics | Filtering the count to post-close events changes `countThreshold > 1` (five old + one new no longer fires); "delays nothing legitimate" was false. | **Adopted** as D8 (`exists after cursor` on top of the unchanged rolling count). |
| Q2 Settings home | **Agree**: dedicated partner/org columns, Alerts home, invoice-terms precedent; no XOR table, no config-policy feature, no JSONB. Resolve against the device's org at evaluation, not compile time; disclose monitor overrides because rule 3 says the org wins. | **Agreed**; §6.3 adds both points. |
| Q3 Ack auto-resolve | **Agree**, and also while suppressed (subject alerts already do); keep `requiresHuman`; require affirmative recovery. | **Agreed** (D9). |
| Q4 Existing monitors | **Disagree** with nulling stored 5/false (cannot tell defaults from choices) and with blanket conversion to `new_evidence`; default new monitors to inherit and offer bulk adoption. | **Partly adopted**: D8 removes the count-semantics objection to the engine default. Still disagree on both remaining points after weighing — see OD1 and OD9. |
| Q5 Missing pieces | Terminal writes bypass `resolveAlert`; recovery must be compiled through the kind spec; composite-condition evidence; legacy rows without snapshots; subject in keys; event-log index benchmark; concurrent index; blocked admissions must not consume evidence; snapshot predicates. | **Adopted** except predicate snapshots (OD11): the cursor is sweep-maintained so terminal writers need no change (§5.3); per-leaf cursors (§5.6); legacy fallback (§8); subject in index (§5.7); benchmark (§5.7, §10); blocked admission rule (§5.3); kind compile (§7, D7). |

## 13. Open decisions

| OD | Question | Options | Recommendation |
|---|---|---|---|
| OD1 | Does `new_evidence` apply to existing monitors on deploy? | (a) Yes, for every evidence alert, release note, `after_delay` available in W2. (b) Codex: no blanket conversion — existing monitors keep the old behaviour until adopted. | **(a).** With D8 the only alerts that stop are re-opens built entirely from evidence an earlier episode observed; (b) leaves the bug live for every existing customer, including the one who reported it. |
| OD2 | Settings storage. | (a) Dedicated partner/org columns + nullable monitor overrides. (b) A configuration-policy feature (the `configuration-policy` skill's "don't skip the config policy system"). (c) New `partner_id XOR org_id` table. | **(a)**, quorum agrees. (b) resolves per device and adds a fourth level; (c) is machinery for four scalars per owner. |
| OD3 | Do acknowledged and suppressed alerts auto-resolve on recovery? | Yes / ack only / no (today). | **Yes, both** (quorum agrees; matches subject alerts). |
| OD4 | Edge-triggered re-arm for state conditions (manual resolve while breaching stays closed until the state clears once)? | Keep today / edge-trigger. | **Keep today**; resolve-while-breaching re-opening is honest, ack/suppress covers "I know". |
| OD5 | Window shorter than the (adaptive) cooldown can let a new event age out before it fires. | Editor warning / validation error / ignore. | **Editor warning** in W2. |
| OD6 | Partner/org UI home. | Card on `/alerts/monitors#lifecycle` / new `/alerts/lifecycle` tab. | **Card**; no new URL, sits with the objects it defaults. |
| OD7 | Org merge: copy the absorbed org's lifecycle overrides? | Survivor keeps its own / copy if survivor blank. | **Survivor keeps its own** (same as other org settings columns). |
| OD8 | Do legacy (non-monitor) rules inherit partner/org lifecycle defaults? | No / yes. | **No**; they keep explicit values and are being retired. |
| OD9 | Backfill of existing monitors' `cooldown_minutes = 5` / `auto_resolve = false`. | (a) Null to inherit (behaviour identical at migration). (b) Codex: keep explicit, new monitors inherit, offer a bulk "use defaults" action. | **(a)**: otherwise partner defaults do nothing for existing fleets; a deliberately chosen 5/false following a later partner change is low harm and visible as "partner default" in the editor. Owner call. |
| OD10 | Device clock jump backwards (non-Windows or cross-log). | Log and count only / fall back to ingest order when skew detected. | **Log and count** in W1; revisit with data. |
| OD11 | Recovery predicate for an open alert after a monitor edit. | Evaluate as currently defined (record `monitorCompiledHash`) / snapshot predicate + version (Codex). | **Current definition**: fixing a wrong recovery pattern should fix open alerts. |
| OD12 | Cursor storage. | `alerts.context.lifecycle` jsonb / dedicated column. | **jsonb** (already export-classified, per-leaf map); revisit if the guarded update shows up in profiles. |

## 14. Follow-ups (not in this spec)

- Event-id field on the `event_log` condition (Automate monitors usually match on event id).
- Configurable flapping thresholds.
- Linux/macOS event-log `event_id` uniqueness (§11).
- Recovery conditions for other kinds where a distinct recovery signal exists.
