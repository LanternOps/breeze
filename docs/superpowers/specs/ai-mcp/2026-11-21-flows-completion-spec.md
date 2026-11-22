---
tracking_issue: LanternOps/breeze#12433
---

# Finish Flows as the single home for automations

**Date:** 2026-11-21
**Status:** Approved by Todd on 2026-11-21 (Gate A), with every recommendation in §6 as written. The resolutions are in the table at the top of §6. Product direction: "finish forward" (wave 1 is a manual flow editor plus a single nav item, then the production census, then R2, then R3). Codex quorum on Decisions 1 to 3: see §6 and the quorum note at the end.
**Extends:** `docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md` (the Flows spec) and `docs/superpowers/plans/ai-mcp/2026-10-27-tool-catalog-w6-legacy-automations.md` (the W06 plan, which keeps PR D and PR E as the design record for R2 and R3).
**Code read at:** `origin/main` `aabccd8a6d`.

## Terms used in this document

- **Job.** A row in the legacy `automations` table, edited on the `/jobs` page with `AutomationForm.tsx` and run by `apps/api/src/jobs/automationWorker.ts`.
- **Flow.** A versioned flow document (`FlowDocumentV1`, `packages/shared/src/validators/flows.ts:121-136`) stored in `flows` and run by the flow runner. Enabling a flow publishes an immutable version and records the enabling user as the delegator.
- **Classes.** The W06 plan sorts legacy automations into classes, first match wins: **M** (compiled from a monitor), **A** (AI-agent triage), **P** (policy workflow), **S** (a standalone Job a person made on the Jobs page). **C** is a config-policy automation, which lives in `config_policy_automations`, not in `automations`. **R** is not a class: it marks an S row that a compliance policy uses for remediation (W06 plan, "Legacy inventory").
- **Shadow.** A converted draft flow that sits beside its Job. Hooks on the legacy side count how the flow would have matched, without running anything twice.
- **Switch.** The interactive step that hands every future occurrence of a Job to its flow. **Revert** hands them back.
- **R1, R2, R3.** The W06 retirement stages. R1 shipped the converter, shadow, switch and revert, and turned Flows on by default. R2 freezes Job writes and pre-creates shadow conversions. R3 stops admitting unswitched standalone Jobs on an installation once none are left or its operator accepts the exceptions.

## 1. Problem

Breeze has two automation engines, and the move from the old one to the new one stopped halfway.

