---
title: Zero-Touch Device Onboarding
status: approved-in-brainstorm, awaiting written review
date: 2026-09-07
owner: Todd Hebebrand
area: onboarding-signup
related:
  - docs/superpowers/specs/misc/2026-09-06-offline-work-queue-design.md
  - docs/superpowers/specs/vuln-patch/2026-08-15-package-manager-software-library-design.md
  - docs/superpowers/specs/vuln-patch/2026-08-14-org-scoped-software-catalog-design.md
  - docs/superpowers/specs/ai-mcp/2026-07-18-action-intents-approval-layer-design.md
  - docs/superpowers/specs/installer-enrollment/2026-08-02-enrollment-idempotency-design.md
companion_specs:
  - docs/superpowers/specs/vuln-patch/2026-09-07-verified-software-library-consumer-design.md
  - docs/superpowers/specs/vuln-patch/2026-09-07-software-library-hub-brief.md
  - docs/superpowers/specs/billing/2026-09-07-partner-entitlements-design.md
  - docs/superpowers/specs/api-platform/2026-09-07-partner-api-execute-scope-design.md
---

# Zero-Touch Device Onboarding

## 1. Summary

A tech plugs a USB stick into a new Windows machine at the out-of-box screen, walks away, and the machine ends up joined, named, loaded with the customer's software, configured, and handed to its user, with a live timeline in Breeze and an AI supervisor that diagnoses and repairs failures under the existing approval model.

Under the hood this is a **sequencer over primitives Breeze already has**: software deployments, script dispatch, configuration policies, the offline work queue, the device command result path, and the AI agent / action-intent layer. The new pieces are:

- An **onboarding plan** (template) and **onboarding run** (per-device instance) with an ordered, phased, verified step contract.
- **Admission**: a first-enrollment trigger plus pre-registration by serial number or enrollment key.
- A **Windows provisioning package** builder that installs the agent at OOBE with a long-lived bootstrap token and an Entra bulk-join token.
- A deterministic **runner** on the server, and an **AI supervisor** agent kind that wakes on failure, overrun, or failed verification.
- Board, timeline, and plan-editor UI; partner-API read access.

Market context, for the record: ImmyBot sells exactly this as a separate product on top of an RMM; no RMM ships an onboarding lifecycle as a first-class object. Action1 proves MSPs pay a flat per-endpoint rate for a catalog someone else maintains. The supervisor (§9) is the natural premium boundary.

## 2. Decisions made during brainstorming

| # | Question | Decision |
|---|---|---|
| D1 | Where do AI lab tests run (catalog spec) | Both: Breeze-hosted lab first, partner lab ring second |
| D2 | Spec order | Both specs now; onboarding built first; catalog consumes the step contract |
| D3 | What triggers a run | Any first enrollment matching an org/partner plan, **plus** explicit assignment via pre-registered serial or enrollment key |
| D4 | Platform scope | Windows first; step schema platform-aware from day one; macOS runner is a later wave |
| D5 | Identity join | Entra join via bulk enrollment token in the package; on-prem domain join out of scope |
| D6 | Who the device is for | Primary contact assigned at pre-registration or first appearance (org contacts); end-user self-identification is a later wave |
| D7 | v1 scope | Core + AI supervisor. OOBE remote console is a post-v1 **verify-and-fix** wave (the session broker and secure-desktop capture already exist; likely gap is role selection for the OOBE `defaultuser0` session) |
| D8 | Where the run state machine lives | **Server-orchestrated.** Network access to the API is assumed throughout onboarding. The Breeze agent is the hands; the AI supervisor is the brain. An agent-local runner was considered (Codex quorum initially preferred it for offline continuation) and rejected once offline continuation was dropped as a requirement. The plan/run/step schema is designed so a local runner could be added later without changing the contract. |
| D9 | Package build tool | Two-day **spike** on a native server-side `.ppkg` generator; fallback is building on a **Breeze-managed Windows device the MSP designates**, driven by a device command. Both consume the same server-generated project XML. A downloadable hand-run build kit falls out of the second path. No Breeze-owned Windows build worker. |
| D10 | Autopilot | Supported as a second **entry path** (Intune installs the agent during ESP; same plan/run); never combined with the package's bulk join; runner holds reboots/installs until ESP completes. Hash registration and profile management out of scope. |

## 3. Goals and non-goals

**Goals**

