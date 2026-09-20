---
title: Alerting consolidation — one domain, three facets (retire every legacy authoring surface)
status: approved (owner, 2026-09-19); plans in docs/superpowers/plans/monitoring/2026-09-19-alerting-consolidation-*.md
date: 2026-09-19
supersedes: 2026-09-08-monitoring-automation-unification-design.md §Decisions D1 and §Non-goals "Retiring the config-policy tabs" (the deferred "W5 — retirement decisions")
origin: "#4984 community proposal (stressedout9064, Discord 2026-08-28); owner review 2026-09-19 (screenshots of four competing surfaces); third consolidation pass after 2026-07-30 (rules → Alerts tab) and 2026-09-08 (Monitors)"
tracking_issue: (assigned by feature-lifecycle after plan approval)
diagrams: 2026-09-19-alerting-consolidation-diagrams.html (also published at https://claude.ai/artifact/K6k3Cm4tWJjKENBBPXdMLy)
---

# Alerting consolidation

## Problem

This is the third pass at the same complaint. The 2026-07-30 plan moved server-evaluated
rules out of the config-policy Monitoring tab into an Alerts tab. The 2026-09-08 spec built the
Monitor object the community asked for (condition + response + delivery + escalate-to-human)
and shipped it in four waves. Neither pass retired anything. The 09-08 spec listed retirement as
"W5, a separate program", and that program was never written. Then #5710 moved the Monitors
page under Alerts, where it now sits as a fourth peer tab next to the surfaces it was built to
replace.

Verified on `main` at `b8dd148bd8` (2026-09-19):

- **13 places author an alert condition**, writing 6 tables, across the Alerts hub (Monitors,
  Rules, Channels), Settings (Alert Templates), the config-policy editor (Alerts, Monitors,
  Service & Process Monitoring, Automations, Warranty, Event Logs), Jobs (event rules), and the
  Network Monitor page.
- **Two independent sweeps run every cycle** — `evaluateDeviceAlerts` over `alert_rules` and
  `evaluateDeviceAlertsFromPolicy` over `config_policy_alert_rules`
  (`apps/api/src/jobs/alertWorker.ts:257,261`). A policy holding a hand-written "CPU > 80" inline
  rule *and* the attached built-in "High CPU usage" monitor raises two alerts for one condition.
  No screen warns about it.
- **Alert Templates authored in `/settings/alert-templates` can never fire.** The editor stores
  `conditions = {triggers, thresholdDefaults, notifications, escalationRules, autoRemediation,
  suppression}`; the evaluator sees neither an array nor a `{logic, conditions}` group and
  rejects it as `Unknown condition type: undefined`
  (`apps/api/src/services/alertConditions/index.ts:91-93`, `registry.ts:36-42`). `targets` is
  read by nothing at runtime.
- **Delivery is decided in five places with a hidden precedence.** Monitor override → inline
  rule's channel list → first matching routing rule (severity and site only; the
  `conditionTypes` and `deviceTags` fields are accepted by the API and never evaluated,
  `notificationDispatcher.ts:1272-1291`) → **every enabled channel in the org plus every
  partner-wide channel** (`:359-375`). Channels have no severity filter. Escalation policies run
  only when a rule names one, and there is no UI to create one.
- **Copy lies.** The monitor editor still says a service watch "must also exist in the policy's
  Service & Process Monitoring tab until that is unified" (`monitoring.json`
  `editor.agentDeliveredHint`); W04 unified it. The promised "points at Monitors" banners on the
  legacy tabs were never built.
- **Conversion only exists for standalone rules.** `POST /monitor-definitions/convert-from-rule`
  handles `alert_rules` rows; the inline policy rules in the owner's screenshot have no path to
  Monitors at all, and multi-condition rules cannot convert (`monitorConversion.ts:50-57`).

Three further defects surfaced during the design review of this spec (Codex xhigh, verified in
code 2026-09-19) and are filed as #6342, #6343, #6344; they are prerequisites, not part of the program:

- **Monitors of kind `offline` have no firing path.** The sweep selects online devices only
  (`alertWorker.ts:196-199`), and the offline-transition path queries `alert_rules` with
  `targetType IN (all, org, site, device)` — never `monitor` (`offlineAlertEffects.ts:31-37`).
- **A monitor's `restart_service` response never reaches the agent.** Saving a monitor normalizes
  `execute_command` actions down to `{type, command, shell}` (`automationRuntime.ts:671-680`),
  dropping the `kind` discriminator the watch builder requires (`routes/agents/helpers.ts:2152`).
- **The monitor resolver ignores assignment `roleFilter` / `osFilter`** (`monitorResolver.ts` has
  no reference to either; `configurationPolicy.ts:2434` applies both for every other feature).

The community proposal was right about the object and right about the problem. What it
described — one place to say *what to watch, what to run, who to tell, when to involve a human*
— is exactly what has not happened at the screen level.

## The conceptual correction

Monitoring software (Datadog, Grafana, Zabbix) is built around the data; alerting is a layer on
top. An RMM is the reverse: nobody opens Breeze to watch a CPU graph. A monitor exists to produce
an alert, an alert exists to make a technician act or to trigger an auto-fix. The 09-08 spec's
decision D1 ("Alerts stays the inbox; Monitoring is a separate domain") imported the
monitoring-software framing. That is the misalignment. This spec replaces it:

