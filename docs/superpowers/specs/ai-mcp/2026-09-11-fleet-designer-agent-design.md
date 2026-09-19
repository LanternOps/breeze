# AI Agents: the Fleet Designer kind (Fleet Design report, proposals, apply)

**Date:** 2026-09-11
**Status:** Approved. Advisor quorum convened 2026-09-12 (Codex `gpt-6-astra`, read-only, `xhigh`) — see §5. Tracked as `LanternOps/breeze#5650`.
**Baseline:** `a3be849802` (main, 2026-09-10).
**Origin:** Todd's product direction of 2026-09-11 (business docs: `LanternOps-marketing-v2/lanternops-site/docs/sales/2026-09-11-fleet-design-clean-slate-migration.md`): a migration should be a clean slate. Breeze crawls the fleet, works out what each device is for, proposes every monitor and alert with a reason, turns legacy scripts into an intent inventory, and applies the design on approval. "All we need is an agent specifically to put it all together in a report."

---

## 1. Problem

A migration onto Breeze today ports the old environment: scripts, monitors, policies, and a decade of "just in case" alert rules. The migration toolkit (Recipes 1 to 6) moves structure and data well. Nothing decides what the fleet should be monitored for, why, and with what action, so the new tenant inherits the old noise. The phase-2 AI program built the machinery to judge alerts, run sweeps, write a weekly narrative, triage tickets, and count outcomes, but every one of those lanes starts from whatever rules the tenant already has.

Breeze already collects everything a designer needs: discovery and topology, device inventory and software, what other tools manage each endpoint, event logs, patch and vulnerability state, the fleet findings feed, the alert template library, playbooks, and the script library. What is missing is one agent whose job is to read all of it and produce a justified design: per device, what it is for; per function, what to watch, at what threshold, with what action and what paging; per legacy script, whether it is obsolete, covered, or a real need; and a document a technician approves section by section before any of it becomes live configuration.

This spec adds that agent as a fourth `ai_agents` kind, `designer`, on the narrative lane's pattern: a scheduled or manual org-scoped run on its own profile, system-assembled bounded evidence, one outcome tool submitting a fixed section contract, persisted through the existing reports tables. It adds a typed home for inferred device function, a `rationale` field on the config-policy objects the design materializes, and a human-driven apply step that turns approved proposals into inactive configuration policies and then activates them. Nothing executes on a device. Nothing is created until a human approves it.

---

## 2. Verified facts the design rests on (main `a3be849802`, checked 2026-09-11)

**Agent kinds, runs, schedules.**
- `AI_AGENT_KINDS = ['triage','patch','helpdesk']` at `packages/shared/src/types/aiAgents.ts:1-2`; validator `packages/shared/src/validators/aiAgents.ts:210`. Run profiles `['full','verdict','sweep','narrative','triage']` at `types/aiAgents.ts:761-762`.
- `ai_agents` at `apps/api/src/db/schema/aiAgents.ts:44-78`: dual ownership (`orgId` :46, `partnerId` :47, XOR :39-43), `kind` :48, `mode off|shadow|act` :51, `toolAllowlist` :53, `limits` :55, `triggers` :56, `recipients` :57, `instructions` :63. Partial unique indexes `ai_agents_partner_kind_uq` :72-73 and `ai_agents_org_kind_uq` :74-75: **one live agent per (owner, kind)**.
- `ai_agent_runs` at `aiAgents.ts:82-160`: `profile` :93, `scheduleId` :103, `reportRunId` :111, `triggerKind` :132, `policySnapshot` :137, `outcome` :140, `costCents` :143. Single admission entry `createAndEnqueueAgentRun` in `apps/api/src/services/aiAgents/runService.ts`; queue `ai-agent` (`apps/api/src/jobs/aiAgentEnqueuer.ts:46-47`, no retries :17-26).
- `ai_agent_schedules` at `apps/api/src/db/schema/aiAgentSchedules.ts:13-54`: `kind` (`sweep|narrative`) :38, `cron` :39, `timezone` :40, `enabled` :42, partner baseline with org tighten-only override via `baselineScheduleId` :29. Scheduler `apps/api/src/jobs/aiAgentSweepScheduler.ts:1-45` fans out one run per org and picks the profile from the schedule kind (:19-22).
- Adding a kind touches: `types/aiAgents.ts:1`; `AGENT_KIND_PRESETS` `apps/api/src/services/aiAgents/agentToolCatalog.ts:288-307` and the hand-enumerated DTO literal :417-419; `agentToolCatalog.contract.test.ts`; web `apps/web/src/components/settings/aiAgents/steps/PurposeStep.tsx:86-117`, `agentDraft.ts:47,64,81`, `AiAgentForm.tsx:331-351` (kind is create-only); i18n `aiAgentsPage.kinds.<kind>` and `aiAgentsPage.flow.kinds.<kind>.{blurb,runsWhen,recommended}`. `AgentCreateFlow.tsx:76,102` defaults to the first free kind and guards exhaustion.