- One package per org (or per pre-registration batch) that a tech can apply at OOBE with one click.
- A run object that survives reboots, offline gaps, and API restarts, and that reads as one story in the UI.
- Deterministic, verifiable steps; verification is independent of installer exit codes.
- An AI supervisor that gets stuck runs to completion under budgets and approvals, and hands off cleanly to a human when it cannot.
- Partner-wide-first ownership for plans; device-org ownership for runs.

**Non-goals (v1)**

- Offline continuation when the Breeze API is unreachable.
- On-prem AD offline domain join.
- macOS/Linux execution (schema supports; runner does not).
- End-user self-identification at first sign-in.
- Autopilot *orchestration* (registering hashes, managing profiles). Autopilot as an **entry path** is in scope: see §7.5.
- Billing/edition gating of the supervisor beyond the entitlement key `onboarding_supervisor` (partner entitlements spec). `mode: off` is the ungated default.

## 4. Architecture

```
USB .ppkg ──(OOBE)──> agent MSI + bootstrap token ──> POST /installer/bootstrap ──> enroll
                                                                                   │
                                            enrollment tx: device row + admission (run row, pending)
                                                                                   │
                                                          ┌────────────────────────┴───────────────┐
                                                          │  onboardingRunner (BullMQ worker + tick) │
                                                          │  step → device_command (WS live / queue) │
                                                          │  result callback → advance (row lock)    │
                                                          │  sweeper: results persisted, not advanced│
                                                          └───────┬───────────────────────┬─────────┘
                                                                  │ events                │ wake (fail / overrun / verify-fail)
                                                          onboarding_run_events     AI supervisor run
                                                                  │                       │ action_intents → approvals
                                                          web timeline / board     repairs = allowlisted built-in scripts
```

Every step is a `device_commands` row, so the offline work queue's claim-time eligibility checks, delivery deadline, power-state barrier, and late-binding payload re-mint apply with no new plumbing.

## 5. Data model

Seven tables. Config tables are dual-owned (`org_id XOR partner_id`); per-device tables take the device's org. All `jsonb` columns are `excludedOpen` in the export policy. Every table is registered in `CORE_ORG_CASCADE_DELETE_ORDER`; the three per-device tables (runs, steps, events) also go in `CORE_DEVICE_CASCADE_DELETE_TABLES` and `CORE_DEVICE_ORG_DENORMALIZED_TABLES`. Composite FKs that include `org_id` are `DEFERRABLE INITIALLY IMMEDIATE` (org-merge contract).

### 5.1 `onboarding_plans` (org XOR partner)

| column | notes |
|---|---|
| id, org_id, partner_id | `onboarding_plans_one_owner_chk` |
| name, description | |
| platform | `windows` \| `macos` |
| enabled | |
| priority | integer; higher wins within an owner |
| site_ids | `uuid[]` nullable; null = all sites |
| supervisor_agent_id | FK `ai_agents` nullable; null = org/partner default supervisor |
| supervisor_settings | jsonb: pre-approved repair ids, budgets (overrides) |
| published_revision_id | FK `onboarding_plan_revisions` nullable |
| created_by, created_at, updated_at, disabled_at | |

RLS: one dual-axis `FOR ALL` policy plus the separate SELECT-only partner-wide read branch (`org_id IS NULL AND partner_id = breeze_current_partner_id()`), per the current playbook. Register in `DUAL_AXIS_TENANT_TABLES`.

### 5.2 `onboarding_plan_revisions` (same owner as plan)

| column | notes |
|---|---|
| id, plan_id, org_id, partner_id | owner columns copied from plan; composite FK `(plan_id, org_id, partner_id)` |
| revision | integer, unique per plan |
| protocol_version | integer; step-contract version |
| steps | jsonb, immutable (validated by `onboardingStepsSchema`) |
| content_hash | sha256 of canonical steps JSON |
| published_by, published_at | |

Revisions are append-only (REVOKE UPDATE/DELETE + immutability trigger; add to `AUDIT_ADMIN_REQUIRED_TABLES`). Editing a plan writes a new revision and moves `published_revision_id`. Runs pin a revision.

### 5.3 `onboarding_pre_registrations` (org)

| column | notes |
|---|---|
| id, org_id | shape 1 |
| serial_number | nullable, normalised upper-case |
| enrollment_key_id | nullable FK |
| CHECK | at least one of serial_number / enrollment_key_id |
| plan_id | nullable override; must be visible to the org (own or partner-wide) |
| site_id | nullable |
| primary_contact_id | nullable FK `contacts` (same org, composite FK) |
| package_id | nullable FK `onboarding_packages` |
| expires_at | |
| max_uses, consumed_count | serial rows default `max_uses = 1` |
| claimed_device_id | set on single-use claim |
| created_by, created_at | |