> **Alerting is one domain with three facets.** *Monitors* say what we watch for and what happens
> when it fires. The *Inbox* shows what is wrong now. *Delivery* says who gets told and how.
> Config policies answer one question only: *which devices does a monitor apply to.*
> "Monitoring" as a word means seeing data, and it lives where the data is: the device page and
> the Network page.

Two invariants every wave must preserve:

1. **Every condition-based device alert traces to exactly one monitor.** Metric, state, event
   log, service, process, script and network-check conditions have one authoring object, one
   evaluation path, one row. *Sourced* alerts raised by a feature's own engine (compliance
   bridge, warranty, patch jobs, security, backup) keep their producers; those are feature
   settings, not condition rules, and are out of scope.
2. **Every notification traces to one delivery decision a technician can read on screen.** No
   emergent fallback; the default is a row you can edit.

## Goals

1. One authoring surface for alert conditions: **Monitors**. Every legacy surface is converted
   and removed, not hidden.
2. One delivery model with a visible default and one precedence, used identically by the
   dispatcher and by the monitor editor's preview.
3. Zero double-evaluation: one sweep path once conversion completes.
4. Nothing a customer configured stops working silently. Everything that cannot be converted is
   listed for a human.
5. Config-policy editor shows one tab for the whole topic.

## Non-goals

- New agent collectors (WMI, perf counters, file size, sensors) — still separate agent specs.
- Ticket as a delivery channel (#5238).
- Incidents (`/incidents`) — a separate incident-response object with its own lifecycle; not an
  alert-authoring surface and untouched here.
- Network SNMP template authoring and the discovery engine. Only network **check** authoring
  moves (W05e).
- Dropping `alert_rules` / `alert_templates` tables: compiled monitors fire *through* them
  (`monitorCompiler.ts:130-182`). Only unmanaged rows and their editors go.

## Decisions

| # | Decision | Chosen | Supersedes |
|---|---|---|---|
| C1 | Domain model | **Alerts is one nav entry with three facets: Inbox, Monitors, Delivery.** No "Monitoring" nav entry for authoring. | 09-08 D1 |
| C2 | Name of the rule object | **Monitor.** Industry word, four shipped waves, docs and MCP tools already use it. Under Alerts it reads "the monitors that produce these alerts". | — |
| C3 | Legacy surfaces | **Retired, not thin pointers.** Policy Alerts tab, policy Service & Process Monitoring tab, `/alerts/rules`, `/settings/alert-templates`, unmanaged `alert_rules`/`alert_templates` writes, `evaluateDeviceAlertsFromPolicy`. Retirement is gated on conversion, never on a date alone. | 09-08 Non-goals |
| C4 | Conversion | **Assisted, previewed, per policy, with a system-run sweep at the end.** Not silent at deploy. Every converted source row is retired in place (`retired_at`, `converted_to_monitor_id`) so alert history keeps its FK; nothing is deleted. | 09-08 "explicit and per rule" |
| C5 | Delivery default | **An explicit "Everything else" routing row per partner and (optionally) per org replaces the all-channels fallback.** Migration writes it from the current effective set, so day-one behavior is identical; from then on a new channel is opt-in. | — |
| C6 | Escalation | **A property of delivery.** Routing rows and monitors may name an escalation policy; escalation policies get CRUD on the Delivery page. | — |
| C7 | Cross-cutting reactive workflows ("any critical alert → AI triage") | **Stay under Jobs as event-triggered automations**, with a typed filter (severities, monitor kinds) the UI can author. Per-monitor responses live on the monitor and are device-bound. Distinct semantics, distinct name. | — |
| C8 | Multi-condition rules | **New `composite` monitor kind** (`all: [{kind, condition}]`) compiling to an `{logic:'and'}` group. No OR (no write path produces one today). | — |
| C9 | Agent-side watch settings | **Restart parameters move to the `restart_service` response action; the per-policy check interval stays a per-policy setting on the Monitors tab.** `alertOnStop` and `alertSeverity` on watches are dropped (stored, never read: `aiToolsConfigPolicy.ts:880`). | — |
| C10 | Network checks | **Become monitors of kind `network_check` in the final wave.** The Network page keeps assets, SNMP templates and results. | — |

## Prerequisite defects (must land before W05c)

| Issue | Defect | Why it gates conversion |
|---|---|---|
| #6342 | `offlineAlertEffects` must resolve monitors for the device (via `resolveMonitorsForDevice`) alongside legacy rules, honouring per-monitor duration | converting an inline "Device offline" rule would silently stop it firing |
| #6343 | `normalizeActions` keeps `kind`, `maxAttempts`, `cooldownSeconds` on `execute_command`; the watch builder reads them | converting a watch with `autoRestart` would silently lose the restart |
| #6344 | `resolveMonitorsForDevice` applies assignment `roleFilter`/`osFilter` exactly as `resolveEffectiveConfigWithExecutor` does | converting a policy assigned "servers only" would widen it to every device |

Each is a single-PR fix with an integration test, filed and fixed independently of this program.

Two more, found while planning W05e and gating **that** wave only: #6352 (`network_check` monitors
write `config.expectStatus`; the agent reads `expectedStatus`, so HTTP checks always expect 200)
and #6353 (the `network_check` handler breaches for every device the policy reaches, so one failing
check raises one alert per online device; the legacy worker picks a single alert device).