**The narrative lane (the pattern to copy).**
- Narrative runs finalize in `apps/api/src/services/aiAgents/runLoop.ts` and persist through `apps/api/src/services/aiAgents/narrativeReport.ts:202 persistNarrativeReport`: one `reports` definition plus one `report_runs` artifact per occurrence (:13-23, :72, :311-333), `NARRATIVE_REPORT_TYPE = 'ai_org_narrative'` :85, `format: 'pdf'` :251, the sections stored in `report_runs.result.summary.narrative` (:45-53), the assembled context deliberately not stored (:50-53). Run to artifact link is `ai_agent_runs.report_run_id`. Migrations `apps/api/migrations/2026-09-24-a-report-type-ai-org-narrative.sql`, `2026-09-24-b-ai-agents-org-narrative.sql`.
- Sweep evidence is system-executed before the model runs, bounded rows and byte cap (`sweepEvidence.ts`, per the P2-2 amendment in `docs/superpowers/specs/ai-mcp/2026-08-28-ai-agents-phase2-intelligence-layer-design.md` §4.2).
- `narrativesDelivered` is `count(*)` of runs with `profile = 'narrative'` by finished day: `apps/api/src/services/aiAgents/impactRollup.ts:282-286`. Counter keys `packages/shared/src/types/aiAgentImpact.ts:15-19`; a new counter needs the shared key list, `aiAgentImpactDaily.ts` column and CHECK, a migration, the rollup CTE and upsert (`impactRollup.ts:282-337`), the DTO (`impactQuery.ts:81,144`), and the tiles (`ImpactPage.tsx:172-190, 751+`).

**Guardrails.**
- `checkAgentGuardrails` `apps/api/src/services/aiGuardrails.ts:1739-1878`: the allowlist gate (:1821-1825) and the device-binding gate (:1817-1819) are both conditioned on `!readOnly`; the propose and act branches (:1840, :1867) likewise. **A read-only tool call is allowed with no allowlist entry.** Tier 4 and secret-bearing tools are unreachable (:1768, :1836-1838). Graduation (`graduationService.ts`, namespaces `policy_key` and `act_op`) tracks only policy-decidable and act-manifest keys; a run that only reads and submits an outcome has no tracked tuple.

**Read tools available to the designer today (name at registering file).**
- Devices: `query_devices` `aiToolsDevice.ts:52`, `get_device_details` :146, `get_device_context` :202, `query_custom_fields` :475.
- Logs: `search_logs` `aiToolsEventLogs.ts:43`, `get_log_trends` :167, `detect_log_correlations` :282.
- Monitoring and policies: `query_monitors` `aiToolsMonitoring.ts:64`, `get_service_monitoring_status` :346; `list_configuration_policies` `aiToolsConfigPolicy.ts:183`, `get_configuration_policy` :479, `get_effective_configuration` :245, `configuration_policy_compliance` :666; `manage_alert_rules` `aiToolsFleet.ts:1943-1949` (read-only by design).
- Playbooks and scripts: `list_playbooks` `aiToolsPlaybooks.ts:58`, `get_playbook_history` :274; `list_scripts` `aiToolsScripts.ts:791`, `get_script_details` :845, `list_script_templates` :946, `search_script_library` :1128.
- Fleet: `get_fleet_findings` `aiToolsFleet.ts:2696`, `analyze_fleet_metrics` `aiToolsPerformance.ts:337`, `get_fleet_health` `aiToolsUserRisk.ts:61`; `network_discovery` `aiToolsNetwork.ts:649`, `get_network_changes` :121; `get_security_posture` `aiToolsSecurity.ts:170`, `get_cis_compliance` `aiToolsCisBenchmark.ts:66`, `get_vulnerability_report` `aiToolsVulnerability.ts:168`, `get_backup_status` `aiToolsBackup.ts:287`; patch reads on `manage_patches` `aiToolsFleet.ts:667`.
- **Not found:** a software-inventory read tool (nearest: `get_software_compliance` `aiToolsCompliance.ts:81`, `software_inventory` report type on `generate_report` `aiToolsFleet.ts:2176`); certificate or warranty tools; a topology read tool (topology rows exist at `apps/api/src/db/schema/discovery.ts:323-347`); a management-posture read tool (service `apps/api/src/services/managementPostureReport.ts:121,151,192,263` exists with no AI tool in front of it).