- The sidebar shows **Jobs** and **Flows** side by side (`apps/web/src/components/layout/Sidebar.tsx:285-287`). The Jobs page is titled "Jobs", its button says "New Automation" (`apps/web/src/locales/en/scripts.json:367-370`), and the docs page is titled "Automations" (`apps/docs/src/content/docs/features/automations.mdx:2`). A new partner asked on 2026-11-20 what Flows is (#12310).
- **No person can build a flow by hand.** A draft is created only by the `draft_flow` AI tool (`apps/api/src/services/aiToolsFlows.ts:72-105`) or by converting a Job (`apps/api/src/services/flows/conversion/`). `apps/api/src/routes/flows.ts` has list, get, enable, disable, runs and the webhook secret, and no create, update or delete (`routes/flows.ts:1-13` says so). `FlowsPage.tsx:14-16` and `FlowStepList.tsx:132-141` are read-only. A tenant with no AI key, no AI credit, or an active Wisp grant (#10289) cannot author a flow in the web app. `draft_flow` is also reachable over Breeze's MCP server with an `ai:write` key, so an external AI client can author one, but that is not a product path for most technicians.
- W06 R1 refused new Jobs once Flows were on (`apps/api/src/routes/automations.ts:1322-1333` on `origin/main`). PR #12366 (for #12310) lifts that refusal, tags Flows as "Preview", and adds a dated amendment to the W06 plan at Decision 8: the refusal returns together with a manual editor, and PR D's test list must add `POST /automations is 410` back. The PR merged on 2026-11-22 as `affca27e0f`.
- Only class S converts. M, A, P, C and the R dependency still run on the legacy engine core (Flows spec §7, W06 amendment).
- R2 and R3 are designed (W06 plan PR D and PR E, lines 1234-1320) but unbuilt, and they moved to #10336, which has no plan and no waves.
- Seven live checks from the #5215 close-out (comment of 2026-10-29) were never run: the census CLI on US and EU, switching a real scheduled Job, a webhook retry against a switched Job, a revert while parked on approval, the `maxTargets` pause (`binding_drift`), the Jobs page in a non-en locale, and chat smokes for the W05 flow tools. Nobody knows how many unswitched Jobs exist in production.
- The W06 close-out list (W06 plan lines 1375-1399) said to file one issue per deferred item. The orchestrator found none filed; a spot search on 2026-11-21 for the deployment lane, webhook pre-approval, event-filter coercion, the fleet cap and the auto-switch grant also found none. **Not exhaustive.**
- Three open specs aim at the legacy engine that R2 and R3 freeze: #9900, #9209 and #11643.

## 2. Users and scope (partner vs org)

- **Partner technicians (MSP staff)** build automations for one customer org or for every org of the partner. A partner-wide flow is owned by the partner (`flows.org_id` NULL, `partner_id` set) and runs once per live org per occurrence. Creating or editing one needs `canManagePartnerWidePolicies(auth)` (`apps/api/src/services/flows/service.ts:268-272, 322-327`).
- **Org technicians (internal IT, or an MSP user limited to one org)** build org-owned flows. They can read their partner's partner-wide flows through the SELECT-only branch and can never change them.
- **Site-limited technicians** can save a draft today but cannot enable a flow: enable refuses a delegator with a site allowlist (`delegation_scope_restricted`, Flows spec §6.3 W4 amendment, Decision 13). A site-limited technician can save a bounded Job today (`automationRuntime.ts:1214-1290`). This is a parity gap, handled in Open Decision 4.
- **Self-hosting operators** decide with `FLOWS_ENABLED` whether Flows exist at all, and with the event-dispatch settings whether event-triggered flows can be enabled.
- **Out of scope as users:** monitors, AI agents and configuration policies that own M, A, P and C rows. Their authors never see those rows on the Jobs page, and their own editors stay (Open Decision 7).

## 3. Proposed design

### 3.1 The manual flow editor (wave 1)

**Goal.** Anything a person builds with the Job form today, they can build as a flow without AI. That is the bar for bringing the create refusal back (§3.4).

**Shape: a guided form that writes a flow document, with a Document tab for the rest** (Open Decision 1).

The form covers the Job form's shape:

| Form section | Writes into the document | Notes |
|---|---|---|
| Name, description, owner (org or all orgs, chosen at create only) | `name`, `description`; `ownerScope`/`orgId` on the request | Owner selector mirrors `AutomationForm.tsx:107-113` |
| Trigger: schedule (cron + time zone), event (type + equality filter), webhook (HMAC or token; for an all-orgs flow, the org resolver path and system), manual | `trigger` (`validators/flows.ts:65-86`) | Event types reuse the Job form list (`AutomationForm.tsx:188-200`). An event trigger shows "unavailable on this installation" with the reason when event delivery is not durable (`flowValidator.ts:216-219`). Manual-run inputs are Document-tab only in v1 |
| Targets: all devices, devices, groups or filter; or the triggering device | the `target` / `deviceIds: ['{{trigger.device.id}}']` input of the first fleet step | Controls follow the trigger: a device event (for example `device.online`) targets the triggering device and hides the picker, as the converter binds event actions to the triggering device (`convertAutomation.ts:470`); schedule, webhook and manual show `DeviceTargetSelector`. Legacy `conditions` arrays are not offered for new flows; they exist only for converted Jobs |
| Actions, ordered: run a script; send a notification; raise an alert | `run_script_on_targets` (`builtins.ts:181-205`); one `notify` step per action; `create_alert` under `forEach` over the active device set | Later actions chain on the previous script step's `succeededDeviceIds`, the same action-major rule the converter uses (W06 plan, "Conversion map"). `runAs` offers system or user only, because the built-in refuses `elevated` (`builtins.ts:190-191`) |
| On failure: stop, continue, or notify a channel | `onFailure` per step, plus a `notify` step over `failedDeviceIds` with `when: length(...) > 0` | Same shape as the converter's `onFailure: notify` mapping. The label says what the engine tracks: "if the script can't be sent to a device". A queued or dispatched script counts as success, as in legacy (W06 "Conversion map", `queued_is_success`), so the form must not promise "if the script fails" |

Two deliberate differences from the converter's output:

- **A notification is one message per run, not one per device.** The legacy engine sends one notice per device, and the converter keeps that for parity. A new flow does not need it, and per-device notices hit the W05 cap of 20 sends per run on any target set over 20 devices. The message says how many devices succeeded and failed and links the run.
- **"Run a command" is not offered.** The form points to Scripts. The converter's generated-script path (W06 Decision 14) exists for migration only.

**What is not in the form in v1** (Document tab or AI drafting): `when` expressions, `forEach` over arbitrary items, `ai`, `http_request`, `wait`, `set`, tenant tools from tool sources, core catalog tools, manual-run inputs, `limits` and `notices`. These are the parts of the document where a form would either become a node editor (a spec §3 non-goal) or hide what the step does.

**Round trip.** A shared, pure recognizer in `packages/shared` decides whether a stored document is "form-shaped": it decodes the document into form values, recompiles them, and requires the **whole normalized document** to come out equal. A per-step check is not enough: a familiar-looking script step can carry a custom `timeoutSec`, and the document can carry `limits` or `notices` the form does not show (Codex quorum). A form-shaped document opens in the form. Any other document opens with the form read-only, the existing `FlowStepList` review, and the Document tab as the edit surface. The form never silently drops anything it cannot show.

**The Document tab** is a Monaco JSON editor (Monaco is already a web dependency, `apps/web/package.json:31,57`) with the flow JSON Schema for completion, and live server validation through `POST /flows/validate` (§3.2). Validator issues carry JSON pointers (for example `pointer: '/trigger/event'`, `flowValidator.ts:256`), so they map onto editor markers and onto the existing `FlowIssuesPanel`. JSON, not YAML: the document is stored as `jsonb`, the pointers are JSON pointers, and YAML would add a parser and lose comments on every round trip.

**Compile helpers are shared with the converter where the shapes coincide.** The step-emission code for a script action, an alert action and the on-failure notice moves from `services/flows/conversion/convertAutomation.ts` into `packages/shared`, so the form, the recognizer and the converter emit one shape for those steps and `FlowStepList` renders both the same. Converter-only behaviour (per-device notices, generated command scripts, findings and fidelity) stays in the API.

**Enabling from the editor.** Save keeps a draft. "Save and enable" opens the existing `FlowEnableDialog`, which must learn one thing: collecting `fleetMaxTargets` for each pre-approvable `run_script_on_targets` step. Today only the conversion `SwitchDialog.tsx` sends it, so a hand-built script step cannot be pre-approved from the flow page (`services/flows/preApproval.ts:315-317` returns `max_targets_invalid`), and every scheduled run would park for approval. The field and its wording move out of `SwitchDialog.tsx` into a shared component. For a webhook-triggered flow the dialog does not offer pre-approval at all, because webhook runs never honour it (§3.4).

**Editing an enabled flow** keeps the W04 rule in wave 1: drafts are editable only while `draft`, `disabled` or `paused` (`service.ts:57, 331`). The editor offers "Disable and edit" as an explicit confirmation, never as a side effect of an Edit button, and says what disabling does: queued and waiting runs are cancelled, pending approvals are cancelled, and running runs stop at their next checkpoint (`services/flows/versions.ts:475-490`). "Unpublished changes on a live flow" is a later option (Open Decision 2).

**Editing a shadow draft** (a converted Job not yet switched) warns before save that the comparison evidence collected so far resets (`service.ts:369-370`, W06 Decision 3).

**Spec amendment owed.** The Flows spec §3 ("A visual canvas / node editor": the AI writes, humans review) and §6.8 (authoring is AI) get an amendment: humans may author flows through a form and a document editor; a canvas stays a non-goal.

### 3.2 API surface

All new routes sit in `apps/api/src/routes/flows.ts`, behind the router's existing auth, `FLOWS_ENABLED` 404 and `automations.read` gates (`routes/flows.ts:31-38`).

| Route | Gate | Behaviour |
|---|---|---|
| `POST /api/v1/flows` | `automations.write`; MFA per Open Decision 2 (recommended: not required for a draft, because a draft runs nothing and enable already requires MFA and an interactive session) | Body `{ document, ownerScope?, orgId?, slug? }`. Calls `saveDraftFlow` (`service.ts:260-317`), which resolves the owner, gates partner-wide on `canManagePartnerWidePolicies`, validates against the owner's catalog, never stores an invalid document, picks a slug under the partner lock and writes `flow.draft.save` to the audit log. `201 { flow, validation }`; `422 { validation }` when invalid |
| `PUT /api/v1/flows/:id` | same | Body `{ document, expectedVersion }`, `expectedVersion` required. Replaces the draft (`service.ts:319-373`). `409 version_conflict`, `409 flow_not_draft` (enabled), `404` for a row the caller cannot update (an org token on a partner-wide flow is a 404, as today). The owner never changes |
| `DELETE /api/v1/flows/:id` | `automations.delete` + `requireMfa()` (Codex quorum; the permission exists, `packages/shared/src/constants/permissions.ts:178`, although the legacy Job delete uses the write permission, `routes/automations.ts:1710-1714`) | Body `{ expectedVersion }`. A dedicated service locks the row the way enable does, then checks in one transaction: version, `draft` status, no publication, and no conversion generation of any state. Anything else is `409 flow_has_history`; a shadow draft's 409 links to its conversion. Every child table cascades from `flows`, including the conversion ledger (`2027-01-09-100000-flow-automation-conversions.sql:105`), so deleting history is never offered; the answer is disable. Partner-wide needs `canManagePartnerWidePolicies`. New audit action `flow.draft.delete` |
| `POST /api/v1/flows/validate` | `automations.read` | Body `{ document, ownerScope?, orgId?, flowId? }`. The same catalog-aware validation as `validate_flow`; writes nothing. With `flowId` the server derives the owner and, for a shadow draft, the generated-script placeholder allowance (`service.ts:342-346`), so validating a converted draft gives the same answer as saving it |

**Not changing:** enable stays an interactive-user action with MFA and every delegation check (`services/flows/versions.ts:261-267`). Pre-approval stays out of the document (the W3 `pre_approval_not_available` rule holds); it is chosen in the enable dialog.

**Public API, MCP and AI.**
- **General REST API** (`/api/v1/flows`): the four routes above, documented in `apps/docs` reference pages. Additive.
- **MCP server and AI tools:** no new tools. `draft_flow` and `validate_flow` already cover authoring, and their behaviour is the same service call. Delete is UI-only, like enable and disable. The `mcp-coverage` entry for `flows.ts` (`apps/api/src/services/mcpCoverage.ts:860`) gains `draft_flow` and `validate_flow` in its tool list and a comment that delete, enable and disable are UI-only; no new frozen gap.
- **`draft_flow` and the REST routes must not diverge** (raised by the Codex quorum, Open Decision 2):
  1. An update must carry `expectedVersion` on both paths. Today it is optional for `draft_flow` (`aiToolsFlows.ts:85`), so a stale AI or MCP edit can overwrite a person's save from the editor. Stage it: warn for one release, then refuse.
  2. MFA must be the same on both paths. `services/aiToolMfaGate.ts` states that every MFA-gated tool mirrors `requireMfa()` on its REST twin, and `draft_flow` is not gated today. If the REST draft routes required MFA, `draft_flow` would have to join `MFA_GATED_TOOL_ACTIONS`, and then every API-key and OAuth MCP caller would lose drafting while `ENABLE_2FA` is on, because those callers carry no MFA claim (`aiToolMfaGate.ts:151-153`, verified). The recommendation is the other way round: drafts need no MFA on either path, and MFA stays on delete, enable, disable, runs and the webhook secret.
- **Partner API:** no flow writes. It has no Job writes either; its automations surface is a read-only export (`apps/api/src/routes/partnerApi/configuration.ts:581-582`). Add a read-only `GET /partner-api/configuration/flows` export before R2 freezes Jobs, so an integration that reads the automations export can follow the move (Open Decision 2). Projection: the join key is the automations export's existing `conversion.flowId` (`configuration.ts:385`); each flow row carries the draft definition and the live publication separately (sequence, enabled time, delegator id) so a reader can tell what runs from what is being edited; the webhook secret ciphertext is never exported (it is `excludedSensitive` in the tenant export policy, `services/tenantExportPolicyRegistry.ts:592`); the definition follows the automations export's `customer-authored` classification (`exportSafety.classification.ts:47`).

### 3.3 One nav item, one page

**Name: "Automations"** (Open Decision 3). It names the category, not either engine, so it survives the deletion of the legacy engine. It matches the button people already press, the docs page title, the permission resource (`automations`) and the API path. It reverses the September 2026 rename to "Jobs" (`docs/superpowers/specs/monitoring/2026-09-08-monitoring-automation-unification-design.md:40, 54`); that rename named what Jobs were then ("what runs on a schedule or on demand"), and a flow is more than that (events, webhooks, approvals, several steps).

**Layout: a path-based tab strip**, not hash tabs. The Jobs page already owns `window.location.hash` for its trigger tabs and for `#convert-<automationId>` (`AutomationsPage.tsx:32, 274-290`). The Monitoring hub solved the same problem with a path tab strip in the `AlertsTabStrip` pattern (unification spec lines 398-403), including a "Legacy rules" tab with "Convert to monitor", which is the precedent here.

The two tabs keep the two existing list paths, so nothing that already works has to redirect:

| Path | Tab | Content |
|---|---|---|
| `/flows` | **Flows** (default) | The flows list (`FlowsPage`), with "New automation" opening the editor. A one-paragraph explainer on the empty state |
| `/jobs` | **Jobs** | The existing Jobs page unchanged inside the strip: its hash tabs, the "Move to Flows" column, the conversion panel and banner. The tab label carries the count of Jobs not moved yet. It stays visible while any Job row is listed, including switched rows that can still be reverted (the API lists switched Jobs for Revert, `routes/automations.ts:840`, and the flow detail links to them, `FlowDetailPage.tsx:134`). It is hidden only once R3 has closed revert on the installation and no unretired Job remains |

**URLs.**
- **No new redirect touches `/jobs` or `/flows`.** Browsers may have cached the existing permanent `/automations` → `/jobs` redirect (`apps/web/src/pages/automations/index.astro`), so any redirect from `/jobs` to an `/automations` path could loop, and a Flows tab at `/automations` would be unreachable for those users because the cached redirect would always send them to `/jobs` (Codex quorum, refined). Keeping the tabs at `/flows` and `/jobs` avoids both.
- `/jobs` keeps its hash fragments (trigger tabs, `#convert-<id>`; the flow detail links to `/jobs#convert-<automationId>`, `FlowDetailPage.tsx:134`). `/jobs/:id` stays (the legacy edit page and conversion panel) until the legacy drop. `/jobs/new` stays while the create refusal is lifted and redirects to `/flows/new` when it returns (wave 3); nothing redirects back to `/jobs/new` except the old `/automations/new` 301, so there is no loop.
- `/automations` changes its redirect target to `/flows` when Flows are on (to `/jobs` when off). A browser holding the old cached 301 still lands on `/jobs`, which now carries the tab strip, so it reaches Flows in one click. `/automations/new` follows `/jobs/new`. `/automations/:id` keeps redirecting to `/jobs/:id` (those ids are Job ids).
- `/flows/:id` and `/flows/runs/:runId` stay: `draft_flow` returns `reviewPath: /flows/<id>` (`aiToolsFlows.ts:104`), and approval cards and notices link there.
- New: `/flows/new` and `/flows/:id/edit` for the editor.
- The sidebar keeps one entry, "Automations" (`nav.automations`), with the `automations.read` permission, linking to `/flows`. With `FLOWS_ENABLED=false` it links to `/jobs`, the strip has only the Jobs tab, and "New automation" opens the Job form.
- The URL paths keep the engine names while the label says "Automations". That is deliberate: paths are not shown in the nav, and keeping them avoids every redirect hazard above.

**The "Preview" tag** that #12310 adds comes off in wave 3, the release that brings the create refusal back. Until then Flows is not the only way to create an automation, so "Preview" is accurate.

All new strings go into all 8 locales (de-DE, en, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR).

### 3.4 Bringing the create refusal back (wave 3)

`POST /automations` returns `410 automations_moved_to_flows` with `flowsUrl: '/flows/new'` again when Flows are on, **per trigger**: a Job is refused only if a flow with the same trigger can be enabled on this installation. Schedule, manual and webhook Jobs are always refused while Flows are on. An event-triggered Job is refused only when event delivery is durable (`isFlowEventDeliveryDurable()`, `flowValidator.ts:216-219`); otherwise it is still created as a Job, because an event flow cannot be enabled there. The route reads only the trigger type before refusing, so a client still learns where to go whatever else it sent. This matches the per-row exception R2 already designs for frozen rows (a row blocked by `event_dispatch_not_durable` stays writable, W06 plan line 298), so after R2 an installation without durable event delivery can create and edit event Jobs and nothing else. The release notes give the exact `EVENT_DISPATCH_MODE` and `EVENT_DISPATCH_QUEUE_SUBSCRIBERS` lines. Which mode any particular deployment runs is not recorded here.

**Functional parity check before wave 3.** Each Job-form capability is either covered by the editor, a prerequisite for wave 3, or an accepted exception the release notes name:

- **Script, notification, alert, on-failure notice; schedule, manual, webhook and event triggers:** covered by the editor (event triggers subject to the condition above).
- **Event triggers without durable delivery:** handled by the per-trigger refusal.
- **A webhook-triggered script runs unattended.** In a flow, a webhook run never honours a pre-approval (Flows spec §6.5 W5 amendment, Decisions 4 and 9), so a webhook script step asks a person every run. Open Decision 5.
- **Run as elevated:** not offered. The fleet built-in refuses an effective elevated context (W06 Decision 5). Accepted exception: once the refusal is back, no new automation can run a script elevated unattended; existing elevated Jobs keep running until R3 and are counted by the census (`run_as_elevated`).
- **Run a command:** replaced by "save it as a script". Accepted exception.
- **Deploy software:** no flow equivalent (`deploy_software_unmapped`). Open Decision 6.
- **A site-limited technician can save and run a Job:** a site-limited technician can save a flow draft but not enable it. Accepted exception for wave 3, with an in-product "ask an admin to enable" path: a "Waiting for enable" filter on the Flows tab that lists drafts saved by users who cannot enable them (shipped in wave 3). A per-publication site ceiling stays deferred (W05 Decision 17) and is filed as an issue (Open Decision 8).
- **More than 500 targets, or more than 20 notifications per run:** the editor states the limits at save; the one-message notification design avoids the second.

The census (§3.5) counts how many existing Jobs each of these touches, through the converter's finding codes (`approval_each_run`, `run_as_elevated`, `command_becomes_script`, `deploy_software_unmapped`, `site_ceiling_removed`, `targets_over_cap`, `notify_per_run_cap`).

### 3.5 Census and live checks (wave 2)

**What the census is.** `apps/api/scripts/automationConversionCensus.ts` runs `conversionCensus()` (`services/flows/conversion/census.ts:37-90`) in system context and prints aggregates: counts per class (total and enabled), compliance-remediation targets, counts per conversion fidelity and per finding code, the number switched, enabled unswitched S rows, the age of the oldest switch, and context errors. It never prints an id, a name or row content.

**What it reads.** All `automations` rows and the live `flow_automation_conversions` rows. For each S row, `loadConversionContext` (`conversion/context.ts`) reads the owning org and partner, the referenced scripts and notification channels, the resolved target devices and their OS types, any monitor conversion, the creator's current permissions, partner org counts, flow limits and this month's flow usage, and the Job's run count over the last 30 days.

**What it writes.** No automation, flow, device or setting rows (`census.ts`, `context.ts`, `convertAutomation.ts` and `classify.ts` contain no insert, update or delete). It is **not strictly write-free**: target resolution goes through the shared resolver (`context.ts:90` → `resolveAutomationTargetsDetailed`), which appends a system audit event when a Job's inline filter or group uses agent-reported fields (`deploymentTargetResolver.ts:106-114, 201`), and the creator-permission lookup (`getUserPermissions`) may populate a permission cache (unverified). The CLI also opens event-bus and queue handles and exits explicitly when done (`automationConversionCensus.ts` comments). Running it is safe; the operator should expect those audit rows.

**Wave 2 adds two things to the census before it runs** (small code change, read-only):
1. Class **C** counts (total and enabled `config_policy_automations` rows with the automation feature live). The current census counts M, A, P and S only (`census.ts:47`).
2. The number of enabled unswitched S rows that are **not form-shaped**, that is, whose converted document the editor could not open in the form. This sizes how much the Document tab must carry.

**Who runs it.** Todd, or an operator with his go-ahead, on the US and EU installations. Only the JSON aggregates leave the host. They go into a comment on the feature issue, never into the repo.

**The live checks** (each recorded pass or fail on the feature issue, screenshots kept local):
1. Census on US and EU (above).
2. Switch a real scheduled `run_script` Job.
3. A webhook sender retries against a switched Job's old URL; the retry is a duplicate.
4. Revert while a flow run is parked on approval; the parked run finishes and the next delivery runs on legacy.
5. A pre-approved fleet step pauses with `binding_drift` when targets exceed `maxTargets`.
6. The Automations page (both tabs) and the editor in a non-en locale.
7. Chat smokes for the W05 flow tools (`run_flow`, `get_flow_run`, flow tools as `flow__<slug>`).
8. New: build the Job-form equivalent of a scheduled script with an on-failure notice in the editor, enable it with a pre-approval and `maxTargets`, and watch one scheduled run complete without a person.

### 3.6 R2 and R3

R2 and R3 follow the W06 plan's PR D and PR E (lines 1234-1320) with these changes:

- **Gating restated.** The W06 plan gated R2 "at least one release after R1". R1's refusal was lifted, so R2 ships at least one release after wave 3 (the refusal's return), and R3 at least one release after R2.
- **The R2 freeze and the wave 3 refusal use the same per-trigger rule.** A row blocked by `flows_disabled` or `event_dispatch_not_durable` stays writable (already in PR D), and wave 3 still lets such an installation create event Jobs (§3.4), so the two never disagree about which Jobs a person can make or change.
- **The R2 banner and the Jobs tab** say "Jobs can't be changed any more. Move them to Flows" and link the editor for new work.
- **R3 is inert when `FLOWS_ENABLED=false`.** The PR E gate already refreshes from the census each scan tick; this makes the flag check explicit so a Job created on a Flows-off installation always runs.
- **R3 on hosted needs the hosted census to show zero enabled unswitched S rows, or Todd's recorded acceptance.** The per-installation acceptance flag (`LEGACY_JOBS_RETIREMENT_ACCEPTED`) is an operator decision on each self-hosted installation, as designed.
- **Deployment and webhook Jobs** are decided before R3 (Open Decisions 5 and 6), because R3 is where an unmoved Job stops running.

Deleting the worker and dropping the tables is not in this feature (Open Decision 7).

### 3.7 Wisp and the AI dependency (#10289, #11155)

**What the editor makes unnecessary.** Authoring and editing a flow no longer depend on chat, an AI key, AI credit or the Wisp ceiling. The headline symptom of #10289 ("flows cannot be drafted at all while Wisp is on") is gone for anyone who uses the web app.

**What still needs fixing.**
- `run_flow` and `cancel_flow_run` are agent human-only and still refused in a Wisp chat. Starting and cancelling runs from the flow page works, so this is a chat gap, not a product gap.
- The other agent-denied tools in #10289's list remain unreachable in Wisp chats; that is #11155's job and is unaffected.
- The two defects in the 2026-10-28 addendum on #10289 stay: denied tools are still advertised through ToolSearch, and a ceiling refusal of a read flags the session.

**Recommendation.** Remove "flows" from the justification of #11155 and leave its priority to the Wisp roadmap; do not block any wave here on it.

### 3.8 Self-hosters

**With `FLOWS_ENABLED=false`:** `/api/v1/flows*` stays 404, the Automations page shows only the Jobs tab, "New automation" opens the Job form, `POST /automations` stays open, R2 leaves writes open, and R3 does nothing. Nothing in this feature deletes data.

**Release notes owed** (each under its own heading in `docs/release-notes/next-release-draft.md`, append only, and in the GitHub Release body through the `release` skill):
- **Wave 1:** the flow editor and the four REST routes; Jobs and Flows share one nav entry, "Automations"; the old URLs and where they go; `draft_flow` updates without `expectedVersion` are warned (refused one release later); if Open Decision 2 adopts the MFA mirror instead, say that MCP callers lose drafting while `ENABLE_2FA` is on; "Preview" still on.
- **Wave 2:** the census additions; nothing changes for users.
- **Wave 3:** new Jobs are refused when Flows are on, except event Jobs on an installation without durable event delivery, with the exact env lines; the accepted exceptions (elevated scripts, commands, site-limited enable, deployment per Open Decision 6, webhook approval per Open Decision 5); "Preview" removed.
- **Wave 4 (R2):** Jobs become read-only except disable, delete, preview and convert; the pre-create sweep and its opt-out `FLOW_CONVERSION_SWEEP_DISABLED`; the startup error; the Partner API flows export if adopted.
- **Wave 5 (R3):** the per-installation gate, `LEGACY_JOBS_RETIREMENT_ACCEPTED` and what it disables, the S+R rows that are kept, the `410` for unswitched webhook URLs. No data is deleted.

## 4. Tenancy and data model impact

- **No new table and no new column in waves 1 to 5.** The editor writes the existing `flows` table through `saveDraftFlow`. Owner shape is unchanged: org XOR partner, with the partner-wide write gate in the service and RLS (`flows_isolation` FOR ALL plus the SELECT-only partner-wide branch) deciding what an update can target.
- **Delete** removes a never-published, never-converted `flows` row. Its only children at that point are none or empty; the route refuses any flow with publications or a conversion generation, so no run, intent or ledger row is ever cascaded away.
- **No new setting.** The editor, the nav and the refusal add no partner or org setting (`docs/agents/settings.md` rule 9 does not apply). R2 writes its sweep outcome to `partners.settings.flowConversionSweep` as PR D designs; that is a status record, and the `orgSettingsWriters` contract classifies it there.
- **Migrations:** none in waves 1 to 5 at the defaults (W06 plan line 51 says the same for PR D and PR E). The drop sequence (W06 Decision 8) belongs to the follow-up feature, each step with its own migration and its cascade, export-policy, org-merge and `rls-coverage` removals in the same PR.
- **Partner API flows export (if adopted):** read-only over existing tables; each column is classified in `exportSafety.classification.ts`, and the `definition` jsonb follows the automations export's `customer-authored` default.

## 5. Out of scope

- Converting classes M, A, P and C, re-pointing compliance remediation (R), deleting `automationWorker`, the `automations` queue and `scan-schedules`, and the table drop sequence (Open Decision 7).
- A visual canvas or node editor (Flows spec §3 stays).
- New built-ins (deployment, reboot, wait-for-device) except where an Open Decision adopts one.
- Changing flow tiers, the pre-approval lanes, or enable's delegation rules.
- Any automatic switch of a Job to a flow (W06 Decision 2 stands).
- The Wisp ceiling redesign (#11155).

## 6. Decisions (resolved at Gate A, 2026-11-21)

Todd approved every recommendation below as written. The options and the Codex positions are kept as the record of what was considered.

| Decision | Resolution |
|---|---|
| OD1 Editor shape | **A.** Guided form plus a JSON Document tab, with the whole-document recognizer |
| OD2 API surface | **A.** Four REST routes over `saveDraftFlow`, no new MCP or AI tools, read-only Partner API flows export before R2. Edit-while-enabled (B) is a later wave. **No MFA on drafts, on either path** (option i); Codex's MFA-on-drafts position (option ii) was considered and not adopted |
| OD3 Nav name and layout | **A.** One entry, "Automations", with path tabs at `/flows` and `/jobs` |
| OD4 Create refusal | **A.** Returns in wave 3, per trigger, with the named exceptions |
| OD5 Webhook scripts | **C.** Decided from the census; B (webhook flows always ask a person) is the wave 3 position |
| OD6 Deployment Jobs | **C.** Decided from the census; defaults to B if the hosted count is small |
| OD7 Scope | **B.** This feature is standalone-Job completion, editor through R3, under the new parent issue #12433. #10336 stays the roadmap item for the managed classes, the worker deletion and the table drops |
| OD8 Deferred items | **B.** Census-driven: blockers become conditional waves (W3a), the rest are filed as roadmap issues, the auto-switch grant is dropped |
| OD9 Legacy-aimed specs | #9900 split (group targeting proceeds now, multiple triggers re-aimed at flows); #9209 and #11643 re-aimed at flows |

Each decision had a recommendation. Decisions 1 to 3 went to a Codex quorum; where Codex disagreed, both positions are recorded.

### OD1. Editor shape

- **A. Guided form plus a Document tab (JSON).** Pros: matches the Job form people know; covers every Job-form shape the create refusal must replace; the Document tab carries everything else without a node editor; small enough for one wave. Cons: two edit surfaces; needs a recognizer so the form never mangles a document it cannot show.
- **B. A step-list editor built on `FlowStepList`** (add, reorder, pick any catalog tool, inputs generated from the tool's JSON Schema, `when` and `forEach` fields). Pros: one surface for every document; general. Cons: large (arbitrary schema-driven inputs, templates, expressions); it is a node editor in list form, which the Flows spec's non-goal argues against; does not look like the form people know.
- **C. A JSON editor only, with validation.** Pros: smallest. Cons: unusable for most of the Job form's audience; cannot honestly justify bringing the refusal back.

**Recommendation: A.** Codex agreed on A, on JSON over YAML and on moving the step emitter into `packages/shared` while ownership checks, findings and generated scripts stay in the API. It added three refinements, all adopted in §3.1: the recognizer compares the whole normalized document, controls follow the trigger, and the on-failure label says "can't be sent" rather than "fails".

### OD2. API surface

- **A. Four REST routes** (`POST /flows`, `PUT /flows/:id`, `DELETE /flows/:id` for never-published drafts, `POST /flows/validate`) over `saveDraftFlow`; no new MCP or AI tools; no Partner API writes; a read-only Partner API flows export before R2. Pros: thin, reuses the one write path the AI tool uses, so validation, owner rules and audit cannot diverge; no new delegation model. Cons: two public surfaces (REST and `draft_flow`) to keep in step; delete is limited.
- **B. A plus edit-while-enabled** (save drafts on an enabled flow; the live publication keeps running until "Publish changes"). Pros: no coverage gap while editing, closer to how Jobs behave. Cons: changes the W04 invariant that an enabled flow's draft is its live definition; every runtime path that reads `flows.definition` (for example the webhook info block, `service.ts:147-158`) must be audited first.
- **C. A without the Partner API export.** Pros: less surface. Cons: an integration that reads the automations export loses sight of automations as they move.

**Recommendation: A now; B as a later wave once the plan has audited every `flows.definition` reader.**

Codex agreed on the four routes, no new MCP tools and the read-only export before R2. Where it differed, both positions:
- **Delete permission.** My draft used `automations.write`, following the legacy Job delete (`routes/automations.ts:1710-1714`). Codex: use the existing `automations.delete` plus MFA, lock the row and check everything in one transaction. **Adopted Codex's position** in §3.2; the permission exists for this purpose and the lock closes a race with a concurrent enable.
- **`draft_flow` must require `expectedVersion` on update.** Not in my draft. **Adopted** (§3.2), staged over one release.
- **MFA on drafting. Disagreement; resolved at Gate A as option (i), no MFA on drafts.** Codex: put `requireMfa()` on the REST draft routes and mirror it on `draft_flow` (the repo rule in `aiToolMfaGate.ts`), accepting that MCP callers lose drafting under `ENABLE_2FA`. Mine: the impact is total for MCP authoring (API-key and OAuth MCP callers never carry an MFA claim, `aiToolMfaGate.ts:151-153`), and a draft runs nothing; the delegation decision is enable, which already requires MFA and an interactive session. So neither path requires MFA for a draft, and both stay consistent with the mirror rule. Options: (i) no MFA on drafts, either path (recommended); (ii) MFA on both, MCP drafting lost under 2FA (Codex); (iii) MFA on REST only, which breaks the mirror rule (rejected by both).
- **Validation of shadow drafts** takes a `flowId` so it matches save. **Adopted** (§3.2).

### OD3. Nav name and layout

- **A. "Automations"** as the one nav label, with a path tab strip over the existing paths: Flows (`/flows`, default) and Jobs (`/jobs`). Pros: names the category, matches the button, docs, permission and API, survives the legacy drop; a path strip keeps the Jobs page's own hash state. Cons: reverses the September rename to "Jobs" that came from a community request.
- **B. Keep "Jobs"** as the umbrella label and fold Flows under it. Pros: no rename; keeps the Alerts / Monitoring / Jobs model. Cons: the objects inside are called flows everywhere else (AI tools, docs, API), so the label and the content disagree indefinitely.
- **C. "Flows"** as the umbrella, Jobs as a legacy tab. Pros: names the engine that stays. Cons: an engine name, not a task name; unfamiliar to the people who used Jobs; the docs and permission still say automations.

**Recommendation: A.** Preview comes off in wave 3.

Codex agreed on the name and the single entry, and disagreed with two parts of my first draft: (1) I had `/jobs` redirecting to `/automations/jobs`; Codex pointed out that browsers may hold the existing permanent `/automations` → `/jobs` redirect, so the reverse redirect can loop. (2) I had the Jobs tab hidden once no unmoved Job remained; Codex pointed out that switched Jobs stay listed for Revert until R3, and the flow detail links to them. **Both adopted** in §3.3, and taken one step further: a Flows tab at `/automations` would itself be unreachable for a browser holding the cached redirect, so the tabs stay at `/flows` and `/jobs`, no redirect touches either, and the Jobs tab stays until R3 closes revert.

### OD4. When the create refusal returns, and its exceptions

- **A. Refuse per trigger while Flows are on** (event Jobs stay creatable where event delivery is not durable), **with named accepted exceptions** (elevated scripts, commands, site-limited enable, plus whatever Open Decisions 5 and 6 decide). Pros: never leaves an installation unable to build an event automation; matches R2's per-row rule; honest release notes. Cons: one more condition to explain to self-hosters.
- **B. Refuse whenever Flows are on** (the original R1 rule). Pros: simplest. Cons: an installation without durable event delivery cannot create event automations at all.
- **C. Do not bring the refusal back until R2.** Pros: no regression window. Cons: new Jobs keep appearing on the engine R3 retires, which grows the migration it must finish.

**Recommendation: A.**

### OD5. Webhook-triggered scripts that must run unattended

A legacy webhook Job runs its script without a person; a webhook flow parks every script run for approval (webhook runs never honour pre-approvals).

- **A. Build webhook pre-approval for literal selectors before R3** (the deferred W06 item: a fleet binding allowed for webhook runs only when the selector is literal and no template reaches the target set). Pros: real parity; webhook Jobs can move. Cons: reopens a W05 safety decision; needs its own quorum.
- **B. Accept it: webhook flows always ask a person.** Pros: keeps the W05 position that a leaked secret must not choose devices. Cons: webhook script Jobs cannot move without changing behaviour; R3 would stop them.
- **C. Decide from the census** (`approval_each_run` count on hosted): A if it is material, B otherwise.

**Recommendation: C, with B as the wave 3 position** (refusing new Jobs does not touch existing webhook Jobs; R3 does).

### OD6. Deployment Jobs (`deploy_software`)

- **A. Build a deployment built-in and its pre-approval lane before R3.** Pros: parity. Cons: a different deployment model (`createSoftwareDeployment` vs `manage_deployments`), a new Tier 3 lane, sizeable.
- **B. Point deployment automation at software policies and deployments** (the product's main deployment path) and keep deployment Jobs on the S+R-style "kept" list at R3 until the follow-up feature. Pros: no new lane; uses the purpose-built feature. Cons: those Jobs stay on the legacy engine longer.
- **C. Decide from the census** (`deploy_software_unmapped` count).

**Recommendation: C, defaulting to B** if the hosted count is small.

### OD7. Scope line for #10336

- **A. One feature: everything** (S completion, M, A, P, C, R, worker deletion, drops). Pros: one tracker. Cons: very long; each managed class needs its own conversion map and shadow parity, so the user-visible fix waits on work users do not see.
- **B. This feature is S completion (editor through R3).** M, A, P, C, R, worker deletion and the drop sequence become a follow-up feature that #10336 continues to track as a roadmap item (retitled, or a new roadmap issue linked from it). C gets its own design there, because config-policy automations are user-authored inside policies and target through policy assignment, a different model from a flow's target. Pros: the confusing part (two nav items, no manual authoring) is fixed in a shippable sequence; the managed classes keep their own editors meanwhile. Cons: the worker and tables live on for a while.
- **C. B plus C-class in this feature.** Pros: covers every user-authored automation. Cons: drags config-policy assignment semantics into the editor work; #9900 shows those semantics are not settled.

**Recommendation: B.** Register the S-completion feature under a new parent issue once this spec is approved, and keep #10336 as the managed-classes roadmap item.

### OD8. The unfiled deferred items

- **A. File one issue each, now, labelled roadmap** (deployment lane, webhook pre-approval for literal selectors, coercing event filters, the for-each and fleet cap, the per-publication site ceiling, W05 Decision 17 items, the W04 follow-ups, the event route-enqueue drop, W06 Decision 6 residuals (a) and (b), and the #10270, #10284 and #10285 residuals). Pros: nothing is lost. Cons: many issues with no owner.
- **B. Census-driven:** items that block moving existing Jobs (webhook pre-approval, deployment, event-filter coercion, the fleet cap) become conditional waves of this feature, decided by their finding counts; the rest are filed as roadmap issues; the auto-switch grant is dropped (W06 Decision 2 says no release switches anything, and R2's pre-created shadows plus bulk switch cover the need).
- **C. Drop everything not needed for R3.** Pros: focus. Cons: loses known residuals with security relevance.

**Recommendation: B.**

### OD9. The three legacy-aimed specs

The same three options apply to each issue:

- **A. Re-aim at flows.** Pros: no new work on an engine R2 freezes and R3 retires; flows already have most of the parts. Cons: waits on wave 1 where the editor must show the new capability.
- **B. Build on Jobs anyway.** Pros: the reporter's mental model; can start now. Cons: the work is frozen at R2 and must be redone on flows before R3; it grows the migration.
- **C. Hold until R3.** Pros: no wasted work. Cons: real customer needs (the #9900 deployment case, the #9209 POS reboots, the #11643 client report) wait months.

Per issue (analysis, then recommendation):

- **#9900 (any device group, multiple triggers).** Split it. **Group targeting** is engine-independent: flows' fleet built-ins call the same target resolver (`services/flows/builtins/fleetTargets.ts:71` → `resolveAutomationTargetsDetailed`), which applies the same agent-reported-field gating. Fix it once in the resolver, as Todd's 2026-10-24 comment proposed (operator-attested membership plus a warning at save), and both engines benefit. **Multiple triggers:** re-aim at flows only; do not add it to Jobs, which R2 freezes. It needs a document change (`trigger` becomes a list, or a v2 document) and editor support, so sequence it after wave 1. The reporter's case is a config-policy automation (class C), which moves only in the follow-up feature; say so on the issue. **Recommendation: split; group targeting is engine-independent and can proceed now; multiple triggers takes A.**
- **#9209 (serial scheduled jobs).** Re-aim at flows. The legacy engine is action-major (every device runs action 1 before any runs action 2), which is the opposite of "one device at a time, wait until it is back". A flow already has sequential `forEach` and `wait`; what is missing is a reboot built-in, a "wait until this device has rebooted and checked in" built-in with a timeout that stops the run, and an uptime predicate for targets. The spec must also answer how a per-device Tier 3 step under `forEach` runs unattended, because today the fleet pre-approval lane is never used under `forEach`. B would also contradict the legacy engine's action-major model. **Recommendation: A, after wave 1.**
- **#11643 (script output to email or ticket).** Re-aim at flows. A flow can already trigger on `script.completed`, read the execution with the core `get_script_execution` tool (status and output, `aiToolsScripts.ts:14`) and put `{{steps.<id>.output...}}` into a templated `notify` message or a ticket. **Unverified:** that `get_script_execution` is allowed as a flow step for every owner. What is left is the guardrails the issue lists (size cap with a truncation marker, using the stored redacted output, escaping in HTML email and markdown, whether webhook channels may carry output) and the engine-independent `device.rebooted` event. Do not add templating to the legacy `send_notification`. **Recommendation: A; it can be built in parallel with wave 1.**

## 7. Test and rollout notes

- **Rigor.** Wave 1 PR A (REST routes, partner-wide writes, delete) is public API surface and a partner-wide write path: red test first, one Opus review. Waves 4 and 5 follow the W06 plan's high-rigor rules (they stop a live admission path). Web work: red test first, typecheck, targeted tests.
- **API tests.** Route tests for each status code in §3.2, including an org token against a partner-wide flow (404 on PUT and DELETE), a selected-access partner user (partner-wide create refused), a stale `expectedVersion` (409), an enabled flow (409 `flow_not_draft`), and delete of a flow with a publication or a conversion (409). `partner-wide-write-coverage`, `routerAuthGate`, `mcp-coverage` and `site-scope-coverage` contracts stay green.
- **Shared tests.** The recognizer: every form-built document is recognized; a document with any step the form cannot show is not; the form's compile output always validates. The converter's existing fixtures still pass after the step-emission code moves.
- **Web tests.** Editor mutations go through `runAction` (`no-silent-mutations.test.ts`); every new key in all 8 locales; Playwright with `data-testid` only for: build and save a scheduled script automation, enable it with `maxTargets`, open a non-form document read-only, path tabs and every redirect in §3.3.
- **Census.** Unit test that the new C counts and the form-shape count contain no uuid (the existing `census output contains no uuid` rule).
- **Rollout.** Waves 1 and 2 ride normal releases behind `FLOWS_ENABLED`. Wave 3 waits for the wave 2 checks to pass. Waves 4 and 5 are release-gated as in §8, and each self-hosted installation moves at its own pace (R3 is per installation).

## 8. Proposed waves

| Wave | What ships | Gating | Rough size |
|---|---|---|---|
| **W1 Editor and one nav item** | PR A: the four REST routes, shared compile helpers and recognizer, `draft_flow` `expectedVersion` warning, `mcp-coverage` entry, docs reference. PR B: the editor (form, Document tab, "Save and enable"), `fleetMaxTargets` in `FlowEnableDialog`. PR C: "Automations" nav entry, path tab strip on `/flows` and `/jobs`, the `/automations` redirect target, empty-state explainer, locales. Flows spec amendment (§3, §6.8) | None beyond `FLOWS_ENABLED`; "Preview" stays | L (three PRs) |
| **W2 Census and live checks** | Census gains C counts and the form-shape count. Operator runs the census on US and EU (Todd's go-ahead; read-only apart from audit rows, §3.5). The eight live checks, recorded on the feature issue | W1 deployed to hosted | S code, plus operator time |
| **W3 Refusal returns** | `POST /automations` 410 under OD4's per-trigger rule; `/jobs/new` → `/flows/new`; "Waiting for enable" filter; `manage_automations` description points to flows; "Preview" removed; docs; wave 3 release notes | At least one release after W1; W2 checks pass; OD4 to OD6 decided | S |
| **W3a Parity prerequisites (conditional)** | Only what OD5, OD6 and OD8 adopt from the census: webhook pre-approval for literal selectors, a deployment path, event-filter coercion, a higher fleet cap | Each its own Gate B; must land before W5 | 0 to L, census-driven |
| **W4 R2 freeze** | W06 PR D as designed plus §3.6 changes; Partner API flows export (OD2) | At least one release after W3 | M |
| **W5 R3 retirement** | W06 PR E as designed plus §3.6 changes (inert with Flows off; hosted needs zero enabled unswitched S rows or Todd's acceptance) | At least one release after W4; W3a items adopted for R3 have shipped | M |

The census itself has no code dependency on W1 and could run earlier; the owner's order places it after W1, and this table keeps that order.

## Quorum note

Codex (`gpt-6.2-astra`, `xhigh`, read-only, first attempt, 2026-11-21) was asked for an independent position on Open Decisions 1 to 3. **It was not blind:** the prompt included my positions and their rationale, so its agreements carry less weight than its disagreements. Summary:

- **OD1:** agreed (A, JSON, shared step emitter). Added: whole-document recognizer, trigger-driven controls, honest on-failure label, no pre-approval offer for webhook flows. All adopted.
- **OD2:** agreed on the four routes, no MCP tools, export before R2. Disagreed on the delete permission (`automations.delete`, not write; adopted), on leaving `draft_flow` updates unversioned (adopted), and on MFA (Codex: MFA on REST drafts and mirrored on `draft_flow`; **not adopted**, both positions in OD2, because the verified effect is that every API-key and OAuth MCP caller loses drafting under `ENABLE_2FA`). Asked for `flowId` on validate and a warning before a shadow draft resets (adopted).
- **OD3:** agreed on "Automations" and one entry. Disagreed on redirecting `/jobs` (cached-301 loop risk) and on hiding the Jobs tab while revert is still possible. Both adopted; the fix was extended so the tabs stay on the existing `/flows` and `/jobs` paths.
- **Other points it raised:** the release baseline on `origin/main` still refuses Job creation and the Flows list test expects no preview notice (`FlowsPage.test.tsx:44`), consistent with #12310's PR not having merged yet; the plan must check the branch state before wave 3 is written. "Disable and edit" must explain what disable cancels (adopted, §3.1). The Partner API export needs a defined projection (adopted, §3.2).

Where Codex disagreed, the Open Decision records both positions, whether or not its position was adopted.