## End state

### Navigation

Left nav is unchanged in shape. **Alerts** (bell) is the domain. **Incidents**, **Approvals**
stay as they are. **Network Monitor** is renamed **Network** in W05e once it no longer authors
alerts.

Alerts hub tab strip (`AlertsTabStrip.tsx`):

| Tab | Route | Facet |
|---|---|---|
| Alerts | `/alerts` | Inbox |
| Correlations | `/alerts/correlations` | Inbox (flag-gated as today) |
| Monitors | `/alerts/monitors` | Monitors |
| Delivery | `/alerts/delivery` | Delivery |

Removed: **Rules** (after W05d), **Channels** (folded into Delivery, `/alerts/channels` → 301).

### Monitors (library)

`/alerts/monitors` — unchanged W02 list (name, kind, severity, deployed-to, owner, enabled) with:

- **New monitor** and, when the partner's built-ins are unattached anywhere, a **Recommended**
  strip: "Attach the four built-in monitors to a policy" → picker. (Built-ins stay unattached by
  default per the 09-13 decision; the strip makes that a choice instead of a silence.)
- During W05c only: a **Needs conversion** filter and banner ("12 legacy rules across 3 policies
  have not been converted") linking to the per-policy conversion panel. Gone in W05d.

Monitor editor cards keep the W02 order: What to watch · Severity & noise · Respond · Notify ·
Escalate to a human · Deployed to · Activity. Changes:

- **Notify** defaults to *Inherit* and renders the **resolved** answer from the same resolver the
  dispatcher uses: "Critical → PagerDuty (partner rule 'Pages'), escalates via *On-call*". The
  override is one choice: *use these channels instead* (with optional escalation policy) or
  *inbox only*. Settings rule 4: blank = inherit, and the field shows the inherited value and
  where it comes from.
- **Respond** — the `execute_command` action with `kind: 'restart_service'` gains
  `maxAttempts` (0–50, default 3) and `cooldownSeconds` (30–86400, default 300). These are the
  watch's `maxRestartAttempts`/`restartCooldownSeconds` moved to where the restart is authored.
- **What to watch** — new kind **Composite** ("all of the following"): a list of child
  conditions, each a kind picker plus that kind's fields. Max 10 children, no nesting.
- The false `agentDeliveredHint` is deleted (W05a). Service and process monitors show "Runs on
  the device" with no cross-reference, because there is nothing to cross-reference.

### Delivery

`/alerts/delivery` — one page, three sections, one save pattern each (lists → row drawer):

1. **Channels** — the existing channel cards (email, Slack, Teams, webhook, PagerDuty, SMS,
   Pushover), owner badge, test, throttle.
2. **Routing** — an ordered list. Each row: *match* (severities; monitor kinds; sites), *send
   to* (channels), *escalate via* (escalation policy, optional). The list always ends with the
   **Everything else** row, which cannot be deleted or reordered, and whose channels can be
   emptied to mean *inbox only*. A partner sees the partner-wide list; an org sees its own rows
   above the partner's, with the partner rows read-only and labelled, and its own optional
   Everything-else row that, when present, shadows the partner's for that org. The page prints
   the precedence in one line: *A monitor's own Notify setting wins; otherwise the first matching
   row from the top.*
3. **Escalation policies** — CRUD over `escalation_policies` (steps: delay, notify channels or
   users, repeat), owner badge. The escalation-cancel-on-acknowledge semantics are unchanged.

### Config policy editor

One tab, **Monitors** (`#monitors`), replacing Alerts (`#alert_rule`), Service & Process
Monitoring (`#monitoring`) and the `alert.triggered` half of Automations. Old hashes 301 to
`#monitors`.

Contents:

- **Attached monitors** — the W02 table (enable, per-policy override, sort), plus **Attach
  existing**, **Create monitor** (opens the editor with *Deploy to: this policy* pre-set — the
  spec-promised affordance that never shipped), and the **Recommended** strip when none of the
  built-ins are attached.
- **Agent collection** — one field: *Check interval* (`checkIntervalSeconds`, 10–3600, default
  60), the only per-policy agent setting the watches carried. Stored on the existing
  `config_policy_monitoring_settings` row, re-keyed to the `monitors` feature link (see Data).
- **Needs conversion** (W05c only) — a panel listing this policy's unretired inline alert rules,
  watches and alert-triggered automations, each with a **preview** and **Convert**, plus
  **Convert all convertible**. Unconvertible rows show the reason and a **Retire** action. The
  panel disappears when the policy has nothing left; the tab never shows it on a fresh policy.
- **Duplicate warning** (W05a, transitional) — "This policy also has an inline alert rule for CPU;
  devices will alert twice" on both the Monitors tab and the legacy Alerts tab until converted.

**Automations** tab is relabelled **Jobs** and limited to `schedule`, `manual`, `webhook`
triggers. Its `alert.triggered` items are converted in W05c (see Conversion).

### Jobs

`/jobs` keeps its tabs. `#event-rules` is relabelled **Alert workflows** and its editor gains the
typed trigger filter: *severities* (multi), *monitor kinds* (multi), both optional. The
`alert.triggered` payload gains `monitorId` and `kind` (`alertService.ts:260-267, 389-399`) so
the filter has something to match. Free-form `filter` records remain accepted on the API for
compatibility; the compiler's `{ruleId}` filter is unchanged. Managed (monitor-compiled)
automations stay hidden here, as today.

### Device page

The **Monitoring** hash tab replaces the watches-only view with the device's **effective
monitors**: monitor, kind, source policy, state (ok / breaching / unknown), open episode,
escalation status, and the reset action for a latched pair. Data from `resolveMonitorsForDevice`
+ `monitor_device_state` + `monitor_episodes`. (Promised by the 09-08 spec, never delivered.)

### Removed screens and routes

| Surface | Fate | Wave |
|---|---|---|
| `/settings/alert-templates`, `/settings/alert-templates/:id` | Deleted; 301 → `/alerts/monitors`. Editor cannot produce a firing rule today, so nothing that runs is lost. Unmanaged rows are converted where a real condition exists, else retired with reason. | W05c (freeze create in W05a) |
| `/alerts/rules` (Legacy rules page) | Absorbed into the Monitors "Needs conversion" filter in W05c; route deleted in W05d. | W05c / W05d |
| `/alerts/channels`, `/alerts/routing-rules` | 301 → `/alerts/delivery`. | W05b |
| Policy `#alert_rule`, `#monitoring` tabs | Frozen for new rows in W05a; replaced by the Needs-conversion panel in W05c; hash redirects in W05d. | W05a → W05d |
| `AlertRuleEditPage`, `AlertRuleEditor`, orphaned `hub.*` i18n keys, `/monitoring/*` redirect stubs | Deleted. | W05a |
| `POST/PUT/DELETE /alerts/rules*`, `/alert-templates*` (unmanaged writes) | 410 Gone with a pointer to `/monitor-definitions`. Reads stay until W05d. | W05d |

## Data model

No new tenant-scoped tables. New columns only, on tables already registered in every cascade
and export-policy list; each new column is classified in `CORE_TENANT_EXPORT_POLICY` in the
same PR (`included` for scalars, `excludedOpen` for any jsonb).

**Retirement columns** (W05c), on `config_policy_alert_rules`, `config_policy_monitoring_watches`,
`alert_rules`, `alert_templates`, `automations`, `config_policy_automations`:

```
retired_at             timestamptz null
retired_reason         text null          -- 'converted' | 'unconvertible:<code>' | 'operator'
converted_to_monitor_id uuid null references monitor_definitions(id) on delete set null
```

Evaluators, resolvers and list endpoints add `retired_at IS NULL`. Alert history joins are
untouched (`alerts.rule_id`, `alerts.config_policy_id` keep resolving).

**Routing** (W05b), on `notification_routing_rules`:

```
escalation_policy_id   uuid null references escalation_policies(id) on delete set null
is_default             boolean not null default false
```

Partial unique index: one `is_default` row per `(org_id)` and one per `(partner_id)` where the
other axis is null. `conditions` gains `monitorKinds?: string[]`; `conditionTypes` and
`deviceTags` are removed from the API schema (never UI-authored, never evaluated). A migration
reports the count of rows carrying either key (`RAISE WARNING`) and leaves the jsonb as is; the
dispatcher ignores unknown keys.

**Monitors** (W05c):

- `MONITOR_KINDS` gains `composite`. Condition schema
  `{ match: 'all' | 'any', children: [{ kind, condition }] (2..10) }`, cross-validated
  child-by-child. **Children are restricted to server-evaluated kinds** (`cpu`, `memory`,
  `disk`, `offline`, `event_log`, `patch_compliance`, `cert_expiry`, `bandwidth`, `disk_io`,
  `network_errors`, `antivirus`, `software_presence`, `backup_continuity`): agent-delivered and
  worker-provisioned kinds (`service`, `process`, `process_resource`, `script`, `network_check`)
  are selected by root kind when the agent config, script probe and network rows are built
  (`helpers.ts:2109`, `monitorScriptWorker.ts:174`, `monitorCompiler.ts:306`), so a composite
  child of those kinds would never receive evidence. `toAlertCondition` returns
  `{ logic: match === 'all' ? 'and' : 'or', conditions: children.map(spec.toAlertCondition) }`.
  No nesting. `overridableKeys: []` (the override path replaces the root node wholesale,
  `alertService.ts:943-952`; an empty overridable set is the honest contract). Existing OR or
  nested groups (the standalone-rule API accepts arbitrary `conditions`, `routes/alerts/
  schemas.ts:29`) convert only when they are one flat `any` group; deeper trees are
  `unconvertible:nested_group`.
- `service` / `process` / `network_check` `consecutiveFailures` widens to `1..100` to match the
  watch domain (`validators/index.ts:941` vs `monitors.ts:79`); no watch is unconvertible on
  range.
- The `monitors` feature link gains an `inheritance` setting, `'cumulative' | 'replace'`
  (default `cumulative`, stored on the link's `inline_settings`). `replace` makes
  `resolveMonitorsForDevice` treat that policy's attachment set the way every other feature is
  resolved — closest policy wins, parent attachments not consulted — which is what a converted
  child policy needs to reproduce its inline behavior exactly (see Conversion). The policy
  Monitors tab exposes it as one switch: *Add to inherited monitors / Replace inherited
  monitors*.
- `restart_service` action params gain `maxAttempts`, `cooldownSeconds`; the agent watch builder
  (`routes/agents/helpers.ts:2137-2157`) reads them instead of `MONITOR_WATCH_DEFAULTS`.
- `checkIntervalSeconds` stays on `config_policy_monitoring_settings` keyed by the `monitoring`
  link **until W05d**: the agent config builder joins that link only (`helpers.ts:2305-2312`)
  and re-keying earlier would drop unconverted watches from the wire. In W05c the Monitors
  tab's *Check interval* writes through to that row (creating an empty-watch `monitoring` link
  if the policy has none). W05d's migration re-keys the row to the `monitors` link, the
  `monitors` inline settings gain `checkIntervalSeconds`, and the `monitoring` feature's
  decompose/assemble paths are deleted.

**Config feature types** (W05d): `alert_rule` and `monitoring` are removed from
`CONFIG_FEATURE_TYPES` and listed in a new `RETIRED_CONFIG_FEATURE_TYPES` (shared constants).
The Postgres enum keeps the values (retired links still exist). `featureTypeParity.test.ts`,
`DeviceEffectiveConfigTab.featureParity.test.ts` and `policyBaselineDefaults.test.ts` are
changed to assert parity over `CONFIG_FEATURE_TYPES` minus nothing, and that every retired type
has no tab.

## Delivery resolution

One function, `resolveDelivery(alert-ish) → { channelIds, escalationPolicyId, source }`, in
`services/delivery/resolveDelivery.ts`, used by the dispatcher, by the monitor editor's preview
endpoint (`GET /alerts/delivery/resolve?orgId&severity&kind&siteId&monitorId`), and by the
Delivery page's "test this rule set" affordance. Precedence, in order, first hit wins:

1. Monitor `deliveryMode = 'none'` → inbox only, `source: monitor`.
2. Monitor `deliveryMode = 'channels'` → its channels + its escalation policy.
3. Monitor `deliveryMode = 'inherit'` (and every non-monitor alert) → routing rows for the
   alert's org and its partner, ordered `priority ASC` with org rows before partner rows at
   equal priority, non-default rows first; match on severities, monitorKinds, siteIds (site
   rules fail closed as today).
4. The org's `is_default` row if present, else the partner's `is_default` row.
5. No default row (fresh install with no channels) → inbox only, logged.

In-app notifications remain unconditional (step 0). **Escalation resolves independently of
channels**: the monitor's own `escalationPolicyId` if set (today `inherit` + explicit escalation
already works, `notificationDispatcher.ts:443`), else the winning routing row's, else none.
The all-enabled-channels fallback is deleted.