**Objects a design would materialize.**
- Configuration policies `apps/api/src/db/schema/configurationPolicies.ts:73-103`: dual ownership, `status active|inactive|archived` (:26-30, default active :78); `createConfigPolicySchema` accepts `status` (`packages/shared/src/validators/index.ts:537-553`), so **a policy can be created inactive and unassigned**. Feature links :113-128; monitoring watches `config_policy_monitoring_watches` :392+ (`enabled`, thresholds, auto-restart); alert rules `config_policy_alert_rules` :185-203 (**no `enabled`, no rationale**); assignments :164-179 with `level partner|organization|site|device_group|device` (:54-60) and `roleFilter varchar(30)[]` :170, evaluated at `apps/api/src/services/configurationPolicy.ts:2204` against `devices.device_role`.
- Alert rules outside policies are deprecated (`apps/api/src/routes/alerts/rules.ts:270`); `alert_templates` (`alerts.ts:44-64`) have `description` :49 and no enabled column.
- Playbooks `apps/api/src/db/schema/playbooks.ts:84-102`: org-only, `description NOT NULL` :88, `isBuiltIn` :91, `isActive` :92; **no create route** (`routes/playbooks.ts` has execute :233-240 and patch :358 only); three built-ins seeded by `services/builtInPlaybooks.ts:235`.
- Scripts `apps/api/src/db/schema/scripts.ts:26-78`: dual axis, `isSystem` :44, versions, tags (`script_to_tags` :128), **no draft or status column**. Bundle import `services/scriptBundle/index.ts:689 importBundle` with modes `skip|rename|new-version` :329; routes `routes/scriptBundle.ts:81,116,144`. Script Builder AI tools write into the editor form, not the DB (`scriptBuilderPrompt.ts:26,37,54`).
- Reports: `report_runs` `apps/api/src/db/schema/reports.ts:96-151` (`result` jsonb, `requestedByKind` CHECK :127-150); `REPORT_TYPE_LABELS` `packages/shared/src/reportPdf/reportPdf.ts:84-88`; `buildReportPdf` :1438.

**Device roles.**
- `devices.device_role varchar(30) NOT NULL DEFAULT 'unknown'` and `device_role_source varchar(20) NOT NULL DEFAULT 'auto'` at `apps/api/src/db/schema/devices.ts:63-64`; the SSOT `DEVICE_ROLES = [workstation, server, printer, router, switch, firewall, access_point, phone, iot, camera, nas, unknown]` at `packages/shared/src/validators/deviceRoles.ts`. Manual edits set source `'manual'` (`routes/devices/core.ts:1709`); provisioning sets `'auto'` (`routes/devices/provision.ts:209`). **`device_role` is a coarse asset class that drives contract billing** (`contract_lines_device_roles_chk`, migration `2026-10-05-100100`), not a functional role. There is no functional-role concept anywhere (NOT FOUND).
- Tags are `devices.tags text[]` (`devices.ts:117`); there is no tags table. Custom fields are device-only, typed (`customFields.ts:33-49`, values `deviceCustomFieldValues.ts:26-40`).

**Fleet findings.** `apps/api/src/db/schema/fleetFindings.ts:7` kinds `metric_anomaly_pattern | log_correlation | reliability_offenders`; producers `services/fleetFindings/producers.ts:51,138,221`; routes `routes/fleetFindings.ts` (list :128, remediate :213, lifecycle :329). Org-only.

**Tenancy and migrations.** New-table workflow `CLAUDE.md:49-56`; cascade and export-policy registration :58-73 (export policy fires on new columns; any jsonb is `excludedOpen`); Partner-Wide First :85-96. Migrations are hand-written SQL named `YYYY-MM-DD-HHMMSS-<slug>.sql`, applied in `localeCompare` order by `autoMigrate.ts`, must sort after the newest committed file (currently `2026-10-15-160010-backup-snapshots-layout-manifest.sql`); Drizzle tables are hand-edited in the same commit.

**Deliverables.** `org_documents` and `service_deliverable_evidence` are designed (`docs/superpowers/specs/billing/2026-09-10-service-deliverables-portal-design.md` §4.3-4.4, waves W01-W05) and **have no code yet**. This spec does not depend on them (§4.4, §7).

---

## 3. Goals and non-goals

**Goals.**
1. A technician can run a Fleet Design for one organization and get, in one document: what was found, what each device is for (with confidence and evidence), what each function should be monitored for and why, what automation each function needs, what the legacy scripts were for and which survive, the precursor inventory and the alert-rate baseline, and what the agent is unsure about.
2. Every proposed monitor and alert carries a rationale, and the rationale is stored on the object that gets created, not only in the report.
3. Nothing changes on the fleet from a design run. Proposals are data. A human approves by section and an apply step creates configuration policies inactive, assigns them, and activates them, with a readable diff and a rollback.
4. A design reruns on a schedule and reports drift between the approved design and the live fleet as a finding.
5. The whole lane ships on `BREEZE_AI_AGENTS_ENABLED` alone, on the existing runner, budget model, guardrails, and reports tables.

**Non-goals (v1).**
- Execution of anything on a device by the designer. It never proposes an action intent.
- Partner-wide roll-ups across organizations (a design is per org; §7).
- Importing legacy *monitors* from another RMM (no import format exists; scripts only, via the bundle importer).
- A playbook create route or a script draft state. Approved scripts are created through the existing scripts route; playbook proposals in v1 select from built-ins or describe a custom playbook for a human to author.
- Changing `device_role` semantics or billing. The designer may propose a coarse-role correction, flagged as billing-relevant, and it only lands through the apply step.
- New fleet-finding producers (software age, certificate expiry, patch age). The designer computes those in-report from evidence; materializing them is a follow-up (§7).
- Storing the design in `org_documents` (not built). The reports tables are the landing place until then.