Unique partial index on `(org_id, serial_number) WHERE serial_number IS NOT NULL AND claimed_device_id IS NULL`.

### 5.4 `onboarding_packages` (org)

| column | notes |
|---|---|
| id, org_id, site_id | |
| plan_id | nullable override |
| bootstrap_token_id | FK `installer_bootstrap_tokens` (new `purpose = 'provisioning_package'`, long expiry, use cap) |
| entra_bulk_token_enc | encrypted via `encryptedColumnRegistry`; `excludedSensitive` |
| entra_bulk_token_expires_at | Microsoft: 180 days from issue |
| build_method | `native` \| `managed_device` \| `manual_kit` \| `intune_kit` |
| builder_device_id | nullable FK devices (managed_device builds) |
| status | `building` \| `ready` \| `failed` \| `revoked` |
| storage_key, size_bytes, sha256 | |
| agent_version | MSI version embedded |
| built_at, revoked_at, created_by | |

Revoking a package revokes its bootstrap token. The bulk token is never copied into manifests, events, prompts, or logs.

### 5.5 `onboarding_runs` (device org)

| column | notes |
|---|---|
| id, org_id, device_id | composite FK `(device_id, org_id) → devices(id, org_id)` |
| plan_revision_id | pinned |
| pre_registration_id, package_id | nullable provenance |
| entry_source | `package` \| `autopilot` \| `intune` \| `manual` \| `unknown` — set at admission from the enrollment key purpose and the admission probe |
| manifest | jsonb, immutable compiled steps (resolved software versions/methods/digests/detection rules, resolved script ids + content hashes, resolved contact) |
| manifest_hash | |
| primary_contact_id | nullable |
| phase | `system` \| `user` \| `final` |
| status | `pending` \| `running` \| `waiting_device` \| `waiting_user` \| `paused` \| `escalated` \| `completed` \| `incomplete` \| `failed` \| `cancelled` |
| current_step_id | step id within manifest |
| requested_control, control_generation, acked_generation | pause/cancel/resume with monotonic generations |
| version | optimistic-lock counter, bumped on every advance |
| supervisor_wakes, supervisor_cost_cents, supervisor_repairs | aggregates (per-run budget accounting) |
| sign_in_deadline_at | user phase |
| predecessor_run_id | re-onboarding link |
| started_at, completed_at, created_at, updated_at | |

Partial unique index: one row per device where `status IN ('pending','running','waiting_device','waiting_user','paused','escalated')`.

### 5.6 `onboarding_run_steps` (device org, projection)

| column | notes |
|---|---|
| id, run_id, org_id, device_id | |
| step_id, ordinal, kind, phase, required | copied from manifest for query convenience |
| status | `pending` \| `dispatched` \| `running` \| `verifying` \| `succeeded` \| `failed` \| `skipped` \| `cancelled` |
| attempt | current attempt number |
| device_command_id | current attempt's command |
| software_deployment_id, script_execution_id | when applicable |
| started_at, finished_at, verified_at | |
| last_error | text, redacted |

Unique `(run_id, step_id)`.

### 5.7 `onboarding_run_events` (device org, append-only)

| column | notes |
|---|---|
| id, run_id, org_id, device_id | |
| seq | monotonic per run |
| step_id, attempt | nullable |
| kind | e.g. `admitted`, `step_dispatched`, `step_result`, `step_verified`, `step_failed`, `step_overrun`, `probe`, `control_requested`, `control_applied`, `supervisor_wake`, `supervisor_proposal`, `repair_dispatched`, `escalated`, `run_completed` |
| actor | `runner` \| `agent` \| `ai` \| `user` \| `system` |
| actor_user_id, ai_agent_run_id, action_intent_id, device_command_id | references |
| payload | jsonb, bounded and redacted |
| occurred_at, received_at | |
| replay_key | unique `(run_id, replay_key)`; derived from `(step_id, attempt, kind, source id)` |

Append-only (REVOKE UPDATE/DELETE, immutability trigger, `AUDIT_ADMIN_REQUIRED_TABLES`).

### 5.8 Changes to existing tables

| table | change | export-policy bucket |
|---|---|---|
| `installer_bootstrap_tokens` | `purpose` varchar, default `'installer'`, new value `'provisioning_package'` | included |
| `devices` | `onboarding_run_id` uuid nullable (exclusion marker, §8.6; cleared on terminal run status) | included |
| `contacts` | `onboarding_principal` varchar nullable (explicit UPN override for user-phase matching, §8.4) | included |