**`channelIds` means eligible destinations** (decided 2026-09-19 after the plan cross-check): the
resolver itself drops ineligible channels and reports them as
`skippedChannelIds: [{ id, reason: 'disabled' | 'unavailable' }]` — `unavailable` covers missing,
foreign-tenant and not-visible alike, so a foreign channel id is indistinguishable from a
nonexistent one (no cross-tenant existence oracle). Eligibility is ordinary RLS-scoped reads plus an
explicit owner predicate applied identically in dispatch and preview; no `SECURITY DEFINER`
function and no scope escalation (D21, quorum 2026-09-19; the partner-wide SELECT branches these
tables need already shipped in `2026-10-10-120000`). The dispatcher sends
to `channelIds` with no further filtering, so dispatch and preview can never disagree; the preview
shows the skipped ones.

**Transitional (W05b → W05d):** steps 1–2 also honour a legacy source's own overrides —
`alert_rules.overrideSettings.notificationChannelIds/escalationPolicyId` and
`config_policy_alert_rules.notification_channel_ids/escalation_policy_id` — for unretired rows,
so nothing changes for a rule until it is converted. That branch is deleted in W05d.

**Migration** (`2026-…-delivery-default-rows.sql`, system scope): for every partner with ≥1
**enabled** partner-wide channel, insert a partner `is_default` row with those channels; for
every org with ≥1 **enabled** org-owned channel, insert an org `is_default` row with the org's
enabled channels **plus** its partner's enabled partner-wide channels (that is exactly the
fallback query at `notificationDispatcher.ts:362-371`, `enabled = true` on both axes). Report both
counts. Day one is behavior-identical. Release notes state the one change: *new channels are not
subscribed to anything until added to a routing row.*