---

## 4. Design

### 4.1 The kind, the profile, the schedule

- **Kind `designer`** appended to `AI_AGENT_KINDS`. One live designer per owner, like the others. Default mode `shadow` is meaningless for a read-only kind; the create flow offers only `off` and `act`, and `act` means "runs and writes reports" (no intents can be produced; see 4.2).
- **Profile `design`** appended to run profiles, with its own limits in `AiAgentLimits` (snapshot bump): `maxDesignRunsPerDay` (default 4, 1 to 24) — enforced at admission rule 6b over a 24-hour window (`profileCaps` gains `windowMs`), `maxConcurrentDesignRuns` (1, 1 to 4), `designBudgetCentsPerRun` (default 300, 25 to 2000), `designMaxTurns` (default 60). Design runs are admitted on their own counters and are circuit-neutral on success, like sweeps.
- **Schedule kind `design`** added to `ai_agent_schedules.kind` (CHECK widened), same partner-baseline and org-tighten-only semantics; the scheduler maps `kind:'design'` to `profile:'design'`. Default cadence for a partner baseline: quarterly. Manual trigger: `POST /ai/fleet-design/runs` with `{ orgId, siteId? }` (the existing `POST /ai/agents/:id/runs` body is `{ deviceId }` only and stays that way); the route resolves the org's effective `designer` agent and calls `createAndEnqueueAgentRun` with `profile: 'design'`. A `design` schedule must target a partner-wide `designer` agent (`scheduleService.assertPartnerWideScheduledAgent`); sweep and narrative keep requiring `triage`.
- **Presets** for the kind: an empty allowlist. The designer reaches read-only tools by the guardrail rule (no allowlist needed) and one outcome tool. The catalog DTO's `presets` literal gains `designer: []`; the capability picker hides mutating capabilities for this kind and shows the read set as "always on."

### 4.2 The run: evidence, tools, outcome

**Evidence bundle, system-assembled before the model runs** (`designEvidence.ts`, same discipline as `sweepEvidence.ts`: bounded rows, byte cap, display fields only). Per organization:

| Section | Source (existing services) | Bound |
|---|---|---|
| Devices | `devices` with role, OS, hostname, last seen, site, group; `devices.tags`; custom field values | 2,000 devices; beyond that, per-site chunks (§4.9) |
| Software | software inventory observations per device, collapsed to (name, version, device count) | top 500 entries |
| Services and listeners | service monitoring results; discovered open services from discovery | per device, capped |
| Network | discovery assets, topology rows (`network_topology`), baselines and open change events | 2,000 rows |
| Who else manages it | `getManagementPostureSummary` + `getPostureDevices` (`managementPostureReport.ts:192,263`) | full |
| Health and risk | reliability scores, open metric anomalies, `fleet_findings` open episodes, vulnerability summary, patch compliance, backup status, CIS summary | full |
| Current configuration | configuration policies and their feature links (monitoring watches, alert rules), assignments, alert templates in use | full |
| Automation on hand | built-in and custom playbooks; script library entries tagged `legacy-import` (4.7) | 1,000 scripts |
| Event-log signal | `detect_log_correlations` output and top recurring event ids per device class, last 30 days | 500 rows |
| Baseline numbers | alerts per 100 endpoints per month (last 90 days), open tickets per month, precursor-band membership computed from thresholds in 4.3 | full |

The bundle is written to the run trace as display-only projections, never stored whole (the narrative precedent).

**Tool floor.** Unlike the narrative profile (empty floor), the design profile gets a small read-only drill-down floor so the model can verify a guess: `get_device_details`, `get_device_context`, `search_logs`, `get_script_details`, `get_configuration_policy`, `get_playbook_history`. Every call is tier 1 or `readOnly` tier 2 and passes `checkAgentGuardrails` on the read path. `designMaxTurns` caps the loop.

**Outcome tool `submit_fleet_design`.** The only mutating-shaped tool the profile can reach, and it mutates nothing but the run outcome. It validates the payload against the section contract (4.3) structurally AND referentially inside the tool and throws, so the model retries within its turn budget (there is no run-level contract-violation code); a run that ends without a valid submission completes with `error_code = 'design_missing'` and no report.

**No intents, no proposals through `action_intents`.** The designer's proposals are report content. This is the decision that removes the need for draft state on rules, playbooks, and scripts (§5 D1).

### 4.3 The section contract

`FleetDesignPayload` (shared type + validator, versioned `schemaVersion: 1`). Keys are fixed and each appears exactly once, in this order:

1. `found`: device counts by coarse role and by inferred function; sites; topology summary; posture summary (what else manages the fleet); fleet-wide findings ranked by device count, each with evidence refs.
2. `functions`: one entry per **device function** the model infers (4.5), with `{ functionKey, label, deviceIds[], confidence 0..1, evidence: string[] }`. Low confidence (< 0.6 default, partner-tunable) goes to section 8, never here.
3. `monitoring`: per function, the proposed watches and alert rules: `{ functionKey, watches: [{ watchType service|process, name, alertOnStop, autoRestart, rationale }], alertRules: [{ conditions: AlertRuleCondition[], severity, cooldownMinutes, rationale, action: none|playbook:<id>|script:<id>, paging: none|business_hours|always }] }`. `conditions` is the `alertRuleItemSchema` shape (`config_policy_alert_rules` is inline-only). `sourceTemplateId?` cites an `alert_templates` row for provenance. `action` and `paging` are advisory fields rendered in the report and appended to the stored `rationale` at apply time; alert rules have no binding column for them (roadmap). **`rationale` is required on every item**; the validator rejects an item without one.
4. `retired`: rules and watches present in the current configuration that the design does not carry forward, each with a reason. Empty is valid; omitted is not.
5. `automation`: per function, playbooks selected from built-ins or custom ones described (`name, description, steps[] as prose, triggeredBy: ruleRef`), and scripts proposed (`name, purpose, osTypes[], language, draft content`).
6. `legacy`: the intent inventory over scripts tagged `legacy-import`: `{ scriptId, intent, bucket: obsolete|covered|needed, coveredBy?: module|playbook|template ref, notes }`. Empty when no legacy scripts are present.
7. `baseline`: alerts per 100 endpoints per month, tickets per month, precursor inventory by condition (disk over 80%, reboot pending over 7 days, patch age over 30 days, certificate inside 30 days where known, backup skipped, service restarted more than twice in 30 days), each with device counts. Thresholds are frozen defaults (`FLEET_DESIGN_PRECURSOR_THRESHOLDS`) snapshotted into the report; partner tuning is a roadmap item.
8. `unsure`: low-confidence functions, unreachable devices, findings needing a human, and any coarse-role correction the model proposes (`deviceId, currentRole, proposedRole, evidence`) flagged `billingRelevant: true`.

The `baseline` numbers are computed by the evidence assembler; the model submits `baseline.notes` only.

Rendering: a markdown projection stored in `report_runs.result.summary.fleetDesign` alongside the structured payload; the PDF through `buildReportPdf` with a new `REPORT_TYPE_LABELS` entry `ai_fleet_design: 'Fleet Design'`.

### 4.4 Persistence

Copy `narrativeReport.ts` into `fleetDesignReport.ts`: one `reports` definition per org (`report_type = 'ai_fleet_design'`), keyed by `(org_id) WHERE type = 'ai_fleet_design'` (partial unique index); `source_ai_agent_schedule_id` is set when the first run was scheduled. One `report_runs` artifact per run, `ai_agent_runs.report_run_id` link, `format: 'pdf'`. Enum add for `reports.report_type`. The structured payload lives in `report_runs.result` (jsonb, already `excludedOpen`). No new table for the report.

When `org_documents` ships (deliverables W03), a follow-up copies the PDF into the document library under category `baseline` and attaches it as deliverable evidence; nothing here blocks on it.

### 4.5 Device function: a second axis beside device role

`device_role` is a coarse, billable asset class and stays untouched by the designer except through an approved correction. The designer's "what is this device for" is a new axis, **device function**: `domain_controller`, `file_server`, `print_server`, `hypervisor`, `database_server`, `line_of_business_workstation`, `finance_workstation`, `executive_workstation`, `shared_workstation`, `conference_room`, `kiosk`, `core_switch`, `edge_firewall`, `backup_target`, `unknown`, plus a free-text `custom:<slug>` escape with a label. The list is a shared SSOT (`packages/shared/src/validators/deviceFunctions.ts`) and is expected to grow.

**Storage: `device_function_assessments`** (new table, tenancy shape 5 with denormalized `org_id`; see 4.11):

| Column | Notes |
|---|---|
| `id uuid PK` | |
| `org_id uuid NOT NULL` → organizations | denormalized for RLS and cascade |
| `device_id uuid NOT NULL` | composite FK `(device_id, org_id) → devices(id, org_id)` DEFERRABLE INITIALLY IMMEDIATE |
| `function_key text NOT NULL` | from the SSOT or `custom:<slug>` |
| `label text NULL` | for custom keys |
| `confidence numeric(3,2) NOT NULL` | 0.00 to 1.00 |
| `evidence jsonb NOT NULL` | bounded display strings; export `excludedOpen` |
| `source text NOT NULL CHECK IN ('ai','manual')` | |
| `run_id uuid NULL` → `ai_agent_runs` SET NULL | which design produced it |
| `report_run_id uuid NULL` → `report_runs` SET NULL | |
| `active boolean NOT NULL DEFAULT true` | one active row per device: partial UNIQUE `(device_id) WHERE active` |
| `superseded_at timestamptz NULL`, `created_by_user_id uuid NULL`, `created_at` | |