### 5.9 Step contract (shared package)

`packages/shared/src/validators/onboardingSteps.ts` — this is the interface the catalog spec must honour.

```ts
type OnboardingStep = {
  id: string;                       // stable within a plan
  kind: 'wait_condition' | 'rename' | 'remove_bloat' | 'install_software'
      | 'config_task' | 'apply_policy' | 'run_script' | 'reboot' | 'notify';
  phase: 'system' | 'user';
  platforms?: ('windows' | 'macos')[];   // default: plan platform
  required: boolean;                     // skipping a required step ⇒ run can only end `incomplete`
  params: StepParams[kind];
  verify?: VerifySpec;                   // default per kind (see §8.3)
  expectedDurationSec: number;           // overrun ⇒ supervisor wake (once per step)
  timeoutSec: number;                    // ⇒ step failed
  retries: number;                       // runner-owned retries before onFailure applies
  onFailure: 'continue' | 'halt' | 'escalate';
};
```

`install_software.params` = `{ catalogId, versionIntent: { mode: 'latest' } | { mode: 'exact', version }, installMethodKind?: 'winget' | 'homebrew_cask' | 'homebrew_formula' | 'artifact' }`. Compile resolves this to `{ softwareVersionId | installMethodId, resolvedVersion, digest?, detectionRules }` in the manifest. `config_task.params` = `{ taskId, args }` over built-in task definitions (registry value, file present, power plan, printer, service state). `run_script.params` = `{ scriptId, args, runAs: 'system' | 'user' }`. `wait_condition.params` = `{ condition: 'network' | 'time_synced' | 'entra_joined' | 'autopilot_esp_complete' | 'windows_update_quiet' | 'bitlocker_escrowed' | 'no_pending_reboot', pollSec, deadlineSec }`.

## 6. Admission and plan selection

1. `routes/agents/enrollment.ts` publishes `device.enrolled` (declared in `eventBus.ts`, currently never emitted). Independently of the event, **admission runs inside the enrollment transaction**: after the device row is written, `admitOnboarding(tx, device, enrollmentKey)` selects a plan and inserts an `onboarding_runs` row in `pending`. The run row is the outbox; a `onboardingRunStarter` BullMQ job (and the tick, as backstop) starts pending runs. A crash after commit cannot lose an onboarding.
2. Selection order:
   1. Pre-registration matched by `enrollment_key_id`.
   2. Pre-registration matched by normalised serial number **only if** the authenticated enrollment landed in the pre-registration's org. Serial is evidence, not authentication.
   3. Org plan: enabled, platform match, site filter match, highest priority.
   4. Partner-wide plan for the device org's partner, same filters.
   5. No match ⇒ no run; the device shows "no onboarding plan" and a `device.enrolled` payload flag `onboarding: 'none'` for automations.
3. Claiming a pre-registration is atomic: `UPDATE ... SET consumed_count = consumed_count + 1, claimed_device_id = COALESCE(claimed_device_id, $device) WHERE id = $id AND consumed_count < max_uses AND expires_at > now() RETURNING *`. Zero rows ⇒ fall through to the next selector.
4. Compile: resolve every step against current catalog/scripts/contacts into the manifest. A dangling reference (deleted script, catalog version without a Windows artifact or method, contact in another org) fails compile; the run is inserted directly as `escalated` with the reason, so a bad plan fails at minute one, not step nine.
5. Device replacement via the enrollment-idempotency path reuses the device row and does **not** create a new run. Re-onboarding is an explicit device action creating a new run with `predecessor_run_id`.
6. Partner-wide plans fan out by the device org's partner (`organizations.partner_id`), never `eq(plans.orgId, device.orgId)` alone. One integration test proves the fan-out against real Postgres.

## 7. Provisioning package

### 7.1 Contents

A `.ppkg` is a Microsoft cabinet containing the Configuration Designer project XML (`customizations.xml`), the runtime provisioning XML Windows applies, and embedded files. Ours embeds:

- `breeze-agent.msi` (pinned `agent_version`) and `install.cmd`.
- **ProvisioningCommands**: `install.cmd` — waits for network up to a bounded time, runs `msiexec /i breeze-agent.msi /qn BREEZE_BOOTSTRAP_TOKEN=… BREEZE_SERVER_URL=…`, writes `%ProgramData%\Breeze\provisioning.log`, exits. Nothing else runs here because provisioning commands block OOBE synchronously.
- **Accounts/Azure/BPRT**: the Entra bulk token (join happens in the provisioning engine; there is no supported script path for a bulk-token join).
- OOBE flags: hide EULA/privacy pages where the tenant allows; do not set local accounts.