## Conversion

Every legacy source becomes a monitor definition owned on the **same axis as the source's
policy** (org-owned policy → org monitor; partner-wide policy → partner monitor), attached to
that policy, and the source row is retired in the same transaction. A ledger records it in
**two new tables**: `monitor_conversions` `{id, org_id XOR partner_id, source_table, source_id,
policy_id, converted_by, converted_at, preview_hash, reverted_at}` and
`monitor_conversion_outputs` `{conversion_id, monitor_id, role ('primary' | 'resource_cpu' |
'resource_memory' | 'response'), moved_alert_ids jsonb}` — a watch can produce up to three
monitors. Both are org-XOR-partner (partner-wide playbook shape, SELECT-only partner branch),
registered in `CORE_ORG_CASCADE_DELETE_ORDER` (outputs before conversions before
`monitor_definitions`), `CORE_TENANT_EXPORT_POLICY` (`moved_alert_ids` is `excludedOpen`), and
`DUAL_AXIS_TENANT_TABLES` in the same PR. Any composite FK that carries `org_id` is `DEFERRABLE
INITIALLY IMMEDIATE`. Conversion is idempotent on `(source_table, source_id)`; **Revert** on a
ledger row un-retires the source, deletes the output monitors (attachments cascade) and restores
`alerts.rule_id`/`config_policy_id` for `moved_alert_ids`. The source row's
`converted_to_monitor_id` holds the primary output.