Rules: a `manual` row always wins and is never superseded by an `ai` row; a new `ai` row supersedes an older `ai` row for the same device; the designer never writes below the confidence threshold (those stay in section 8). A projection column `devices.device_function text NULL` plus `device_function_source text NULL CHECK IN ('ai','manual')` is maintained by the service on every write (not a trigger), so policy targeting and list filters can read it cheaply. Correction UI: the device detail page gets a **Function** field beside Role; saving writes a `manual` row. The `DEVICE_FUNCTION_KEYS` SSOT lands in W01 because the section contract validates against it.

**Targeting by function.** Policy assignments filter by `role_filter` today (`configurationPolicy.ts:2204`). v1 does not add a second filter axis to evaluation. The apply step creates one **device group per function** (`Fleet Design: <label>`, membership = the approved `deviceIds`) and assigns the function's policy at `device_group` level. Groups are visible, editable, and already a targeting level. A `function_filter text[]` on assignments, evaluated beside `role_filter`, is the long-term shape and is put to the quorum (§5 D3).

### 4.6 Rationale on the objects that get created

Column adds, export policy `included`, migration in the apply wave:

- `config_policy_alert_rules.rationale text NULL`
- `config_policy_monitoring_watches.rationale text NULL`
- `alert_templates.rationale text NULL` (for templates the design creates; `description` stays what it is)

The apply step writes the proposal's rationale into these. The policy editor shows the field read-only with an "edit" affordance; rules created by hand may leave it null in v1. A later rule (out of scope here) can require it.

### 4.7 Legacy intent inventory

Input path: Recipe 6 (`POST /script-bundle/import`) with a new optional `tags: ['legacy-import']` on the import body, so imported legacy scripts are discoverable by tag. The designer reads them through `search_script_library` and `get_script_details` and classifies each into `obsolete | covered | needed` with the covering module, template, or playbook when `covered`, and a proposed replacement script when `needed`. Nothing is deleted or modified. The `legacy` section is the only output; a human decides what to do with the bucket.

For Automate, Rob's exported script inventory is bundled with the script-bundle envelope (`services/scriptBundle/schema.ts:137`) by a small converter outside this spec; the designer does not parse foreign formats.

### 4.8 The apply step

`POST /ai/fleet-design/:reportRunId/apply` (permission: manage configuration policies, plus manage scripts when scripts are included). Body: `{ approve: { functions: functionKey[], monitoring: itemRef[], retired: itemRef[], automation: itemRef[], legacy: itemRef[], roleCorrections: deviceId[] } }`. Idempotency and rollback state live in `fleet_design_applied_items` (W03), not in `report_runs.result`. Executed under the caller's access, through existing services, in this order, in one transaction where the services allow it:

1. **Functions.** Write `device_function_assessments` rows (source `ai`, active) for approved functions, superseding prior `ai` rows; update the projection columns. Create or update the per-function device groups.
2. **Retired.** For each approved retirement: monitoring watch `enabled = false`; alert rule removed from its feature link (rules have no enabled column; removal is recorded in the diff with the rationale). Never touches rules the report did not name.
3. **Monitoring.** For each function: create one configuration policy `status: 'inactive'`, org-owned, named `Fleet Design: <function label>`, with a monitoring feature link (watches, `rationale`) and an alert-rule feature link (rules, `rationale`), through `createConfigPolicySchema` and `addFeatureLinkSchema`. Assign it at `device_group` level to the function's group at priority 100 with NULL role and OS filters; a device-group assignment out-ranks site, organization and partner assignments for the same feature type regardless of priority, so the apply preview lists every policy the new one would displace and the technician approves each displacement. Then activate.
4. **Automation.** Approved scripts are created through the scripts route (org-owned, tagged `fleet-design`), and the alert rules that reference them are updated with the created ids. Playbook proposals that select a built-in are linked; custom playbook descriptions are left in the report for a human to author (no create route in v1).
5. **Role corrections.** For each approved device: `device_role = proposedRole`, `device_role_source = 'ai'` (new allowed value; `manual` still wins on later edits). Audit-logged individually because it can change a contract line.

The apply result is stored on the report run (`result.applied`: item refs, created ids, timestamps, user) and rendered as the diff. **Rollback** is `POST /ai/fleet-design/:reportRunId/rollback`: deactivate and archive the policies it created, restore retired watches, remove created groups, supersede the assessments it wrote, and revert role corrections; scripts are left in place but untagged. Rollback is only offered while `result.applied` exists and the created objects are unmodified since apply (checked by `updated_at`).

### 4.9 Large organizations

v1: the evidence assembler takes at most `DESIGN_EVIDENCE_MAX_DEVICES` (2,000) devices; a manual run may be scoped to one site (`siteId`); devices beyond the bound are listed in `unsure` as not assessed. Multi-chunk assembly is deferred (§7).

### 4.10 API and web

API (new file `routes/aiAgents/fleetDesign.ts`, mounted under `/ai/fleet-design`):
- `GET /ai/fleet-design?orgId=` list report runs of type `ai_fleet_design`.
- `GET /ai/fleet-design/:reportRunId` structured payload + markdown + applied manifest.
- `POST /ai/fleet-design/:reportRunId/apply`, `POST .../rollback` (4.8).
- `GET /devices/:id/function`, `PUT /devices/:id/function` (manual assessment).
- Design runs are started through the existing `POST /ai/agents/:id/runs` with `profile: 'design'`.

