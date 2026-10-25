---
tracking_issue: LanternOps/breeze#6754
wave: W03 (#6757)
spec: docs/superpowers/specs/ai-mcp/2026-09-23-ai-full-control-design.md
depends_on: W02 (#6756, PR #9767) and W19 (#10065, PR #10087) merged to main
branch: feature/6754-ai-full-control/wave-6757
---
# AI full control W03: backup, DR and virtualization writes — class review and plan

**Goal:** wire the 19 backup, DR and Hyper-V write tools into chat and headless agents, so each one is tiered, declared and classified. Fix every classification gap found in the per-action review **before** the tool is exposed (spec D2).

**Verified against** `origin/main` `30d2519965` (2026-10-25: W02 #9767 and W19 #10087 both merged). Evidence comes from:
- reading the code;
- a `vitest` probe over the real registry (registry `input_schema` keys vs Zod keys, `action` enums, `deviceArgs`, domain);
- three parallel read-only handler/route audits.

Paths are under `apps/api/src/`, and line numbers drift, so re-grep before editing.

**House style:** the W01 and W02 plans (`2026-09-23-ai-full-control-w0{1,2}-*.md`). W03 builds on these pieces from those waves:
- `inputShape()`;
- `TIER1_READ_ACTIONS` and the tier-1 write-action contract;
- `AGENT_HUMAN_ONLY_ACTIONS`;
- `isInputAwareTier3` / `TIER3_INPUT_AWARE_ACTIONS` / `TIER_DECIDING_INPUT_KEYS`;
- the `W02_EXPECTED` row style;
- the W02-D6 MCP-loss heading.

## Starting state (measured, `30d2519965`)

- **Tiering and declaration:** all 19 tools are registered, and none is in `TOOL_TIERS` or `HUMAN_ONLY_TOOLS`. `KNOWN_MISSING_TOOL_TIERS` holds 38: these 19 plus W04's 19.
- **Schemas:** every tool has a `toolInputSchemas` entry. 18 are plain `z.object`s with registry keys == Zod keys and registry `action` enum == Zod enum. The exception is **`restore_as_vm`**: a `z.preprocess` over a `z.discriminatedUnion('engine', …)` (a ZodPipe), so `inputShape()` cannot read it. It also has drift, covered in W03-D4.
- **Chat index:** since W19 (#10087) the chat prompt ships the always-on domain index, which W03 does not change. A domain's tool list renders only on a device/alert page, and backup is neither, so per-domain block B2 and worst-page-turn B3 are the gates. The whole-index ceiling is retired, so the brief's "+128 B" policy is **obsolete** (orchestrator amendment, 2026-10-25). W03 removes its 19 names from `FIXTURE_W03_W04` in `aiToolIndex.test.ts`.
- **Device-path fields (#8852):** every W03 path field is already classified `exempt` with a reason in `aiToolPathFields.ts` `PATH_FIELDS`:
  - `restore_snapshot.targetPath`
  - `restore_snapshot.selectedPaths`
  - `restore_as_vm.outputPath`
  - `configure_vault.vaultPath`
  - `manage_backup_profiles.selections.file.paths`

  **No path-policy work is left.**
- **Route bindings:** five rows already exist for the restores, `instant_boot_vm`, `execute_dr_plan`, the five `manage_dr_plan` actions and `configure_vault:create`. The other W03 write actions have none (T3).

## Per-tool class review (spec "Class review rule")

Column meanings follow the W02 plan:
- **Q1** reversible within a minute?
- **Q2** leaves the tenant or reaches a person, including "touches a customer machine"?
- **Q3** blast radius.
- **Q4** can an agent grant itself authority?
- **Today** is the class the tool resolves to on main, reachable over MCP only (chat cannot call any of these).
- "t2" means the user approves unless `auto_approve`. "sup" and "4e" are the tier-3 scopes. "t1-read" means `TIER1_READ_ACTIONS`.

**Common facts (all 19):**
- **MFA.** Every REST twin carries `requireMfa()`; the tool handlers do not. Tier 3 in chat goes through the approval card (fresh second factor at release). A tier-2 tool over MCP has no MFA step: the W02-D11 follow-up class, recorded here and not fixed.
- **Integrity.** Restore-class handlers call `restoreIntegrityRefusalForActor(…, actor: 'ai_agent')` and refuse unattested snapshots outright. The REST routes allow a human step-up `confirmUnattestedRestore`. **The tool is stricter.**
- **Restore authorization.** `authorizeAiRestore` (`aiToolsRestoreAuthorization.ts:76-120`) is the same `authorizeResilienceResources(operation:'restore')` helper the routes use. It enforces target device in caller org == snapshot org, plus `backup:cross_site_restore` for cross-site restores.
- **Snapshot loading.** `loadSnapshotWithSiteAccess` (`aiToolsBackupShared.ts:53-100`) gates the snapshot's source device site and fails closed if that device is unknown.
- **Personal data.** No W03 tool returns file, mail or database content. Outputs are ids, status and names.
- **Agents.** No W03 key is in `POLICY_DECIDABLE_TIER3`, so for a headless agent every sup/4e call is a **proposal** a human approves, and t2 writes need the agent's allowlist (spec D4).

### Triggers (all touch a customer machine or a vendor; none overwrites live data)

| Tool | Q1 | Q2 (cite) | Q3 | Q4 | Today | **W03** | Scope parity tool / route | RBAC tool / route |
|---|---|---|---|---|---|---|---|---|
| `trigger_backup` | n/a (non-destructive; a job runs) | **device:** `backup_jobs` row + `enqueueBackupDispatch` (`aiToolsBackup.ts:593-620`) | one device | no | sup | **sup** (unchanged) | org `orgWhere`, site `deviceSiteDenied` (`:555-571`) = `jobs.ts:225` `canAccessDeviceSite`. Tool takes `configId` (same org enforced, `:576-577`); route resolves by policy | devices:execute = (`jobs.ts:195-199`) |
| `trigger_hyperv_backup` | n/a | **device:** `HYPERV_BACKUP` (`aiToolsHyperv.ts:362-376`) | one VM | no | sup | **sup** (unchanged) | `loadVmWithAccess` (org + host `deviceIdSiteDenied`, `:60-83`) = `hyperv.ts:304-310` resilience `'verify'` | devices:execute = |
| `trigger_mssql_backup` | n/a | **device:** `MSSQL_BACKUP` with write credential (`aiToolsMssql.ts:334-362`) | one DB | no | sup | **sup** (unchanged) | `orgWhere` + `deviceSiteDenied` (`:301-317`) = `mssql.ts:298-316` | devices:execute = |
| `trigger_vault_sync` | n/a | **device:** `VAULT_SYNC` copies a snapshot to the vault path (`aiToolsVault.ts`, sync handler) | one device | no | **t2** (no class) | **sup**, registry 2 → **3** + `TIER3_SUPERVISED_TOOLS` | vault `orgWhere` + `deviceIdSiteDenied(vault.deviceId)` = `vault.ts:318-360` | devices:execute = |
| `trigger_c2c_sync` | n/a | **vendor (by intent):** a SaaS backup pull. **Today the worker fails it `c2c_sync_not_implemented`** (`c2cQueuedAuthorization.ts:264-297`), so nothing leaves | one org's config | no | **t2** (no class) | **sup**, registry 2 → **3** + `TIER3_SUPERVISED_TOOLS` | config `orgWhere` = `c2c/jobs.ts:63-80` | organizations:write = |
| `verify_mssql_backup` | n/a | **device:** `MSSQL_VERIFY` stages the artifact on the device and runs `RESTORE VERIFYONLY` (`aiToolsMssql.ts:610-632`) | one device | no | **t2** (no class) | **sup**, registry 2 → **3** + `TIER3_SUPERVISED_TOOLS` | snapshot `orgWhere` + `deviceIdSiteDenied(snapshot.deviceId)` (`:571-589`) = `mssql.ts:664-681` | devices:execute + backup:read = |

The `trigger_c2c_sync` stub is classed for what it will do, not for today's no-op. Unlike W02's `notification_channels:test` (QV5), it is a different act from a lookup: an implementation that lands later would make it a vendor call silently. Supervised now means no reclassification is needed then.

### Restores and DR execution (overwrite or replace live state)

| Tool | Q1 | Q2 (cite) | Q3 | Q4 | Today | **W03** | Scope parity | RBAC |
|---|---|---|---|---|---|---|---|---|
| `restore_snapshot` | **no** (overwrites files) | **device:** `restore_jobs` row + `BACKUP_RESTORE` (`aiToolsBackup.ts:733-780`) | one device | no | 4e | **4e** (unchanged) | target `deviceSiteDenied` + source `loadSnapshotWithSiteAccess` + `authorizeAiRestore` = `restore.ts:203-219` | devices:execute + backup:read = |
| `restore_as_vm` | partly (delete the VM or VHDX) | **device:** `VM_RESTORE_FROM_BACKUP` (hyperv engine) or `BARE_METAL_REBUILD` (rebuild engine) (`aiToolsBackupVm.ts:157-310`) | one host | no | 4e | **4e** (unchanged) | = `vmrestore.ts:131-146`; `deviceArgs` covers both host ids | = |
| `instant_boot_vm` | partly | **device:** `VM_INSTANT_BOOT` (`aiToolsBackupVm.ts:396-446`) | one host | no | 4e | **4e** (unchanged) | = `vmrestore.ts:387-403` | = |
| `restore_hyperv_vm` | no | **device:** `HYPERV_RESTORE`, and `generateNewId:false` can reuse the original VM id (`aiToolsHyperv.ts:434-499`) | one host | no | 4e | **4e** (unchanged) | = `hyperv.ts:511` | = |
| `restore_mssql_database` | **no** (RESTORE DATABASE over `targetDatabase`) | **device:** `MSSQL_RESTORE` (`aiToolsMssql.ts:497-520`) | one DB | no | 4e | **4e** (unchanged) | = `mssql.ts:515-535` | = |
| `restore_c2c_items` | no (when implemented) | **vendor (by intent).** **Today it fails `c2c_restore_not_implemented`** (`c2cQueuedAuthorization.ts:301-317`). Takes item ids and returns ids/status, never item content | one org | no | 4e | **4e** (unchanged) | items + target connection `orgWhere`, single config = `c2c/items.ts:71-160` | organizations:write = |
| `execute_dr_plan` (rehearsal / failover / failback) | **no** | **devices:** every group's restore command (`drExecutionService.ts` `DR_ALLOWED_COMMAND_TYPES`). **A `rehearsal` of a non-BMR group queues the same restore command as a failover; only a payload field differs** (`:1168`). Only BMR rehearsals are isolated (new identity, rebuild host) | a whole plan | no | 4e | **4e for all three** (unchanged; a rehearsal → sup move is rejected, W03-D3) | `loadPlanWithAccess` + `planStoredDevicesDenied` + service re-authorization per device; `backup:write` for BMR groups (`aiToolsDR.ts:480-534`); the route has no stored-device check, so the tool is **stricter** | devices:execute = |

### Multiplexers

**`manage_hyperv_vm`** (registry tier 3; whole tool sup backstop)

Every action queues `hyperv_vm_state` on the Hyper-V host (`aiToolsHyperv.ts:271-277`). Scope is `loadVmWithAccess` = `hyperv.ts:732-807`. RBAC is devices:execute =.

| Action | Q1 | Q2 | Q3 | Q4 | Today | **W03** |
|---|---|---|---|---|---|---|
| start, resume | yes | device | one VM | no | sup (backstop) | **sup**, enumerated in `TIER3_SUPERVISED_ACTIONS` |
| stop, pause, save | yes (start/resume) | device; a service interruption | one VM | no | sup (backstop) | **sup**, enumerated |
| force_stop | **no** (a hard power-off can corrupt guest data) | device | one VM | no | sup (backstop) | **sup**, enumerated. Irreversible but single-device and tenant-internal, so the class rule gives sup, not 4e |

**`manage_hyperv_checkpoints`** (registry tier 2)

Every action queues `HYPERV_CHECKPOINT` (`aiToolsHyperv.ts:551-562`). Scope is `loadVmWithAccess` = `hyperv.ts:651-657`. RBAC is devices:execute =.

| Action | Q1 | Q2 | Q3 | Q4 | Today | **W03** |
|---|---|---|---|---|---|---|
| create | yes, but undoing it means `delete`, which is 4e | **device:** a host command; disk use, may quiesce the VM | one VM | no | **t2** | **sup** (W03-D2: "touches a customer machine → supervised at minimum") |
| delete | no (the rollback point is gone; disks merge) | device | one VM | no | 4e | **4e** (unchanged) |
| apply | no (discards current state) | device | one VM | no | 4e | **4e** (unchanged) |

**`manage_dr_plan`** (registry tier 2)
- **Common facts:**
  - `dr_plans.org_id` and `dr_plan_groups.org_id` are both `NOT NULL`, with no partner column (`db/schema/drPlans.ts:23-48`). A plan is always single-org.
  - The tool is equal to or **stricter** than the routes: `proposedDevicesDenied`, `storedGroupDevicesDenied`, `rebuildHostDenied` and `dependsOnGroupDenied` (`aiToolsDR.ts:41-56, 637-791`).
  - `deviceArgs: ['devices']`.
  - RBAC is devices:write = (`requireDrWrite`).
  - Nothing runs on a device until `execute_dr_plan`, which is 4e.

| Action | Q1 | Q2 | Q3 | Q4 | Today | **W03** |
|---|---|---|---|---|---|---|
| create_plan | yes (archive) | none; a draft plan | one org | no | t2 | **t2** |
| update_plan (incl. `status`) | yes | none | one plan | no | t2 | **t2** |
| add_group, update_group | yes | none (a stored recovery recipe) | one plan | no | t2 | **t2** |
| delete_group | **no** (hard delete; recovery coverage silently shrinks) | none | one plan | no | sup | **sup** (unchanged) |

**`manage_backup_profiles`** (registry tier 1)
- **Common facts:**
  - The input key is `ownerScope: 'organization' | 'partner'`, honoured on **create only**. The handler test is `input.ownerScope === 'partner'` (`aiToolsPolicyPrereqs.ts:849`).
  - On update/delete, partner-wide-ness is DB state (`existing.orgId === null`, `:884-889, :917-924`), which guardrails cannot see.
  - `canManagePartnerWidePolicies` gates partner-wide create/update/delete in the handler (`:849, :886, :921`), the same gate as `routes/backup/profiles.ts:147-270`.
  - `delete` refuses while any policy references the profile (`:925-932`).
  - A profile holds selections only (files / system image / MSSQL / Hyper-V). Retention, schedule and destination live in the policy link.
  - Partner-owned policies link partner-wide profiles across every org, including orgs created later.
  - RBAC is backup:read / backup:write = (`aiGuardrails.ts` TOOL_PERMISSIONS block).

| Action | Q1 | Q2 | Q3 | Q4 | Today | **W03** |
|---|---|---|---|---|---|---|
| list, get | read | none (config, no personal data) | org + own partner | no | t1-read | **t1-read** (unchanged) |
| create, `ownerScope` absent or `'organization'` | yes (delete) | none; inert until a policy links it | one org | no | t2 | **t2** |
| create, `ownerScope: 'partner'` | yes | none | **partner-wide** | no | t2 | **sup (input-aware)** (spec concern row) |
| update | only if the old selection is known | none, but narrowing a linked partner-wide profile silently stops protecting data in every org | one org **or partner-wide (DB state)** | no | t2 | **sup** (static fail-safe, W03-D1; the W02 QV3 precedent) |
| delete | no | none | one org or partner-wide | no | t2 | **sup** (static fail-safe, W03-D1) |

**`configure_backup_sla`** (registry tier 2)
- `backup_sla_configs.org_id` is `NOT NULL`, with no partner column (`db/schema/sla.ts:14-34`). **Not partner-wide**, so there is no input-aware question.
- The handler applies `canMutateOrgWideGovernance` before both actions (`aiToolsSLABackup.ts:438-440`). The route does not check it, so the tool is **stricter**.
- The org comes from `resolveWritableToolOrgId`.
- RBAC is organizations:write = (`routes/backup/sla.ts:31-44, 101-122`).
- `deviceArgs: ['targetDevices']`.

| Action | Q1 | Q2 | Q3 | Q4 | Today | **W03** |
|---|---|---|---|---|---|---|
| create, update | yes | none (monitoring targets and breach alerts; no device command) | one org | no | t2 | **t2** (unchanged) |

**`configure_vault`** (registry tier 2)
- A vault is a per-device local copy of backups: path, type `local` / `smb` / `usb`, and `retentionCount` (`db/schema/localVault.ts:18-46`).
- **Both actions push a `vault_configure` command to the device** (`aiToolsVault.ts`, `pushDeviceVaultConfig`).
- Scope: `deviceSiteDenied` or `deviceIdSiteDenied`, the same as `routes/backup/vault.ts:176-270`. The route's update additionally row-locks the device against a concurrent site move (follow-up).
- RBAC is organizations:write = (pinned by `routeParity`).

| Action | Q1 | Q2 | Q3 | Q4 | Today | **W03** |
|---|---|---|---|---|---|---|
| create, update | yes (re-point) | **yes.** A device command. `vaultPath` may be an SMB share the model chose, so backup data is copied to a new destination on the next sync. A lower `retentionCount` may prune older local copies (agent pruning not verified) | one device | no | **t2** (no class) | **sup** (W03-D2), via `TIER3_ACTIONS` + `TIER3_SUPERVISED_ACTIONS`. The approval headline names the vault type, path and retention |

### Agent (headless) exposure, per tool (spec D4; W01 rule: the wave that wires a tool classifies it)

| Tool | Exposure |
|---|---|
| `manage_backup_profiles` | **reachable.** `list` and `get` skip the allowlist. The output is profile config: name, `description` and selection paths. It carries no personal data. The `description` is free text written by a staff member holding `backup:write`, so it is tenant-internal and not device-originated (QW7). The W01 per-read rule is satisfied. Writes go through the allowlist (t2) or a proposal (sup). |
| `manage_dr_plan`, `configure_backup_sla` | **reachable.** The t2 writes go through the agent's allowlist. `delete_group` is a proposal. |
| The other 16 | **reachable as proposals only.** sup and 4e keys are not in `POLICY_DECIDABLE_TIER3`, and 4e keys are never pre-authorisable. |
| Q4 (self-granted authority) | **No W03 tool.** DR plans, SLA configs, backup profiles and vaults do not feed agent run scope: `aiAgents/runResourceScope.ts` reads none of them. `AGENT_HUMAN_ONLY_ACTIONS` is unchanged. |

### Existing entries, and whether they change

| Map | Entry today | W03 |
|---|---|---|
| `TIER2_ACTIONS.manage_backup_profiles` | create, update, delete | keep `create` (its base class is t2; the input-aware arm escalates on top). **Remove `update` and `delete`.** |
| `TIER3_ACTIONS.manage_backup_profiles` / `TIER3_SUPERVISED_ACTIONS` | — | **+ `update`, `delete`** |
| `TIER3_INPUT_AWARE_ACTIONS` | 8 pairs | **+ `manage_backup_profiles:create`** |
| `TIER_DECIDING_INPUT_KEYS` | 6 tools | **+ `manage_backup_profiles: ['ownerScope']`** |
| `TIER3_ACTIONS.manage_hyperv_checkpoints` | delete, apply | **+ `create`** → `TIER3_SUPERVISED_ACTIONS` |
| `TIER3_ACTIONS.configure_vault` / `TIER3_SUPERVISED_ACTIONS` | — | **+ `create`, `update`** |
| `TIER3_SUPERVISED_ACTIONS.manage_hyperv_vm` | — (whole-tool backstop only) | **+ all six actions** (the backstop stays) |
| `TIER3_SUPERVISED_TOOLS` | trigger_backup, trigger_hyperv_backup, trigger_mssql_backup, manage_hyperv_vm | **+ `trigger_vault_sync`, `trigger_c2c_sync`, `verify_mssql_backup`** |
| Registry `tier` | vault sync 2, c2c sync 2, mssql verify 2 | **→ 3** (D1: registry and `TOOL_TIERS` move together) |
| `TIER3_FOUR_EYES_TOOLS` / `_ACTIONS` | restores, instant boot, `execute_dr_plan`; checkpoint delete/apply | unchanged |
| `TIER3_SUPERVISED_ACTIONS.manage_dr_plan` | delete_group | unchanged |
| `TOOL_PERMISSIONS` / extras | see the tables | unchanged unless T3's route bindings red |
| `TOOL_RATE_LIMITS` | every W03 tool except `manage_backup_profiles` | unchanged (W03-D7) |
| Four-eyes fallback moved to supervised | — | **none. No loosening in this wave.** Every W03 tier-3 tool already had an explicit class; none relied on the unclassified fail-safe. |

### Final per-action classes (T7's `W03_EXPECTED` copies this)

| Tool | t1 (read) | t2 | supervised | four-eyes |
|---|---|---|---|---|
| `trigger_backup`, `trigger_hyperv_backup`, `trigger_mssql_backup`, `trigger_vault_sync`, `trigger_c2c_sync`, `verify_mssql_backup` | — | — | whole tool | — |
| `restore_snapshot`, `restore_as_vm`, `restore_hyperv_vm`, `restore_mssql_database`, `restore_c2c_items`, `instant_boot_vm`, `execute_dr_plan` | — | — | — | whole tool |
| `manage_hyperv_vm` | — | — | start, stop, force_stop, pause, resume, save | — |
| `manage_hyperv_checkpoints` | — | — | create | delete, apply |
| `manage_dr_plan` | — | create_plan, update_plan, add_group, update_group | delete_group | — |
| `manage_backup_profiles` | list, get | create (organization) | create (`ownerScope: 'partner'`), update, delete | — |
| `configure_backup_sla` | — | create, update | — | — |
| `configure_vault` | — | — | create, update | — |

## Quorum (codex `exec`, read-only, xhigh, 2026-10-25)

**Codex's verdict: AGREE WITH CHANGES.** It agreed with:
- the trigger, restore, DR-execution, `manage_hyperv_vm` and checkpoint rows;
- W03-D2, D3, D4 and D7;
- the `ownerScope === 'partner'` arm, which mirrors `aiToolsPolicyPrereqs.ts:849`;
- "no W03 action changes the sites, tags or memberships agent run scope reads, so no `AGENT_HUMAN_ONLY_ACTIONS`".

Each requested change is resolved on the merits below.

- **QW1, `configure_backup_sla`. Codex: DISAGREE (supervise writes that can alert). Kept at t2; flagged for Todd.**
  - Codex is right on the mechanism: breach events carry the model-supplied config name and reach partner webhooks through the wildcard subscriber (`backupSlaWorker.ts:311`, `eventSubscribers.ts:117`).
  - But this is the W02 class exactly. W02 kept `manage_tickets:create` at t2 even though `ticket.created`, with a model-written title, reaches the same partner webhooks. The W02 plan records partner-configured webhooks as **tenant plumbing**, not "leaves the tenant".
  - Supervising SLA writes and not ticket creation would be incoherent.
  - **Todd decision.** Flipping it is one `TIER3_ACTIONS` + `TIER3_SUPERVISED_ACTIONS` entry.
- **QW2, `trigger_c2c_sync`. Codex: keep t2 with a no-outbound regression pin (W02 QV5). Kept at the stricter supervised; flagged for Todd.**
  - QV5 kept a stub at t2 because the act's intent was itself a lookup.
  - Here the intent is a vendor pull, and the implementation would land in the worker (`c2cQueuedAuthorization.ts`), not in the tool. So a tool-side pin would not catch it, and a worker-side pin would silently hand a vendor call to `auto_approve` the day it lands.
  - The cost of supervised today is the MCP loss of a no-op.
  - The brief's rule for a DECIDE row with dissent is to keep the conservative class and record the dissent.
- **QW3: a DR plan edit can change an approved execution. Accepted, fixed before exposure (new W03-D10).** Two holes, both reachable by a t2 (`auto_approve`) `manage_dr_plan` group write:
  - **Approval window.** The `execute_dr_plan` effect digest pins only `dr_plans.updated_at` and `status` (`actionIntents/effectDigest.ts:588-607`, a documented partial pin). A group-only edit does not bump the plan row.
  - **During a run.** A nonterminal execution re-reads the groups on every tick (`drExecutionService.ts:1478`) and dispatches their current config (`:1591`).
- **QW4: C2C restore destination-org parity. Accepted, fixed before exposure (new W03-D11).** The handler authorizes the target connection and the items independently, each by `orgWhere`. A multi-org caller can therefore pair org A's items with org B's connection, and the worker refuses only later.
- **QW5: vault update site race. Accepted, fixed before exposure (new W03-D12).** The REST `PATCH` row-locks the device inside the site allowlist (`updateVaultWithinCurrentSite`, `routes/backup/vault.ts:78-130`). The tool re-checks and then updates without a lock.
- **QW6: W03-D1's reversibility evidence was wrong. Accepted.** The approver sees only the new values, and the handler returned only the updated row. `update` now returns `previous` (name, description, selections, isActive), so the change can be undone from the transcript. D1 is rewritten below. The headline says ownership is resolved at run time, because input alone cannot show it.
- **QW7: profile reads carry technician free text. Accepted as a rationale correction.** The agent-exposure row now says it: `description` is free text written by a staff member with `backup:write`. Exposure stays reachable, because it is tenant-internal and not device-originated.
- **QW8: MCP wording. Accepted.** W03-D6 now says "denied by default". The MCP intent path (`MCP_APPROVAL_INTENTS`) and operator-authorized unattended principals (`MCP_UNATTENDED_TIER3_PRINCIPALS`) already exist (`routes/mcpServer.ts:2314-2339`).

## Decisions (W03-D1 … W03-D12)

- **W03-D1: `manage_backup_profiles` `update`/`delete` are statically supervised.**
  - Whether a profile is partner-wide is DB state, and guardrails are DB-free.
  - Narrowing a linked partner-wide profile stops protecting data in every org, with no signal. This is the W02 QV3 fail-safe (channel `delete`).
  - It is supervised, not four-eyes. `delete` refuses while any policy references the profile, so a successful delete never removes live protection (the classification is conservative for partner-wide ownership, not a QV3-style loss). `update` is reversible from the `previous` block the handler now returns (QW6).
  - `create` is input-aware on `ownerScope === 'partner'`, the handler's own expression.
- **W03-D2: device-touching config writes are supervised.**
  - `configure_vault` `create`/`update` push `vault_configure` to the device and can redirect backup copies to a model-chosen SMB path. That is the W02 notification-channel `create`/`update` class: data to a new destination, with the approver seeing the destination.
  - `manage_hyperv_checkpoints:create` queues a host command.
  - Both follow the rule "touches a customer machine → supervised at minimum". These are escalations from the brief's proposal (t2) and are recorded in W03-D6.
- **W03-D3: `execute_dr_plan` stays four-eyes for every `executionType`, including `rehearsal`.** For non-BMR groups a rehearsal queues the same restore command as a failover (`drExecutionService.ts:1168`), with no server-side isolation. Moving it to supervised would be a loosening, and there is no evidence that it is safe.
- **W03-D4: `restore_as_vm`'s ZodPipe gets a schema-module envelope, not a hand-written SDK shape.**
  - The SDK `tool()` needs a `ZodRawShape`, and its `z.object(shape)` strips keys that are not in the shape. So the SDK shape must be the union of both engine arms' keys plus every registry key.
  - `aiToolSchemasBackup.ts` exports the two arm objects and an `restoreAsVmSdkShape` envelope built from them (every key optional; `engine` an optional enum). `toolSdkInputShapes` in `aiToolSchemas.ts` maps `restore_as_vm` to it. `inputShape()` reads that map before falling back to `.shape`.
  - `validateToolInput` still validates the full pipe, so the strict rebuild arm and the required hyperv fields keep rejecting bad input.
  - **Drift fixed in the same task:** the hyperv arm gains `switchName`, which the registry advertises and the handler stores (`aiToolsBackupVm.ts:262`) but Zod did not list. `hypervisor` narrows to `['hyperv']`, matching the registry enum and the handler, which refuses anything else (`:264`).
- **W03-D5: no W03 tool returns content, and `search_c2c_items` stays `AGENT_DENIED_READ_TOOLS`.** `restore_c2c_items` takes item ids and returns `{restoreJobId, status, itemCount}`. An agent can therefore propose a restore only from ids it already holds, and it cannot read mailbox items through this wave.
- **W03-D6: MCP surface loss (Todd signs off in the PR).** Over MCP, tier 3 is denied **by default** (`MCP_APPROVAL_REQUIRED`, W02 r6). Two exceptions exist: deployments that enable `MCP_APPROVAL_INTENTS`, which turns the call into an approval intent, and principals listed in `MCP_UNATTENDED_TIER3_PRINCIPALS` (`routes/mcpServer.ts:2314-2339`). So, by default, these become MCP-denied until #6158:
  - `trigger_vault_sync`, `trigger_c2c_sync`, `verify_mssql_backup`: whole tool. `tools/list` stops advertising them (`isToolWhollyGatedOverMcp`).
  - `configure_vault`: `create` and `update`, which is every action.
  - `manage_hyperv_checkpoints:create`. `delete` and `apply` were already four-eyes.
  - `manage_backup_profiles`: `update`, `delete`, and `create` with `ownerScope: 'partner'`.

  Already MCP-denied before W03, and unchanged: every restore, `instant_boot_vm`, `execute_dr_plan`, the three backup triggers, `manage_hyperv_vm`, and `manage_dr_plan:delete_group`.
- **W03-D7: no new rate limits.** `manage_backup_profiles` has none, and its writes are now either an approval or an org-scoped inert object. Every device-touching W03 tool already has one.
- **W03-D8: approval headlines.** `buildApprovalDescription` gains cases for the restores (snapshot id, target device, selected-path count, never the path list), `execute_dr_plan` (plan id + `executionType`), the Hyper-V tools (action + VM id), `configure_vault` (vault type, path capped at 80 chars, retention), `manage_backup_profiles` (partner-wide flagged) and the triggers. `humanizeToolAction` is the fallback.
- **W03-D9: every W03 write action gets a `routeBinding` row** (T3). An RBAC binding is not scope parity: scope parity is the handler tables above, D10–D12, and the T12 suites. Tool-vs-route MFA is not mirrored; that is the W02-D11 follow-up.
- **W03-D10 (QW3): a DR plan cannot change under an approved or running execution.** In `aiToolsDR.ts`, `manage_dr_plan`:
  - refuses `update_plan`, `add_group`, `update_group` and `delete_group` while the plan has a `pending` or `running` `dr_executions` row;
  - bumps `dr_plans.updated_at` in the same transaction as every group write, so the existing `execute_dr_plan` effect digest fails a released intent closed after any group edit in the approval window.

  The tool becomes **stricter** than the REST group routes. Mirroring this on the routes is a follow-up.
- **W03-D11 (QW4): `restore_c2c_items` requires the target connection to be in the items' org.**
- **W03-D12 (QW5): `configure_vault:update` uses the route's locked update.** `updateVaultWithinCurrentSite` is exported from `routes/backup/vault.ts` with its parameter narrowed to `{ allowedSiteIds }`. A site-restricted caller's update then row-locks the device inside its allowlist, as the REST `PATCH` does.

## Budget (W19 bounds; the brief's whole-index policy is obsolete)

Measured at T5 and recorded in the PR:
- the always-on index (B1, < 2,560 B and unchanged by W03);
- the backup and integrations blocks (B2, < 2,048 B);
- the worst page turn (B3, < 7,040 B);
- the legacy whole-index render (`AI_TOOL_INDEX=full`, informational; no ceiling).

## Tasks

T1 (this doc + quorum) → T2 guardrail classes → T3 route bindings → T4 handler fixes (W03-D4) → T5 wiring + `FIXTURE_W03_W04` → T6 agent catalog → T7 `W03_EXPECTED` → T8 web `tierConfig.ts` → T9 docs → T10 prompt-size gate (D5) → T11 golden prompts g76–g78 → T12 integration suites → T13 merge main, gates, PR. Each task is red first, with one commit per task.

## Follow-ups (not filed)

- `restore_mssql_database` (and `restore_hyperv_vm`) AI paths create no `restore_jobs` row. The REST routes track them via `dispatchTrackedDbRestore` (#6974), so AI-initiated DB restores are missing from restore history.
- `configure_backup_sla` `targetDevices`/`targetGroups` are not checked for membership of the config's org on either path. The tool and the route are equal, and the central `deviceArgs` gate checks caller access only.
- The REST DR group routes neither refuse edits during a running execution nor bump `dr_plans.updated_at` (W03-D10 makes only the tool stricter). The `execute_dr_plan` digest should walk `dr_plan_groups` (effectDigest.ts's own note).
- `trigger_backup` accepts any same-org `configId`; the route resolves the policy config.
- Tier-2 W03 tools over MCP skip the routes' `requireMfa()` (W02-D11 class).
- `instant_boot_vm` `vmSpecs.diskSizeGb` minimum is 1 in Zod and 10 on the route.