| Source | Becomes | Mapping notes | Unconvertible when |
|---|---|---|---|
| `config_policy_alert_rules` row, 1 condition | monitor of the matching kind | existing `convertAlertConditionToMonitor`; `escalation_policy_id` → monitor escalation; `notification_channel_ids` non-empty → `deliveryMode: channels`, empty/null → `inherit` (never `none`); `cooldown`, `autoResolve`, severity, name, rationale → description | metric `processCount`/`processes` (no kind); `custom` |
| `config_policy_alert_rules` row, 2–10 conditions | `composite` monitor | children through the same converter | any child unconvertible |
| `config_policy_monitoring_watches` row | `service` or `process` monitor; **plus** a `process_resource` monitor per set threshold (`cpuThresholdPercent`, `memoryThresholdMb`) | `alertAfterConsecutiveFailures` → `consecutiveFailures`; `autoRestart` → `restart_service` response with `maxAttempts`/`cooldownSeconds` from the row; `thresholdDurationSeconds` → `durationMinutes` (rounded up) on the resource monitor; `alertOnStop` and `alertSeverity` ignored (stored, never read at runtime — mapping them would *change* behavior) | never (all fields map) |
| `config_policy_monitoring_settings.checkIntervalSeconds` | policy Monitors tab *Check interval* | row re-keyed, not converted | — |
| `alert_templates` unmanaged + its `alert_rules` | monitor + attachment to a **new policy** assigned to the rule's target (existing `ruleConversionService` path: `createConfigPolicy`, `assignPolicy`, `addFeatureLink`) | existing converter | template `conditions` is the editor envelope (no `type`) — retired with reason `unconvertible:no_condition`. Exception: templates the compliance bridge fires directly (`policyAlertBridge.ts:230`, sourced alerts, no evaluator) are **not** alert-rule templates and are left alone |
| `automations` / `config_policy_automations` with `trigger.event = 'alert.triggered'` | if `filter.ruleId` or `filter.configPolicyAlertRuleId` names a source being converted → appended to that monitor's `responses` (device-bound, dedup by action fingerprint); otherwise → **kept** as an Alert workflow under Jobs with `filter` left as is (policy-scoped ones are re-homed to a standalone automation assigned to the same policy) | actions carried verbatim (max 10 per monitor) | never |

**Inheritance correction.** Inline `alert_rule` is whole-feature-replace: role/OS filters,
then level, assignment priority, creation time, one winning feature
(`configurationPolicy.ts:2434-2506`). Monitors are cumulative, rank a policy's own attachment
ahead of inherited ones before priority, and accumulate across unrelated assignments
(`monitorResolver.ts:73-81`). Attaching parent monitors to a child with `enabled: false` cannot
reproduce that. The converter therefore does not try to emulate replacement with attachments;
it **sets `inheritance: 'replace'` on the `monitors` link of every converted policy that had
its own inline `alert_rule` feature**, and the resolver (with the prerequisite filter fix)
selects that policy's attachment set exactly as the legacy resolver selected its feature. A
tech flips the switch to `cumulative` deliberately, later, per policy.

Monitor reuse across policies (attach an existing monitor instead of minting one) happens only
on **full behavioral equivalence**: kind, normalized condition, severity, cooldown, auto-resolve,
delivery and responses all equal. Otherwise a new monitor is created.

**Equivalence check.** The preview is not a sample: for every device in the policy's assignment
scope it computes the legacy effective condition set (`previewEffectiveConfig`) and the
post-conversion set (`resolveMonitorsForDevice` on the proposed attachments, in a dry-run
transaction) and refuses when any device gains or loses an active condition or changes
severity, cooldown or delivery. Above 500 devices the check runs as a job and the panel shows
progress; the ledger stores the `preview_hash` so a stale preview cannot be confirmed.

**Open alerts.** Alert status is `active | acknowledged | resolved | suppressed | dismissed`;
dedupe considers `active, acknowledged, suppressed` (`alertService.ts:202-206`); legacy
auto-resolve keys on `config_policy_id IS NOT NULL` (`:1393-1397`) and cooldown resolution
prefers `config_policy_id` (`:744-748`). For every non-terminal alert of a converted source
the converter, in the same transaction: sets `alerts.rule_id` to the compiled rule, sets
`alerts.config_policy_id = NULL`, records the source id in `alerts.context.convertedFrom`
(history and the detail page read it), and lists the ids in the ledger's `moved_alert_ids`.
Cooldown state keyed `cpar:<source>:<device>` is re-keyed to the compiled rule's key. The alert
is then deduped, cooled and auto-resolved by the monitor path only.

**Other writers of legacy rows** (all changed in W05c so conversion is not undone):