Enrollment retries, heartbeat, and everything after are the agent's normal behaviour; the run starts server-side at admission.

### 7.2 Build paths (D9)

| path | who runs Microsoft's tool | when |
|---|---|---|
| `native` | nobody — server writes the cabinet + XML directly | default **if** the spike passes |
| `managed_device` | a Breeze-managed Windows device the MSP designates, via a `build_provisioning_package` device command: ensure the ADK Configuration Designer component, run `icd.exe /Build-ProvisioningPackage`, upload the result to Breeze storage | fallback, and always available |
| `manual_kit` | the tech, on any Windows PC, from a downloaded kit (XML + MSI + script) | zero-dependency fallback |

**Spike (wave 3, first task, 2 days, gated):** hand-build one package with MSI + command + BPRT, apply at OOBE in a Windows VM, assert enrollment + Entra join + that the ESP does not fight the run. Pass ⇒ implement the native generator plus a Windows CI job that applies a generated package every release. Fail ⇒ `managed_device` becomes the default and the generator is dropped. The package record does not care which path produced the file.

### 7.3 Tokens and lifecycle

- Bootstrap token: `installer_bootstrap_tokens` row with new `purpose = 'provisioning_package'`, expiry default 1 year, use cap = batch size or org default. Revoking the package revokes the token.
- Entra bulk token: pasted by the MSP (Microsoft's WCD "bulk enrollment" flow mints it), stored encrypted, expiry recorded. UI warns at 30 and 7 days; **Rebuild** mints a fresh bootstrap token, accepts a new bulk token, marks the old package `revoked`.
- If a machine never enrols, the only visible trace is an unclaimed pre-registration past its expected date; that view is part of v1.

### 7.4 Intune app kit

For orgs that use Autopilot, the agent arrives through Intune instead of our package. The Packages tab offers an **Intune app kit** per org: the agent MSI wrapped for Intune (`.intunewin`), an install command carrying the org's bootstrap token and server URL, an uninstall command, and a detection rule (service present + registry version). It shares the `onboarding_packages` row shape with `build_method = 'intune_kit'` and the same bootstrap-token lifecycle, warnings, rebuild, and revoke. Publishing the app into the customer's Intune tenant through the existing Microsoft 365 connection (Graph `mobileApps` Win32LobApp) is a post-v1 wave.

### 7.5 Autopilot entry path

Autopilot and the provisioning package are alternative OOBE flows that both perform the Entra join, so they are never combined on one device.

| | Package path | Autopilot path |
|---|---|---|
| Join + MDM | our package (BPRT) | Autopilot profile → Entra join → Intune enrollment |
| Agent install | package ProvisioningCommands | Intune required Win32 app (§7.4) during the Enrollment Status Page |
| Run starts | at enrollment (admission) | at enrollment (admission) — identical |
| `entry_source` | `package` | `autopilot` |

Rules:

- **Builder warning.** The package builder states that Autopilot-registered devices must use the Intune kit. Whether a join-less package can be applied on an Autopilot device without side effects is a spike question (§7.2); until verified, it is unsupported.
- **ESP coexistence.** The agent enrols while the Enrollment Status Page may still be installing required apps. A reboot or a competing `msiexec` from our run mid-ESP breaks provisioning (ESP failure page, or `1618 another installation in progress`). Therefore: (a) the admission probe detects Autopilot (`HKLM\SOFTWARE\Microsoft\Provisioning\AutopilotSettings` / `CloudAssignedTenantId`, `HKLM\SOFTWARE\Microsoft\Windows\Autopilot\EnrollmentStatusTracking`); (b) compile **auto-prepends** `wait_condition: autopilot_esp_complete` (ESP device-phase done: `EnrollmentStatusTracking\Device\...\HasProvisioningCompleted` and `Enrollments\<id>\FirstSync\IsSyncDone`) with a generous deadline; (c) `reboot` and `install_software` steps are held while ESP is incomplete even if a plan author omitted the wait. The exact keys are confirmed in the wave 2 VM test, not assumed.
- **User phase.** Autopilot user-driven mode already knows the signing-in user; our UPN match works unchanged. The Autopilot-assigned user (registry `CloudAssignedOobeConfig` / enrollment UPN) is read by the probe as a hint when no contact was pre-assigned.
- **Pre-provisioning (white glove).** The technician phase maps to our `system` phase and the user's OOBE to our `user` phase. A run that reaches `waiting_user` while the device is sealed and shipped simply resumes at first sign-in. No special handling.
- **Hybrid Entra join via Autopilot** is out of scope with on-prem domain join (D5).

Post-v1 candidates: publish the Intune app via Graph; harvest hardware hashes from managed devices and register them for Autopilot via Graph (`importedWindowsAutopilotDeviceIdentities`) so existing fleets can be re-provisioned zero-touch.

## 8. Runner

### 8.1 Advancement

- Authority = status columns on `onboarding_runs` / `onboarding_run_steps`; audit = `onboarding_run_events`. Not full event sourcing.
- Every transition: `SELECT … FOR UPDATE` on the run row → check `version`, expected `(step_id, attempt)`, `requested_control` → write event(s) + projections + reserve next dispatch (`onboarding_run_steps.device_command_id` or a dispatch-outbox row) → commit → **dispatch after commit**. A failed post-commit dispatch is retried by the sweeper.
- Results are bound to `device_command_id`. A result for a superseded attempt (late result after timeout, duplicate callback, BullMQ retry) is logged as an event and never advances the run. Uniqueness: `replay_key` on events; `(run_id, step_id, attempt)` on dispatch.
- **Sweeper** (`onboardingSweeper`, every 60 s): device commands in a terminal state whose run step is still `dispatched`/`running` ⇒ replay the advance; runs in `pending` older than 2 min ⇒ start; reserved dispatches never sent ⇒ resend.
- **Tick** (`onboardingTick`, every 60 s, per active run): overrun detection, timeouts, sign-in and reboot deadlines, offline ⇔ `waiting_device` transitions from heartbeat `lastSeenAt`.

### 8.2 Step kind → primitive

| kind | primitive | completion | verification default |
|---|---|---|---|
| install_software | `services/softwareDeployment.ts` single-device deployment, `origin = 'onboarding'`, `onboarding_run_step_id` set; hidden from the deployments list | `deployment_results` terminal | version's `detectionRules` (agent-evaluated) |
| run_script | `dispatchScriptToDevice` with admission; `runAs` per step | `script_executions` terminal | exit code 0, or `verify.scriptId` |
| config_task / remove_bloat / probe | built-in signed scripts shipped with the API (`services/onboarding/builtinTasks/*.ps1`) using a `-Mode Test\|Set\|Verify` convention | script result | same script `-Mode Verify` |
| apply_policy | create/confirm `config_policy_assignments`; wait for heartbeat config-version ack | ack observed | effective-config version ≥ target |
| wait_condition | probe polled at `pollSec` until `deadlineSec` | condition true | condition true |
| reboot | existing reboot command | **boot evidence**: heartbeat `uptime` lower than seconds since dispatch **and** agent reconnected; reconnect alone is not proof | probe: no pending reboot |
| rename | built-in task (`Rename-Computer`) + reboot flag | script result; effective after next reboot | hostname matches pattern |
| notify | existing notification/integration channels | send acknowledged | — |

### 8.3 Verification

Independent of exit codes, per step, plus a **final pass** that re-runs every required step's verify before `completed`. A failed final verify is a supervisor wake signal; if unresolved ⇒ `incomplete`.

### 8.4 Phases

- `system`: starts at admission; steps run as SYSTEM.
- `user`: entered when all required system steps verify. The run is `waiting_user` until the assigned contact's session appears. Matching: session UPN equals contact email (case-insensitive) or an explicit `contact.onboarding_principal` override. **Agent changes (small, Windows):** the sessions collector reports `upn` and `sid` alongside `username`, and pushes a sessions update on logon instead of waiting for the 5-minute refresh. The API sessions schema accepts the two new fields. User-phase steps dispatch with `runAs: 'user'` targeting that session; the helper re-validates the identity at execution time. Missing the `sign_in_deadline_at` (default 7 days) ⇒ `escalated`.
- `final`: verification pass, notify steps, `completed`.

### 8.5 Controls

| control | effect |
|---|---|
| pause | finish the in-flight step; do not dispatch the next |
| resume | continue |
| cancel | cancel queued device commands (existing cancel path) and open action intents; an in-flight command may finish but its result does not advance; status `cancelled` |
| retry step | new attempt |
| skip step | optional ⇒ `skipped`; required ⇒ `skipped` and the run can only end `incomplete` |
| re-onboard | new run with `predecessor_run_id` |

Controls carry `control_generation`; the runner acks the generation it applied.

### 8.6 Exclusion

An active run sets `devices.onboarding_run_id`. The patch scheduler, third-party update rings, and automation actions that can reboot check it the same way they check suppression windows and defer. Power-state ordering within the run itself is the offline queue's barrier.

## 9. AI supervisor

- New built-in `ai_agents.kind = 'onboarding_supervisor'`, dual-owned like every agent, modes `off | shadow | act`, tool allowlist, `action_intents` approvals. `mode: off` ⇒ human alerts only.
- **Wake signals**: `step_failed` (after runner retries), `step_overrun` (once per step), `final_verify_failed`. Not: offline, waiting for sign-in.
- **One bounded AI run per wake**, `triggerKind = 'onboarding'`, `dedupeKey = run:step:attempt:signal`. Wakes are recorded as events referencing `ai_agent_run_id`; aggregates on the run.
- **Context**: redacted manifest, timeline so far, failed step's bounded output, latest probe output labelled *untrusted device evidence*, device facts, earlier wakes' conclusions, attempts remaining. Never: the Entra token, credentials, other devices.
- **Tool profile** (`onboarding` profile in `aiAgentSdkTools.ts`, deliberately small):
  - read: `onboarding.probe`, `onboarding.run_diagnostic` (allowlisted read-only scripts), inventory, event-log tail;
  - controls: `onboarding.retry_step`, `onboarding.skip_optional_step`, `onboarding.pause`, `onboarding.escalate(summary)`;
  - repairs: `onboarding.repair(id)` over a fixed allowlist of built-in scripts with preconditions — wait-for-network-then-retry, reset Windows Update components, re-run Entra join, fix time skew, flush DNS, reboot to clear pending restart, re-install via alternate method. Repairs are mutations ⇒ action intents. Shadow: propose only; probes allowed, mutation scripts never. Act: `supervisor_settings.preApprovedRepairs` auto-approve; everything else `supervised`; protected resources `four_eyes`.
  - It **cannot** complete a run, skip a required step, or act outside its device.
- **Budgets** (plan/org overrideable): per-run cost ceiling, max wakes per run, max repairs per step (default 2), cooldown between wakes. Reserved against the run's aggregate, not per execution. Exhaustion ⇒ `escalated` with timeline, evidence, attempted repairs, recommendation; alert to the org.
- **Handoff back**: a tech acts from the run page; the runner resumes normal sequencing.

## 10. UI and API

- **Plans** (policy area): create-only owner selector + "All orgs" badge; ordered step editor; publish with revision diff.
- **Pre-registrations**: tab on plan and org; single add; CSV import (serial, site, contact, plan); states unclaimed / claimed → run / expired.
- **Packages**: tab on org; build inputs; status; both token expiries with 30/7-day warnings; download, rebuild, revoke; build method and builder device.
- **Onboarding board**: partner-wide list of active/recent runs: org, device, phase, step, elapsed, state; filters for escalated and waiting.
- **Run timeline**: device page tab via hash; steps left, events right (probe evidence, AI wakes/proposals, approvals); controls.
- **Device list**: onboarding-state facet; chip on rows with an active run.
- **API** (`routes/onboarding/*.ts`, resource per file): plans + revisions, pre-registrations, packages, runs + controls, run events. Partner API: read-only runs. All web mutations through `runAction`.

## 11. Security and tenancy

- Plans/revisions: dual-axis RLS + SELECT-only partner-wide read branch; writes gated on `canManagePartnerWidePolicies`; `ownerScope` create-only.
- Runs/steps/events: device org; composite FK to `devices(id, org_id)`; policies via `breeze_has_org_access(org_id)`.
- Pre-registrations/packages: org shape 1. Bulk token encrypted and registered for rotation; never leaves the server except inside the package artifact.
- Probes and repairs are built-in **signed** scripts admitted through the existing script admission path; their output is bounded, redacted, and treated as untrusted evidence.
- Supervisor: minimal tool profile; no cross-device tools; all mutations through action intents; shadow mode cannot execute mutation scripts.
- Package artifacts in object storage under the org prefix; download requires org access; presigned URLs short-lived.
- `device_commands` remains system-scoped; onboarding dispatch goes through the existing dispatch helpers, never raw inserts.

## 12. Failure handling

| failure | owner | outcome |
|---|---|---|
| step fails after runner retries | step `onFailure` | continue / halt (`incomplete` at end) / escalate (supervisor wake) |
| device offline | tick | `waiting_device`; queue delivery deadline governs stale commands |
| no sign-in by deadline | tick | `escalated` |
| reboot with no boot evidence by timeout | tick | step failed ⇒ onFailure |
| supervisor budget exhausted | supervisor | `escalated` with dossier |
| compile error at admission | admission | run created `escalated` with reason |
| package token expired/revoked | — | device never enrols; unclaimed pre-registration view is the signal |
| API crash between result persist and advance | sweeper | replayed within 60 s |
| Autopilot ESP still running | runner hold (§7.5) | reboots/installs held; `autopilot_esp_complete` deadline ⇒ escalate |
| duplicate/late result | advance guard | logged, ignored |
| cancel during in-flight command | cancel | command may finish; result ignored |

## 13. Testing

- **Runner unit tests**: every transition; duplicate results; late results after timeout; concurrent callbacks on one step; control generations; required-skip ⇒ incomplete.
- **Integration (real Postgres)**: admission inside the enrollment transaction; one-active-run index under concurrency; pre-registration claim race; sweeper replay; partner-wide plan fan-out to a member-org device.
- **Tenancy contract suites**: the seven tables in `rls-coverage` allowlists; `onboardingPlansPartnerRls.integration.test.ts` (cross-partner forge 42501, XOR 23514, org isolation, fan-out); cascade and export-policy registration; deferrable composite FKs (merge contract).
- **Supervisor with a fake model**: wake dedupe; budget exhaustion; shadow never mutates; required step never skippable; tool profile is exactly the allowlist.
- **Agent (Go)**: sessions collector reports UPN/SID; logon-triggered push; identity re-validation in `runAs: user` execution.
- **Windows CI**: apply a generated package at OOBE in a VM; assert enrollment + join. Permanent form of the spike. A second scenario runs the Intune kit's install command on a VM with simulated ESP registry state and asserts the run holds until `autopilot_esp_complete`.
- **Playwright**: plan editor, board, timeline, package tab — `data-testid` only.

## 14. Rollout (waves; feature flag `ONBOARDING_RUNS_ENABLED` until wave 6)

1. Schema + migrations (seven tables, deferrable FKs, RLS, cascade/export registration), step contract in shared, plan/revision CRUD, admission + `device.enrolled` publish, compile.
2. Runner: advancement, sweeper, tick, system-phase step kinds, built-in tasks + probe, exclusion, reboot evidence, Autopilot detection + `autopilot_esp_complete` hold (VM-verified registry keys).
3. Package: spike (gate) → native generator or managed-device build; bootstrap-token purpose; Intune app kit + builder warning; pre-registrations; package + pre-registration UI.
4. User phase: agent sessions UPN/SID + logon push; API schema; identity re-validation; deadlines.
5. Supervisor: agent kind, tool profile, repairs allowlist, budgets, escalation, alerts.
6. Board, timeline, device facets, partner-API reads, docs, flag removal.

Post-v1 candidates: OOBE remote console (verify-and-fix), end-user self-identification, macOS runner, offline domain join, Intune app publish via Graph, Autopilot hash harvesting, agent-local runner if partners hit offline/latency cases.

## 15. Open questions

1. **Package spike outcome** decides native vs managed-device default (§7.2). Time-boxed to two days inside wave 3.
2. **Contact principal binding**: is email-equals-UPN sufficient for v1, or do we need an explicit Entra object id on contacts? Default: email match with per-contact override; revisit when the Entra contact-linking work lands.
3. **Deployments list hygiene**: hiding onboarding-origin deployments from the main list vs showing them with an "onboarding" badge. Default: hidden, visible from the run.
4. **Supervisor budget defaults**: cost ceiling and wake caps need real numbers once the tool profile is built; start conservative and make them plan-overrideable.

## Appendix A. Codex advisor quorum (2026-09-07)

Two passes at `xhigh`. Pass 1 (before D8's network assumption) preferred an agent-local runner for offline continuation; the disagreement was resolved by the owner dropping offline continuation as a requirement. Pass 2 on the server model agreed and contributed: results can persist without advancing (⇒ sweeper, §8.1); reconnect is not reboot proof (⇒ boot evidence, §8.2); heartbeat session data lacks identity and refreshes every 5 minutes (⇒ agent changes, §8.4); AI runs are finite so a single supervising-run FK is wrong (⇒ wake history, §9); status columns as authority with append-only events rather than full event sourcing (§8.1); immutable revisions and pinned manifests (§5); packages as thin bootstraps with revocation (§7.3); probes as untrusted evidence and shadow mode never authorising mutations (§9, §11).