Web:
- **Fleet Design page** (`/ai-agents/fleet-design`): list by org; a viewer that renders the eight sections with per-item checkboxes, an Apply drawer that shows the diff before confirming (`runAction` for every mutation), and a Rollback action while available.
- **Device detail**: a Function field beside Role, with confidence and evidence when the source is `ai`, editable to a manual value.
- **Agent create flow**: `designer` kind card (blurb, runs-when, recommended copy in i18n); mode choices limited to off and act.
- **Reports list**: `ai_fleet_design` appears like the narrative does, exportable, partner-brandable.

### 4.11 Tenancy, RLS, cascade, export policy

- `device_function_assessments`: shape 5 with denormalized `org_id` (policy `breeze_has_org_access(org_id)`), RLS enabled and forced in the creating migration; add to `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical), `CORE_DEVICE_CASCADE_DELETE_TABLES`, and `CORE_DEVICE_ORG_DENORMALIZED_TABLES`; export policy: `evidence` → `excludedOpen`, everything else `included`; org-merge registry entry `repoint`. Composite FK to devices `DEFERRABLE INITIALLY IMMEDIATE`.
- Column adds (`rationale` on three tables; `device_function`, `device_function_source` on devices; `device_role_source` accepts `'ai'`): export-policy entries `included`.
- `ai_agent_schedules.kind` CHECK widened; `reports.report_type` enum add; `ai_agent_runs.profile` CHECK widened: existing tables, column semantics only.
- Partner-Wide First: the objects the apply step creates are **org-owned instances** of a per-org design, which is what the rule expects for instances. A partner-wide "function baseline" template set is the v2 shape (§7).

### 4.12 Flags, safety, limits

- Ships on `BREEZE_AI_AGENTS_ENABLED`; the kind is hidden from the create flow when the flag is off.
- The designer has no path to `attemptPolicyDecision` and produces no intents; the contract test asserts that the design profile's reachable tool set contains no mutating tool other than `submit_fleet_design`.
- Budget: `designBudgetCentsPerRun` reserved atomically through the existing budget path; a run that exhausts budget before `submit_fleet_design` fails with `budget_exceeded` and a partial trace, and produces no report.
- Apply is a human action under the caller's permissions; nothing in the report is self-applying, including on a schedule. A scheduled design run that follows an applied one produces a **drift** section 4 (rules present that the approved design does not carry, and approved rules missing), and never re-applies.
- Confidence threshold and precursor thresholds are partner settings with frozen defaults, snapshotted into the report.

### 4.13 Error handling

- Evidence assembly failures in one section degrade to a `"not measured"` marker in that section, the way the narrative reports unmeasured inputs; a run only fails when the device section itself cannot be assembled.
- Contract violations are thrown inside `submit_fleet_design` and retried by the model; a run that never submits validly gets `design_missing`. The run itself is not retried (queue has no retries) and the failure counts against the daily limit.
- Apply is transactional per numbered step; a failure in step N leaves steps < N applied, records `result.applied.partial = true` with the failing step and reason, and the UI offers Rollback. Re-running apply skips already-applied item refs.

### 4.14 Testing (minimum per wave)

- Contract: `agentToolCatalog.contract.test.ts` gains the `designer` kind and the assertion in 4.12; `rls-coverage`, `tenantCascade`, `cascadeDelete`, `moveOrg.coverage`, and both export-policy suites cover the new table and columns.
- Unit: `designEvidence` bounds and byte caps; `FleetDesignPayload` validator (every section present exactly once, rationale required, confidence range, threshold snapshot); the intent-inventory classifier receives fixtures of obsolete, covered, and needed scripts.
- Integration (live Postgres): a design run persists one `reports` row and one `report_runs` row per org and links the run; apply creates inactive policies then activates them, assigns by group, writes rationale, is idempotent on re-apply, and rollback restores the pre-apply state; a manual function row is never superseded by an `ai` row; RLS forge as `breeze_app` on `device_function_assessments` fails with 42501.
- Web: viewer renders all eight sections from a fixture; apply drawer shows the diff and blocks confirm until at least one item is selected; device Function field round-trips.

### 4.15 Waves

| Wave | Delivers | Depends on |
|---|---|---|
| **W01** kind, profile, schedule kind, evidence bundle, `submit_fleet_design`, section contract, persistence, PDF, reports-list entry, create-flow card | A designer that writes the report. No apply, no function table. | none |
| **W02** `device_function_assessments`, projection columns, function SSOT, device Function field, section 2 writes on apply | The typed home for "what is this device for." | W01 |
| **W03** `rationale` columns, the apply step (steps 2 to 5), device groups per function, rollback, Fleet Design page with the apply drawer | The clean-slate migration as a product step. | W02 |
| **W04** legacy intent inventory: bundle import tag, section 6, script creation in apply | Bill's thousand scripts become a hundred intents. | W03 |
| **W05** scheduled drift design, `fleetDesignsDelivered` impact counter, org_documents hand-off when available | Quarterly audit and the scorecard row. | W01, W03 |

Each wave is its own plan and PR set, with one idempotent migration named to sort after the newest committed file.

---

## 5. Consequential decisions for the quorum

| # | Decision | Recommended | Alternative | Why |
|---|---|---|---|---|
| D1 | How proposals exist before approval | **Report content only**; apply materializes | Draft state on rules, playbooks, scripts (new columns on three tables and a create route for playbooks) | No draft columns exist; adding them touches billing-adjacent config tables and the policy evaluator. Report-as-data needs no schema change and matches the narrative precedent. |
| D2 | Where the report lives | **`reports` + `report_runs`**, new `report_type` | New `fleet_design_reports` table | P2-3 precedent; PDF, branding, recipients, portal self-service all exist. |
| D3 | How policies target a function | **Device group per function at `device_group` level (v1)**; `function_filter` on assignments later | `function_filter text[]` on `config_policy_assignments` evaluated beside `role_filter` now | Groups need no evaluator change and are visible to techs. The filter is the right long-term shape but changes effective-config evaluation for every device; do it once, with real designs to test against. |
| D4 | Device function storage | **New typed table with a projection column** (4.5) | Projection column only; or a custom field | Confidence and evidence need a home and history; manual-wins needs a source; custom fields are untyped for this and device-only by string key. |
| D5 | Designer and `device_role` | **Propose corrections only, apply with explicit approval, source `'ai'`** | Designer writes `device_role` directly when confident | `device_role` drives contract lines. |
| D4 amendments adopted (W02) | `repoint` merge policy; `(run_id, org_id)` composite FK `ON DELETE SET NULL (run_id)`; `CHECK (confidence BETWEEN 0 AND 1)`, NULL for manual rows; `created_by_user_id` attribution | — | — | Recorded by W02 Task 0: device state follows the device on merge (the org-move trigger re-stamps any `device_id` + `org_id` table anyway); provenance pinned to the same org as the run; a technician states a fact, not a probability. |
| D1/D3 amendments adopted (W03) | `fleet_design_applied_items` ledger with before-images; displacement preview with per-policy approval; NULL role/OS filters on Fleet Design assignments; group ids persisted in the ledger and reused per (org, function); discovery may not overwrite an `'ai'` role | — | — | Recorded by W03 Task 0: rollback reads the ledger (`UNIQUE (report_run_id, item_ref)` is the idempotency key), never a jsonb manifest; a group-level assignment out-ranks site/org/partner for the same feature type, so the technician approves each displaced policy explicitly; role corrections carry source `'ai'` and take precedence over discovery, below `'manual'`. |
| D6 | Tool floor for the design profile | **Small read-only drill-down floor + outcome tool** | Empty floor like narrative | Function inference needs to check a guess against a device; the bundle cannot carry every device's detail. Turn cap bounds the cost. |

Advisor quorum convened 2026-09-12 (Codex `gpt-6-astra`, read-only, `xhigh`): D1 agree with amendments (ledger table, before-images); D3 agree with amendments (displacement preview, NULL filters, persisted group ids); D4 agree with amendments (`repoint` merge policy, `(run_id, org_id)` FK, `CHECK (confidence BETWEEN 0 AND 1)`, NULL confidence for manual rows, user attribution). D2, D5, D6 follow repo precedent.

---

## 6. Open questions for Todd

1. The function list in 4.5: is that the first set, and should `custom:<slug>` be allowed in v1 or only the fixed list?
2. Confidence threshold default (0.6) and the precursor thresholds in 4.3: keep as defaults, or set from the runbook's week-zero numbers on Todd's own fleet first?
3. Should the apply step be allowed to **retire** existing rules in v1 (step 2), or should v1 only add and leave retirement to a human until the coverage check has run on a few real tenants?
4. Cadence for the scheduled drift design: quarterly (matches the deliverables spec's "quarterly configuration audit") or monthly?
5. Whether a `designer` agent should exist at partner level in v1 (one designer, many orgs, per-org runs) or only per org. The schedule model already supports the partner baseline; the question is whether the create flow should offer it now.

---

## 7. Deferred (record on the roadmap)

- Partner-level design roll-up across organizations; partner-wide "function baseline" template sets applied by copy (Partner-Wide First).
- `function_filter` on policy assignments (D3 alternative).
- New fleet-finding producers for software age, certificate expiry, patch age, and precursor-band membership, so those become live episodes rather than report rows.
- A playbook create route and a script draft state, if a later design needs objects to exist before approval.
- Read tools for software inventory, certificates, warranty, topology, and management posture, so the drill-down floor can reach them without the evidence bundle.
- Storing the design PDF in `org_documents` as deliverable evidence once deliverables W03 ships.
- Importing legacy monitors (not scripts) from another RMM.
- A "rules with a rationale" share on the Impact page.