| Writer | Today | Becomes |
|---|---|---|
| Onboarding `modules/mcpInvites/tools/configureDefaults.ts:142` | inserts unmanaged baseline `alert_rules` per org | attaches the partner's built-in monitors to the org's default policy |
| `scripts/migrateToConfigPolicies.ts:397` | recreates inline `config_policy_alert_rules` | script retired (W05d) |
| Fleet Designer `fleetDesign/apply.ts:309-371` | writes `alert_rule` and `monitoring` links | writes monitor attachments |
| AI `manage_policy_feature_link` | writes both legacy features | refuses (W05d), points at `manage_monitor_definitions` |

**Who runs it.**

- W05c ships the per-policy panel and a partner-level **Convert everything** action (preview
  → confirm), gated on `canManagePartnerWidePolicies` for partner-wide rows.
- Hosted: we run the partner-level action for every partner after deploy, from the admin UI,
  and record the ledger counts in the release checklist.
- Self-hosted: an admin banner on `/alerts/monitors` and the policy Monitors tab counts unretired
  rows from W05c on. W05d's migration runs the converter in system scope for whatever remains
  and retires the unconvertible rows with reasons; the banner then lists them once
  ("3 legacy rules could not be converted — review") until dismissed. Nothing stops firing
  without being listed.

## Evaluation

- W05a–W05c: both sweeps run; the duplicate warning is the only mitigation, and the converter's
  atomic retire-and-attach means no policy is ever double-evaluated after conversion.
- W05d: `evaluateDeviceAlertsFromPolicy` is deleted along with `alertService.ts:1239-1310`, the
  `cpar:` cooldown keys and the `config_policy_id` branch of the acknowledge handler
  (`routes/alerts/alerts.ts:1082-1088`) become history-only reads. A startup check counts
  `config_policy_alert_rules WHERE retired_at IS NULL`; a non-zero count logs at error level,
  reports to Sentry and raises the admin banner. The W05d migration makes it zero; the check
  exists so a skipped or failed migration is loud, not silent.

## Tenancy and safety

- No new RLS shape. `monitor_conversions` is org-XOR-partner (shape 1 + partner branch, with the
  SELECT-only partner-wide branch per the playbook); everything else is columns on registered
  tables.
- Monitors created by conversion are inserted through `createMonitorDefinition`/
  `compileMonitorInTx` under the caller's `withDbAccessContext` (panel) or per-partner
  `withSystemDbAccessContext` (W05d migration and hosted sweep), never a bare pool.
- `monitorAttachability` already refuses cross-partner attachment and partner monitors that
  reference org-only escalation policies; the converter surfaces those as `unconvertible:
  escalation_policy_axis` instead of dropping the policy silently.
