---
title: Monitoring & Automation unification (monitors as the authoring object)
status: approved
date: 2026-09-08
tracking_issue: LanternOps/breeze#5287
origin: "#4984 community proposal (feature tracker #5287, waves #5288–#5291) (Discord, MSP migrating from Datto RMM); escalation counter #4672"
---

# Monitoring & Automation unification

## Problem

A technician who wants "when disk usage on servers passes 80%, run the cleanup script, tell the
helpdesk on Teams, and get a human involved if it keeps happening" has to touch four surfaces
today, and two of them are hidden:

- **Alert Rules** (`/alerts/rules`, a sub-route with no nav entry) hold the condition, severity,
  cooldown and auto-resolve. The rule form has **no action field**: an alert rule cannot run
  anything.
- **Automations** (`/automations`, **no left-nav entry at all** — reachable only through the Fleet
  Orchestration page or a typed URL) hold the response. A "run the cleanup script" automation is
  wired with an `event` trigger on `alert.triggered`. Verified on main: an ordinary automation with
  that trigger runs its actions on **every device its conditions match**, not on the device that
  alerted — only AI-managed automations bind to `payload.deviceId` (#5240).
- **Service & Process Monitoring** is a tab inside the Configuration Policy editor
  (`configPolicyMonitoringWatches`: service and process only). Its results are polled by the alert
  sweep through the `service_stopped` / `process_stopped` condition handlers; the real-time
  `monitoring.check_failed` events it publishes have no consumer.
- **Network Monitor** (`/monitoring`, nav entry under Fleet Management) is a fourth engine with its
  own rules and severity model. Verified on main: its alerts are inserted straight into `alerts`
  without `alert.triggered`, so they never notify, escalate, trigger automations, or get an AI
  verdict (#5241).
- Nothing counts recurrences. The 80% → cleanup → 78% → 85% → cleanup loop can run forever and no
  human ever hears about it. The only counter is `automations.run_count`, global and unwindowed.

The community proposal (#4984) is a Datto-shaped single object — *monitor = condition + response +
alert delivery* — plus "Automations should be called Jobs". Two independent design reviews
(Fable and Codex xhigh, 2026-09-07, see *Review log*) reached the same verdict: the runtime pieces
already exist and are good; what is missing is one authoring object and a navigation that shows it.

## Goals

1. One object, **Monitor**, that a technician authors in one form: what to watch, how bad it is,
   what to run when it breaks, who to tell, and when to escalate to a human.
2. Monitors deploy through the existing configuration-policy assignment and inheritance machinery
   — no second targeting model.
3. A **recurrence counter** with teeth: N breach episodes in M days raises a requires-human alert and
   pauses automatic remediation for that device until a person resets it (#4672).
4. Device-bound responses: a monitor's actions run on the device that breached, never fleet-wide.
5. Navigation that matches the mental model: **Alerts** (what is wrong now), **Monitoring** (what we
   watch and how we respond), **Jobs** (what runs on a schedule or on demand).
6. Every existing consumer keeps working untouched: alert sweep, correlation, cooldown/flapping,
   notification routing, escalation policies, AI alert verdicts, AI-managed automations, mobile,
   MCP tools, partner-wide fan-out.

## Non-goals

- A new evaluation runtime. Monitors **compile into** existing alert-rule and automation rows; the
  BullMQ sweep, `alertConditions/` handlers, `automationWorker`, and `notificationDispatcher` are
  unchanged in shape.
- Datto feature parity on day one. Generic WMI queries, Windows performance counters, file/folder
  size watches and hardware sensors need agent work and get their own specs (see *Monitor types*).
- Retiring the config-policy Alert / Automation / Monitoring tabs. They stay as compatibility
  views; a later program decides their fate once monitors have adoption.
- Ticket delivery (#5238), saved-group targeting for scripts (#5237), maintenance-window work
  (#5234–#5236). Referenced, not built here.
- Migrating existing alert rules automatically. Conversion is explicit and per rule.

## Decisions (approved 2026-09-08)

| # | Decision | Chosen |
|---|---|---|
| D1 | Product boundary | **Alerts stays a separate inbox.** Monitoring (authoring) and Jobs are new nav entries. The community's single "Monitoring & Automation" that swallows Alerts was rejected: the inbox is the most-used page and must stay one click away. |
| D2 | Recurrence semantics | **Breach episodes**, not response runs or polls. A new episode requires an observed recovery in between. On the Nth episode inside the window: requires-human alert, notify, pause auto-remediation until reset. |
| D3 | Targeting | **Through configuration-policy attachment** (a `monitor` feature type), reusing assignments, priority and one-level inheritance (#5080). No direct target column on the monitor. The editor offers a "Deploy to…" shortcut that creates or updates the attachment. |
| D4 | Inheritance for the monitor feature | **Cumulative** across every assigned policy and its parent, with overrides keyed by the stable monitor id (disable or parameter override). Other feature types keep whole-feature replacement. |
| D5 | Ambition | Existing eleven condition types first, then handler-only additions (antivirus, software presence, backup continuity) and a first-class **script monitor**. Agent-collector types are deferred to separate specs. |

Deferred (not rejected): a `monitor_revisions` history table. Wave 1 records `compiled_hash` /
`compiled_at` on managed rows; if audit demand appears, revisions can be added without changing
the compile contract.

## Concepts

- **Monitor definition** — the authored object. Owned by an org XOR a partner. Has a *kind* (what is
  watched), a *condition* (kind-specific parameters), *severity*, *cooldown*, *auto-resolve*,
  ordered *responses* (automation actions), *delivery* (channels / routing / escalation policy), and
  a *recurrence policy* (N episodes in M days → escalate).
- **Attachment** — a row that puts a monitor into a configuration policy (`config_policy_monitors`).
  Deployment = attachment × assignment. An attachment can disable the monitor or override
  parameters for that policy's scope.
- **Compiled rows** — the alert rule and automation the platform derives from a definition. They
  carry `managed_by_monitor_id` and are read-only everywhere except the compiler.
- **Episode** — one continuous breach of a monitor on one device: starts when the condition first
  evaluates true after being false or unknown; ends on observed recovery. Unknown or stale data
  never ends an episode.
- **Recurrence escalation** — the state a (monitor, device) pair enters when episodes-in-window ≥ N.

## Ownership rule (tenancy)

`monitor_definitions` is a **config table**: `org_id` XOR `partner_id`, `monitor_definitions_one_owner_chk`,
one dual-axis RLS policy (`system OR org-access OR partner-access`), partner index, exactly as the
`2026-07-01-*-partner-ownership.sql` playbook. Partner-wide writes gate on
`canManagePartnerWidePolicies(auth)`; create takes `ownerScope`; update omits it.

`config_policy_monitors` (the attachment) is policy-derived: it references a feature link, and the
feature link's policy carries the ownership. It has no owner columns of its own, matching
`configPolicyAlertRules` / `configPolicyAutomations`. RLS: `EXISTS` join through the feature link to
`configuration_policies`, registered in `PARENT_FK_JOIN_POLICY_TABLES` in
`rls-coverage.integration.test.ts` as `['config_policy_monitors', ['configuration_policies']]`,
exactly like `config_policy_alert_rules`.

Attachment validation: a policy may attach a definition only if the definition is owned by the
policy's org, by the policy's partner (partner-wide definition), or is partner-wide under the org's
partner. Cross-partner attachment is rejected at the API and by a constraint trigger, mirroring
`breeze_config_policy_parent_compatible` from #5080 (COALESCE to false; fail closed).

Operational tables (`monitor_episodes`, `monitor_device_state`) take the **device's** `org_id`
(Shape 1), never the definition's — a partner-wide monitor produces org-scoped episodes.

Compiled rows inherit ownership from the definition: a partner-wide definition compiles to a
partner-wide `alertRules` / `automations` pair, so existing partner fan-out applies without new code.

Registration checklist (same PR as the migration):

- `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`): `monitor_definitions`,
  `monitor_device_state`, `monitor_episodes` (the three tables with `org_id`). `config_policy_monitors`
  has no `org_id` and cascades through its feature-link FK, so it is not listed.
- `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`): entries for the three
  `org_id` tables with every column classified — `condition`, `responses`, `recurrence_actions`,
  `delivery_channel_ids`, `overrides` are `excludedOpen`. **Also** the new columns on already-registered
  tables: `alerts.monitor_id`, `alerts.episode_id`, `alerts.requires_human`, and
  `managed_by_monitor_id` on `alert_rules`, `alert_templates`, `automations` go into `included`.
- `DUAL_AXIS_TENANT_TABLES` (`rls-coverage.integration.test.ts`): `monitor_definitions`;
  `PARENT_FK_JOIN_POLICY_TABLES`: `config_policy_monitors`.
- `orgMergeRegistry`: `monitor_definitions` (owner repoint), `monitor_device_state` and
  `monitor_episodes` (device-org restamp).
- `CORE_DEVICE_CASCADE_DELETE_TABLES` + `CORE_DEVICE_ORG_DENORMALIZED_TABLES`
  (`routes/devices/core.ts`): `monitor_device_state`, `monitor_episodes`.

## Data model

### `monitor_definitions`

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| org_id / partner_id | uuid null | XOR |
| name, description | | |
| kind | `monitor_kind` enum | see *Monitor types* |
| enabled | bool | master switch; disabled compiles to inactive rule + disabled automation |
| condition | jsonb | kind-specific; validated by the same zod schema the matching `alertConditions` handler uses |
| severity | `alert_severity` | |
| cooldown_minutes | int | mirrors `alertTemplates.cooldownMinutes` |
| auto_resolve, auto_resolve_conditions | bool, jsonb | mirrors templates |
| responses | jsonb `AutomationAction[]` | existing action union; `ai_triage` allowed only when `ai_agent_id` is set (see *AI*) |
| response_scope | enum `triggering_device` | fixed in this program; exists so #5240's `all_matching` never applies to monitors |
| delivery_mode | enum `none \| inherit \| channels` | `inherit` = routing rules decide (today's default); `channels` = explicit list |
| delivery_channel_ids | jsonb `string[]` | when `channels` |
| escalation_policy_id | uuid null → `escalation_policies` | |
| recurrence_threshold | int null | N; null = counter off |
| recurrence_window_hours | int null | M × 24 |
| recurrence_actions | jsonb `AutomationAction[]` | run once when escalation latches (e.g. `send_notification` to a human channel; later `create_ticket`) |
| pause_responses_on_escalation | bool default true | D2 |
| ai_agent_id | uuid null → `ai_agents` | when set, the compiled automation is AI-managed |
| compiled_alert_template_id, compiled_alert_rule_id, compiled_automation_id | uuid null | provenance pointers |
| compiled_hash, compiled_at | text, timestamptz | drift detection |
| created_by, created_at, updated_at | | |

Unique `(coalesce(org_id, partner_id), name)`.

### `config_policy_monitors` (attachment)

| column | notes |
|---|---|
| id | uuid pk |
| feature_link_id | → `config_policy_feature_links(id)` ON DELETE CASCADE; the link's `feature_type = 'monitor'` |
| monitor_id | → `monitor_definitions(id)` ON DELETE CASCADE |
| enabled | bool; `false` = this policy switches the monitor off for its scope (cumulative override) |
| overrides | jsonb null; subset of `condition` and `severity` permitted by the kind's `overridableKeys` |
| sort_order | |

Unique `(feature_link_id, monitor_id)`. The `monitor` value is added to `config_feature_type`.

### `monitor_device_state`

One row per (monitor, device). `org_id` = device org.

| column | notes |
|---|---|
| monitor_id, device_id | composite pk |
| org_id | device's |
| current_episode_id | null when healthy |
| episodes_in_window | int, maintained by the evaluator |
| window_started_at | |
| escalated_at, escalation_alert_id | set when recurrence latches |
| responses_paused | bool |
| reset_at, reset_by | audit of the human reset |
| last_evaluated_at, last_state | `ok \| breach \| unknown` |

### `monitor_episodes`

Append-only. `org_id` = device org.

| column | notes |
|---|---|
| id | |
| monitor_id, device_id, org_id | |
| started_at, ended_at | `ended_at` null while open |
| alert_id | the alert the sweep raised for this breach |
| response_run_id | the automation run the response produced, null if paused/none |
| response_outcome | `queued \| completed \| failed \| skipped_paused \| skipped_no_response` |
| end_reason | `recovered \| device_deleted \| monitor_detached` |

Retention: 400 days (covers a one-year window); pruned by the existing retention worker pattern.

### Additions to existing tables

- `alert_rules`, `alert_templates`, `automations`: `managed_by_monitor_id uuid null → monitor_definitions(id)`
  ON DELETE CASCADE, partial index where not null. Service-layer guard: `updateAlertRule`,
  `updateAutomation`, the MCP `manage_automations` tool and the AI-agent automation path reject
  writes to rows with `managed_by_monitor_id` set (`409 managed_by_monitor`). UI renders them
  read-only with a link to the monitor.
- `alerts`: `monitor_id uuid null`, `episode_id uuid null`, `requires_human bool default false`.
  `requires_human` is read by the AI verdict subscriber and by auto-resolve: a requires-human alert
  is never auto-resolved and never auto-suppressed by a verdict.

## Compile contract

The compiler is the **only writer** of managed rows. `saveMonitorDefinition(input)` runs in one
transaction:

1. Validate `condition` against the kind's schema; validate `responses` against
   `automationActionSchema` with the monitor restrictions.
2. Upsert `alert_templates` row (`is_built_in = true`, `managed_by_monitor_id`), with
   `conditions = kindToAlertCondition(kind, condition)` — a single root condition object
   (`alertTemplates.conditions` holds one condition or one group, never an array), severity,
   cooldown, auto-resolve, title/message templates derived from the kind.
3. Upsert `alert_rules` row (`managed_by_monitor_id`, `template_id`, `is_active = enabled`,
   `target_type = 'monitor'`, `target_id = monitor_id`). The sweep already evaluates rules through
   `evaluateDeviceAlerts`; a new `target_type` resolver maps `'monitor'` to the devices the
   attachment resolution yields (see *Targeting*), so no second evaluator is introduced.
4. Upsert `automations` row (`managed_by_monitor_id`; `managed_by_agent_id = ai_agent_id`;
   `trigger = { type: 'event', event: 'alert.triggered', filter: { ruleId: <compiled rule id> } }`;
   `actions = responses`; `enabled`). The runtime already honours `trigger.filter` as key/value
   equality against the event payload (`matchesEventFilter` in `automationWorker.ts`); only the
   `event` branch of `automationTriggerSchema` (`packages/shared/src/validators/index.ts`) lacks the
   field, so the validator gains `filter: z.record(z.unknown()).optional()`.
5. Write `compiled_*` pointers and `compiled_hash = sha256(canonical(definition))`.

Every compiled row is deterministic from the definition; the contract test recompiles every
definition and asserts zero diff against the stored rows. A nightly reconcile job does the same in
production and logs drift as a `platform.monitor_drift` event (never silently repairs).

Delete: deleting a definition cascades the managed rows and attachments; open episodes are ended
with `monitor_detached`; the escalation alert (if any) is left open for the human.

## Targeting and inheritance (D3, D4)

A monitor reaches a device through: definition → attachment (in a policy's `monitor` feature
link) → the policy's assignments (`partner | organization | site | device_group | device`, dynamic
groups included) → the device. Parent policies (#5080, one level) contribute their attachments to
the child.

Resolution for a device, `resolveMonitorsForDevice(deviceId)`:

1. Collect every policy assigned to the device at any level, plus each policy's parent.
2. Collect every `config_policy_monitors` row under those policies' `monitor` feature links.
3. Group by `monitor_id`. For each monitor, the row from the **most specific** source wins
   (device > device_group > site > organization > partner; within one policy, child before
   parent). That row's `enabled` and `overrides` apply.
4. The result is the set of enabled monitors with their effective parameters. This is the set the
   `'monitor'` target-type resolver returns for the compiled alert rule, and the set the heartbeat
   config builder uses for agent-side kinds (Wave 4).

This union is deliberately different from every other feature type, which resolves to the single
winning link (`config_policy_effective_feature_links`). The view is untouched; the monitor resolver
is a separate function with its own contract test (partner-wide parent + org child + site override:
the site override disables one monitor and changes one threshold; every other monitor is still
active). Existing readers of the effective-links view never see `feature_type = 'monitor'` links
because nothing else reads that type.

"Deploy to…" in the editor: pick an existing policy (creates or reuses its `monitor` feature link
and inserts the attachment) or "New policy for <site | group>" (creates a policy assigned at that
level with the attachment). The editor lists every policy the monitor is attached to.

## Evaluation and recurrence (D2)

Evaluation is the existing sweep. When the compiled rule's condition handler returns true for a
device, the sweep already creates or dedupes the alert. The monitor layer hooks the same point:

- `on breach(monitor, device)`: if `monitor_device_state.current_episode_id` is null → open an
  episode (`monitor_episodes` insert, `alerts.monitor_id/episode_id` stamped, state updated). If an
  episode is already open → nothing (a continuous breach is one episode, regardless of how many
  sweeps see it).
- `on recovery(monitor, device)`: evidence must be a fresh evaluation returning false. Close the
  episode (`ended_at`, `recovered`), clear `current_episode_id`. Stale heartbeat, device offline, or
  handler `unknown` **do not** close an episode.
- `on episode open`: increment `episodes_in_window` after pruning episodes older than the window;
  if `episodes_in_window >= recurrence_threshold` and not already escalated → **latch**:
  - create one alert `requires_human = true`, severity = max(monitor severity + 1, high), title
    "<monitor> recurred N times in M days on <device>", linked to the episode;
  - run `recurrence_actions` once (device-bound);
  - route through the monitor's delivery and start its escalation policy;
  - set `responses_paused = true` when `pause_responses_on_escalation`.
- Responses: the compiled automation still fires on `alert.triggered`; `automationWorker` checks
  `monitor_device_state.responses_paused` for the (monitor, device) and records
  `skipped_paused` on the episode instead of running. The escalation latch and the pause are set in
  the same transaction as the episode insert, so a response cannot slip through between them.
- Reset: `POST /monitors/:id/devices/:deviceId/reset` (permission `alerts:write`) clears
  `escalated_at`, `responses_paused`, resets the window, records `reset_by`. Acknowledging the
  requires-human alert stops paging (existing behaviour) but does **not** reset — the two are
  separately audited.

Interactions:

- **Cooldown / flapping** gate alert creation, not episodes. If the sweep evaluates true while an
  alert is in cooldown, the episode still opens (or stays open). Noise controls cannot hide a loop.
- **Correlation** groups alerts for presentation and delivery; it never merges or suppresses
  episodes. A requires-human alert is always its own correlation root.
- **AI verdicts** may still run on ordinary monitor alerts. On a `requires_human` alert the verdict
  subscriber records advisory analysis only; it cannot auto-resolve or downgrade it.
- **Maintenance windows** suppress delivery as today; episodes are still recorded and flagged
  `in_maintenance` in `alerts.context` so a post-window report can show them.

Idempotency: episode open/close and the latch use `SELECT … FOR UPDATE` on the
`monitor_device_state` row; the automation run id is written to the episode, so a BullMQ retry
of the response cannot count twice.

## Responses

- Actions are the existing `AutomationAction` union. The compiled automation always runs
  **device-bound** to `payload.deviceId`; this is the `triggering_device` scope from #5240, which
  is a hard prerequisite of Wave 2.
- Ordered actions execute in array order per device; `on_failure = 'stop'` default. Completion is
  tracked per action through the existing `automationRunDeviceResults`; the episode's
  `response_outcome` is set from the run's terminal state (Wave 3 also fixes the "queued reported
  as success" gap in `automationRuntime.ts` so `completed` means completed).
- `ai_triage` is allowed only when the definition names an `ai_agent_id`; the compiler then sets
  `managed_by_agent_id` so the existing admission, loop guards and approval tiers apply unchanged.
  Unmanaged `ai_triage` stays refused (today's behaviour).
- `execute_command` responses of kind `restart_service` on a `service` monitor supersede the
  agent-side `auto_restart` flag: Wave 4 compiles a service monitor with that response to
  `auto_restart = true` on the delivered watch so the restart still happens locally and offline;
  the agent reports the attempt and the episode records it as a response with
  `response_outcome` from the agent's result.

## Delivery

- `delivery_mode = inherit` reproduces today's behaviour: `notificationRoutingRules` pick channels
  by severity/site/tags. `channels` sends to the listed channels *in addition to* routing rules
  (never fewer than routing would send). `none` suppresses delivery for this monitor (still in the
  inbox).
- `escalation_policy_id` is applied on the compiled rule's overrides. Verified on main: the
  config-policy alert path (`evaluateDeviceAlertsFromPolicy`) does not look up an escalation policy
  the way `evaluateDeviceAlerts` does. Monitors compile to `alert_rules` (the standalone path), so
  they get escalation for free; Wave 2 adds the missing lookup to the policy path anyway so the
  compatibility tabs are not worse than monitors.
- Ticket delivery arrives with #5238 as a channel type and a `create_ticket` action; the
  `recurrence_actions` slot is where it plugs in for "open a ticket when a human is needed".

## Monitor types (D5)

`monitor_kind` enum and where each evaluates:

| kind | evaluates via | wave |
|---|---|---|
| `cpu`, `memory`, `disk` | `threshold` handler (metric, operator, value, duration) | 1 |
| `offline` | `offline` handler | 1 |
| `event_log` | `event_log` handler | 1 |
| `patch_compliance` | `patch_compliance` handler | 1 |
| `service`, `process` | `service_stopped` / `process_stopped` handlers over `serviceProcessCheckResults`; the watch itself still comes from the config-policy Monitoring tab until Wave 4 | 1 (evaluate), 4 (deliver) |
| `process_resource` | `processResource` handler | 1 |
| `cert_expiry`, `bandwidth`, `disk_io`, `network_errors` | existing handlers | 1 |
| `antivirus` | new handler over security-center / Defender status (`agent/internal/security`) | 3 |
| `software_presence` | new handler over software inventory (installed / not installed / version below) | 3 |
| `backup_continuity` | new handler over native backup job age and `backupSlaWorker` results | 3 |
| `script` | first-class: a diagnostic script runs on the monitor's interval through the existing script dispatch; exit code ≠ 0 or a `::breeze:monitor:: {"state":"breach","detail":"…"}` marker = breach; timeout = `unknown`. The diagnostic script is distinct from response scripts. | 3 |
| `network_check` (ping, tcp, http, dns) | adapter over `networkMonitors` + `networkMonitorAlertRules`; requires #5241 first and adds partner-wide ownership to those tables | 4 |
| `snmp`, `snmp_throughput` | separate SNMP poller; OID threshold + rate-normalised deltas with counter-wrap handling | later spec |
| `wmi_query`, `perf_counter`, `file_size`, `hardware_sensor` | new agent acquisition contracts | later specs |

Each kind declares: `conditionSchema` (zod), `overridableKeys`, `toAlertCondition(condition)` (the
handler payload), `titleTemplate`, `defaultSeverity`, `supportsResponses`, and `agentDelivered`
(service/process/script/network). The registry lives in `apps/api/src/services/monitors/kinds/`,
one file per kind, hub file for the map — the `aiTools*.ts` pattern.

## Navigation and web

Left nav (`Sidebar.tsx`):

- **Alerts** → `/alerts` — unchanged (inbox, acknowledge, suppress, resolve, correlations,
  Incidents).
- **Monitoring** → `/monitoring` (renamed "Network Monitor" entry under Fleet Management). The hub
  uses a **path-based** tab strip (the `AlertsTabStrip` pattern) because the existing network page
  already owns `window.location.hash` for its own tabs: **Monitors** `/monitoring` (default from W2;
  in W1 the network page stays at `/monitoring`), **Network** `/monitoring/network` (the existing
  page, moved in W2), **Delivery** `/monitoring/delivery` (notification channels; routing rules and
  escalation policies join when they get a UI), **Legacy rules** `/monitoring/rules` (standalone
  alert rules with no `managed_by_monitor_id`, each with **Convert to monitor**; W2). Page title
  "Monitoring & Automation".
- **Jobs** → `/jobs` (new entry, top level after Scripts, permission `automations:read`). Hash tabs:
  `#all` (default), `#scheduled`, `#on-demand`, `#webhooks`, `#event-rules` (unmanaged event-trigger
  automations, so nothing a customer built disappears). Run history stays the per-row modal.
  `/automations`, `/automations/new` and `/automations/:id` become 301 redirects to `/jobs*`.
  Monitor-managed automations are hidden from Jobs (W2) and shown inside their monitor.
- Config-policy editor: new **Monitors** tab (attachment list with enable/override per row, plus
  "Attach existing" and "Create monitor"). Existing Monitoring / Alert / Automation tabs remain
  and gain a one-line banner pointing at Monitors for fleet-wide rules.

Monitor editor (`/monitoring/monitors/:id`, `MonitorEditor.tsx`), sections in this order, each a
card: **What to watch** (kind picker + condition fields from the kind's schema) · **Severity &
noise** (severity, cooldown, auto-resolve) · **Respond** (ordered actions, same `useFieldArray`
component as `AutomationForm`, device-bound note) · **Notify** (delivery mode, channels,
escalation policy) · **Escalate to a human** (threshold N, window days, actions, pause toggle) ·
**Deployed to** (policies, "Deploy to…"). Create-only `ownerScope` selector and "All orgs" badge
per the partner-wide playbook. Detail view adds an **Activity** tab: episodes per device, current
escalations, reset button.

Device page: the existing Monitoring hash-tab lists the device's effective monitors with state and
open episode, replacing the watches-only view.

Copy: the phrase "Service & Process Monitoring" disappears from nav and page titles; it survives as
the config-policy tab label until that tab is retired.

## API

All under `/monitors`, org- or partner-scoped through the usual auth context; partner-wide writes
gate on `canManagePartnerWidePolicies`.

| route | purpose |
|---|---|
| `GET /monitors` | list (filters: kind, enabled, ownerScope) |
| `POST /monitors` | create (`ownerScope`, definition); compiles |
| `GET /monitors/:id` | definition + compiled pointers + attachments + state summary |
| `PATCH /monitors/:id` | update; recompiles; `ownerScope` omitted |
| `DELETE /monitors/:id` | cascade |
| `GET /monitors/kinds` | registry: schemas, overridable keys, availability per platform |
| `POST /monitors/:id/attachments` | `{ configPolicyId }` or `{ createPolicyFor: { level, targetId } }` |
| `DELETE /monitors/:id/attachments/:attachmentId` | |
| `PATCH /config-policies/:id/monitors/:attachmentId` | enable / overrides |
| `GET /monitors/:id/devices` | per-device state, open episode, escalation |
| `POST /monitors/:id/devices/:deviceId/reset` | clear escalation, resume responses |
| `POST /monitors/:id/test` | dry-run the condition against one device, returns the handler verdict |
| `POST /alert-rules/:id/convert-to-monitor` | legacy conversion: builds a definition from the rule + template, attaches to a new policy assigned like the rule's `targetType/targetId`, marks the old rule inactive with `converted_to_monitor_id` |

MCP: `list_monitors`, `get_monitor_activity`, `reset_monitor_escalation` (Tier 2). `manage_monitors`
(create/update) is Tier 3 like `manage_automations`.

## AI

- The AI alert-verdict subscriber keeps running on ordinary monitor alerts; `requires_human`
  alerts get advisory analysis only.
- A monitor with `ai_agent_id` compiles to an AI-managed automation; AI Operator (feature #5205)
  sees it as any other managed automation. No new admission path.
- `get_monitor_activity` gives the AI the episode history it needs to explain "this has recurred
  three times" instead of reasoning from raw alerts.

## Waves

| wave | ships | must not break |
|---|---|---|
| **W1 — discoverability** (no schema) | Jobs nav entry + `/jobs` pages over existing automations with the trigger tabs; `/automations` redirects; "Network Monitor" nav entry becomes **Monitoring** with a path tab strip (Network, Delivery) | every existing URL (redirects), permissions, the network page's own hash tabs |
| **W2 — definitions and compile** | `monitor_definitions`, `config_policy_monitors`, `monitor` feature type, kind registry for the eleven existing handler kinds, compiler + managed-row guards + drift contract test, `'monitor'` target resolver, cumulative resolution, escalation lookup on the policy alert path, monitor editor + policy Monitors tab, "Deploy to…", convert-to-monitor. **Prerequisite: #5240 (device-bound event automations).** | alert sweep, correlation, cooldown, routing, escalation policies, partner fan-out, #5080 inheritance, AI verdicts, MCP `manage_automations` (now refuses managed rows) |
| **W3 — episodes and recurrence** | `monitor_device_state`, `monitor_episodes`, episode open/close in the sweep hook, latch + requires-human alert + pause + reset API, Activity tab, `response_outcome` from terminal run state (fixes queued-as-success), `requires_human` handling in auto-resolve and the verdict subscriber | AI admission and loop guards, delivery dedupe, escalation cancellation |
| **W4 — coverage** | handler-only kinds (antivirus, software_presence, backup_continuity), script monitor, network_check adapter (after #5241) with partner-wide `networkMonitors`, service/process watch delivery from `resolveMonitorsForDevice` (heartbeat builder reads monitors first, config-policy tab second) | agent config payload shape (`monitoring_settings` unchanged on the wire), local auto-restart |
| **W5 — retirement decisions** (separate program) | whether the config-policy Alert/Automation/Monitoring tabs become thin pointers; SNMP and agent-acquisition kinds get their own specs | — |

Each wave is its own plan and PR set; W1 can ship before the others are planned.

## Risks and mitigations

- **Managed-row drift** through a writer the guard misses (AI agents, MCP, portal, seeds). The
  guard is in the service layer, the contract test recompiles everything, and the nightly
  reconcile logs drift as an event. Any writer that bypasses the service layer is a bug.
- **Double evaluation** if a converted legacy rule is left active. Conversion marks the rule
  inactive in the same transaction and the UI hides converted rules by default.
- **Cumulative inheritance surprises**: a site policy that only wanted to *add* a monitor also
  inherits the org baseline. This is the intended model (D4); the policy Monitors tab shows
  effective rows with their source badge, and `disable` is a one-click override.
- **Partner-wide monitors fan out to every org**; responses run scripts per device org (existing
  automation semantics). The `automationResourceBindings` drift guard already refuses a partner
  automation that references an org-owned script; the compiler validates `responses` through the
  same binding check at save time so the failure is at authoring, not at 3 a.m.
- **Episode semantics under stale data**: a device that goes offline mid-breach keeps its episode
  open; the offline monitor (a separate kind) covers the outage. Documented in the editor copy.
- **Service/process shim** between W2 and W4: service/process monitors evaluate through the sweep
  but the watch still comes from the policy Monitoring tab, so a `service` monitor without a
  matching watch never breaches. W2's editor warns when no watch delivers the named service to the
  monitor's scope; W4 removes the gap.
- **Stale worktree during design**: the exploration for this spec ran partly on a checkout 307
  commits behind main; every claim in this document was re-verified on `origin/main`
  (`df36bc667a`) before writing.

## Review log

- 2026-09-07 — Fable position and Codex (gpt-6-astra, xhigh, read-only) position written
  independently from the same context pack. Agreement: authoring-layer unification over existing
  engines; Alerts stays the inbox; Jobs rename plus the missing nav entry; script monitor
  first-class; existing handlers first. Codex improvements adopted: breach-episode counting,
  targeting through policy attachment, cumulative inheritance, explicit delivery mode, device-bound
  responses as a prerequisite. Codex proposal deferred: `monitor_revisions`. Two bugs found and
  filed from the review: #5240 (event automations fan out), #5241 (network-monitor alerts never
  publish `alert.triggered`).
- 2026-09-08 — D1–D5 approved by the product owner ("go with recommendations").

## Release notes

- New **Monitoring** and **Jobs** entries in the left nav. Automations are now called Jobs;
  existing links redirect.
- **Monitors**: watch a condition, run a response on the affected device, notify, and escalate to a
  human when the same problem recurs N times in M days. Deploy monitors through configuration
  policies, including partner-wide.
- Alert rules you already have keep working; each can be converted to a monitor from
  Monitoring → Legacy rules.
- Fixed: event-triggered automations now act on the device that raised the event (#5240);
  network-monitor alerts now notify and escalate like every other alert (#5241).