- Routing default rows are dual-owned like every delivery rail (#2130); the resolver uses
  `railOwnershipCondition` unchanged.
- `partner-wide-write-coverage.test.ts` and `site-ceiling-write-coverage.test.ts` need allowlist
  entries with reasons for the new partner-axis writers (conversion, default rows).

## AI / MCP tools

| Tool | Change | Wave |
|---|---|---|
| `manage_policy_feature_link` | refuses `featureType: alert_rule` / `monitoring` with a pointer to `manage_monitor_definitions` | W05c (warn) / W05d (refuse) |
| `manage_alert_rules` | `list_templates` removed; `list_rules` returns managed rules only | W05d |
| `manage_service_monitors` | `list` reads service/process monitors via the resolver | W05c |
| `manage_notification_channels` | gains `manage_routing` / `manage_escalation_policies` actions, or a new `manage_delivery` tool (decide in plan; one home) | W05b |
| Fleet Designer `apply.ts:309-371` | writes `monitors` attachments instead of `alert_rule` / `monitoring` links; `fleetDesign.ts` rule schema becomes a monitor-definition subset | W05c |

## Docs and release notes

`features/alerts.mdx` becomes the domain page (three facets); `alert-templates.mdx` and
`service-monitoring.mdx` are removed with redirects; `monitors.mdx`, `notifications.mdx`,
`configuration-policies.mdx` updated; the nine `migration/*.mdx` guides re-point "alert rule"
instructions to monitors. Release notes per wave carry: the delivery default change (W05b), the
conversion instructions and deadline (W05c), the removals and the boot check (W05d).

## Waves

| Wave | Ships | Gate to next |
|---|---|---|
| **W05a — stop the bleeding** (2 PRs, no schema) | Delete false hint; duplicate-condition warning on policy Monitors and Alerts tabs; **Create monitor** and Recommended strip on the policy Monitors tab; freeze creation on policy Alerts tab, S&P tab and Alert Templates (existing rows still editable; "converts in the next release" notice); remove `conditionTypes`/`deviceTags` from the routing API schema; delete orphaned `AlertRuleEditPage`/`AlertRuleEditor`/`hub.*` keys/`/monitoring/*` stubs; add a *superseded* banner to the 09-08 spec | merged |
| **W05b — delivery** (3 PRs) | `resolveDelivery` + preview endpoint; routing `escalation_policy_id`, `is_default`, `monitorKinds`; default-row migration; Delivery page (Channels · Routing · Escalation policies) with `/alerts/channels` redirect; monitor Notify card shows resolved inheritance; dispatcher on the resolver; fallback deleted; delivery MCP tool | one integration test proving dispatch and preview agree for org-row, partner-row, default-row and inbox-only cases against real Postgres |
| **W05c — conversion** (5 PRs; requires the three prerequisite fixes merged) | `composite` kind; `inheritance` link setting + resolver; `consecutiveFailures` widening; `restart_service` params + agent builder; Check-interval write-through; retirement columns; `monitor_conversions`; converter for all five sources incl. inheritance correction and open-alert carry-over; per-policy panel + partner-level Convert everything; Needs-conversion filter on Monitors; Alert workflows filter + payload fields; device page Monitoring tab; Fleet Designer and AI-tool changes; Alert Templates pages deleted | hosted: ledger shows zero unretired rows on EU and US; self-hosted banner live |
| **W05d — retirement** (2 PRs, ≥1 release after W05c) | Migration runs the converter in system scope for leftovers; settings re-key to the `monitors` link; transitional delivery overrides removed; `migrateToConfigPolicies` script deleted; policy `#alert_rule`/`#monitoring` tabs, `/alerts/rules`, legacy routers (410), `monitoring` feature decompose/assemble, `evaluateDeviceAlertsFromPolicy` deleted; `RETIRED_CONFIG_FEATURE_TYPES`; boot check | — |
| **W05e — network checks** (3 PRs; requires #6352, #6353 merged) | Network Monitor → **Network** (Assets · Templates · Results); check authoring in Monitors (kind `network_check`, bound to an asset); unmanaged `network_monitors` rows are **adopted** in place (stamped `managed_by_monitor_id`, keeping row id, results history and asset binding) rather than re-inserted, under the same ledger; their `network_monitor_alert_rules` retired; one generated "Network checks — <org>" policy per org carries the attachments | — |

W05a and W05b are independent of each other. W05c depends on both. W05d depends on W05c having
shipped in a prior release. W05e is separable and may be re-planned after W05d.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Conversion changes what fires for some device (inheritance, thresholds, delivery) | Preview computes before/after per sample device and refuses on any delta; ledger + retired rows allow reverting a single conversion (`un-retire` action, W05c) |
| Delivery default row misses a channel the fallback used to hit | Migration derives rows from the exact fallback query; integration test replays the dispatcher on a fixture partner before/after |
| Self-hosters skip W05c and land on W05d | W05d migration converts leftovers itself; unconvertible rows are listed, never silent; the startup count check logs, reports and banners rather than evaluating nothing quietly |
| Composite override semantics surprise | Composite has no overridable keys; the policy row shows "override not available for composite monitors" |
| Watches with thresholds become two monitors | Preview shows both; names derive from the watch (`"<name> — CPU"`) |
| Fleet Designer and AI tools keep writing legacy features | Both are changed in W05c and the legacy write paths refuse in W05d; `aiAgentSdkTools.mcpCoverage.test.ts` pins the tool surface |
| Alert history loses provenance | Rows are retired, never deleted; moved alerts carry `context.convertedFrom`; detail page shows "converted to monitor X" |
| `inheritance: replace` surprises a tech who later attaches a partner-wide monitor to a parent | The policy Monitors tab shows the switch state and, in replace mode, lists the inherited monitors being ignored |
| A prerequisite fix slips and conversion proceeds | The converter refuses to run unless the three fixes' feature checks pass (a startup-registered capability list), and the panel says which is missing |

## Review log

- 2026-09-19 — Fable position: retire outright, assisted conversion, explicit delivery default.
  Codex gpt-6-astra xhigh (read-only) independently: "retire the competing authoring models;
  make Monitors canonical; thin pointers only during migration; reject an unconditional
  backfill", and added the inheritance-semantics trap, the watch-field parity gap, the
  open-alert continuity requirement, and "do not retire every alert.triggered automation —
  broad ones change coverage if copied per monitor". All four adopted above (Inheritance
  correction, C9, Open alerts, C7). Codex's end-state tab lists match §End state.
- 2026-09-19 (second round, written spec) — Codex xhigh found ten defects in the draft; all
  verified in code and adopted: offline-monitor firing gap, restart discriminator loss and
  resolver filter gap (now *Prerequisite defects*); delivery must not change for unconverted
  rules and escalation must resolve independently of channel inheritance (§Delivery
  resolution); parent-suppression could not emulate whole-feature replacement (now the
  `inheritance: replace` link setting + full-scope equivalence check); open-alert carry-over
  had the wrong statuses and left `config_policy_id` live (rewritten); settings re-key would
  have dropped unconverted watches (deferred to W05d); composite children must be
  server-evaluated kinds and OR groups exist (restricted + `match`); onboarding and the
  migrate script write legacy rows (inventoried); `consecutiveFailures` domains differ
  (widened); ledger could not hold one-to-many (outputs table).
- 2026-09-19 (W05e planning) — the wave plan adopts legacy `network_monitors` rows in place
  instead of insert-and-retire (keeps ids, history, TLS observations); accepted and recorded in
  §Waves. Two shipped W04 defects surfaced and were filed (#6352, #6353).
- Owner (2026-09-19): framing approved — "alerting is the purpose in an RMM; monitors serve
  it"; Monitors name kept; explicit delivery default with opt-in new channels approved.

## Out of scope — file as issues at plan time

- `routingRulesFor` site fail-closed semantics review (unchanged here).
- Alert-category taxonomy for AI-agent triggers (`aiAgents.ts:134`) vs monitor kinds — unify
  later.
- `processCount` metric: add a `process_count` kind or drop; data-dependent.
- Per-org overrides of partner monitors beyond `enabled`/threshold keys.
