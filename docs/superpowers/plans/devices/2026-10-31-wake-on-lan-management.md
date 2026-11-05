---
tracking_issue: LanternOps/breeze#10838
waves: [W01, W02, W03, W04, W05, W06, W07, W08, W09]
status: approved, waves tracked on LanternOps/breeze#10838
---

# Wake-on-LAN Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a config policy turn WOL on and decide when the wake button shows, report per-device readiness, and record an outcome for every wake.

**Architecture:** Two new device tables record readiness and attempts. A new inline `wake_on_lan` policy feature is delivered by heartbeat. The agent reports a readiness snapshot, and in later waves applies settings through a fixed list of vendor settings. One resolver, `resolveWakeAvailability`, serves list, detail, mobile and `dispatchWake`. All write code ships inactive; W06 turns it on in one PR.

**Tech Stack:** Hono, Drizzle, hand-written SQL, BullMQ, Vitest; Go agent (WMI, PowerShell CIM, `pmset`); Astro + React; React Native.

**Spec:** `docs/superpowers/specs/devices/2026-10-31-wake-on-lan-management-spec.md`. Read it first; it holds the reasoning and the lab gate checklist (§9).

## Global Constraints

- With no WOL policy, the button is unchanged and the agent does nothing new.
- Breeze never reboots a machine, never stores a BIOS password, never accepts a BIOS setting name from the server.
- Firmware writes only when protection is positively confirmed absent. Unknown means no write.
- NIC writes never restart the adapter.
- Already-correct values are never rewritten. Firmware: at most 1 attempt per setting per 24 h, stop after 3 failures until the policy fingerprint changes.
- Windows, NIC and Mac settings follow the same limits on drift re-apply.
- Outcome window: 10 min from server send time; late-sweep grace: 2 min. Repeat clicks don't move the deadline.
- Block threshold: 3 consecutive `timed_out`. Proof lifetime: 90 days. Wired adapter memory: 30 days. MAC history: 30 days, cap 8. Attempt retention: 90 days.
- UI copy says "came online", never "woke".
- `configureSettings` stays `z.literal(false)` until W06.
- No vendor adapter ships before its vendor's machine has been captured and tested. Other makes report `unproven`.
- Migrations: read `apps/api/migrations/README.md`. Names below assume newest on main is `2027-01-18-130000`; re-check and rename before merge. Enum ADD VALUE gets its own file.
- New `org_id` tables: read `docs/agents/tenancy-rls.md`. Register in every list named in Task 1.
- New web strings go in all 8 locales. Mutations use `runAction`.
- API tests: `cd apps/api && npx vitest run <path>`, never `pnpm --filter <pkg> test -- --run`. Integration suites need `pnpm test-stack up`; tear down afterwards. Check `tsc` exit codes at 12 GB heap, never through `| tail`.
- Bare paths starting `routes/`, `services/`, `jobs/`, `db/`, `middleware/` or `__tests__/` are under `apps/api/src/`.
- PR bodies carry `Closes #<sub-issue>` once promoted. A branch stacked on another runs no CI: `gh workflow run CI --ref <branch>`.

## Review Focus

1. **Policy lookup fails on a device list page:** the button hides for those devices and a click errors. It must not fall back to "no policy", which allows wake. Test in Task 6.
2. **Double-click or bulk wake overlapping a single wake:** concurrent inserts hit the one-open-attempt index and join; neither request 500s. Test in Task 3.
3. **Device deleted or moved org while an attempt is open:** the sweep skips it and the batch continues. Test in Task 4.
4. **Malformed, oversized or future-dated snapshot from an agent:** rejected or clamped, using server `received_at` for freshness. Test in Task 9.
5. **Non-English Windows or OEM driver:** NIC properties match by `RegistryKeyword`, never localised display name, or every non-English machine reports wrong. Test in Task 8.

---

## W01: Wake outcomes

### Task 1: Tables and tenancy registration

**Files:**
- Create: `apps/api/migrations/2027-01-20-170000-device-wake-tracking.sql`, `apps/api/src/db/schema/deviceWake.ts`
- Modify: `apps/api/src/db/schema/index.ts`, `services/tenantCascade.ts`, `services/orgMergeRegistry.ts`, `services/tenantExportPolicyRegistry.ts`, `routes/devices/core.ts`, `routes/devices/moveOrg.coverage.test.ts`, `services/deviceOrgMove/moveDeviceOrgInTransaction.ts`, `__tests__/integration/rls-coverage.integration.test.ts` if an allowlist applies
- Test: `apps/api/src/__tests__/integration/deviceWakeTables.integration.test.ts`

**Interfaces:**
- Produces: Drizzle `deviceWakeStatus`, `deviceWakeAttempts`; types `WakeReadinessState`, `WakeAttemptOutcome`.

Mirror `device_time_status` and `device_restore_point_attempts`: shape 1 RLS with four `breeze_org_isolation_*` policies, enabled and forced, `GRANT` to `breeze_app`, composite `(device_id, org_id)` FK `DEFERRABLE INITIALLY IMMEDIATE`, `ON UPDATE CASCADE ON DELETE CASCADE`.

`device_wake_status`: `device_id` PK, `org_id` NOT NULL, `readiness_state` varchar(32) NULL, `reason_codes` text[] default `{}`, `vendor` varchar(32), `fingerprint` text, `collected_at`, `received_at`, `agent_version`, `last_apply_at`, `last_apply_result` varchar(32), `details` jsonb, `last_wired_adapter_seen_at`, `last_came_online_at`, `proof_fingerprint` text, `consecutive_timeouts` int NOT NULL default 0, `created_at`, `updated_at`. CHECK on `readiness_state`: `ready, needs_reboot, not_configured, apply_failed, firmware_protected, unproven, no_wired_adapter, unsupported_vm`. Server-derived states are never stored. All readiness columns land here so W02 needs no column migration. Spec §7's `blocked_fingerprint` is dropped: clearing a block just resets `consecutive_timeouts`.

`device_wake_attempts`: `id` uuid PK (the `wakeAttemptId`), `org_id`, `device_id`, `relay_device_id` uuid NULL `REFERENCES devices(id) ON DELETE SET NULL`, `relay_hostname` text, `device_command_id` uuid NULL, `requested_by` uuid NULL, `bulk_id` uuid NULL, `macs` text[], `broadcast` text, `outcome` varchar(16), `refusal_code` varchar(32), `boot_after_send` boolean NOT NULL default false, `send_count` int NOT NULL default 1, `requested_at`, `deadline_at` NULL, `resolved_at`. CHECK on `outcome`: `pending, sent, send_failed, came_online, timed_out, unknown, refused`. Indexes: partial unique on `(device_id)` `WHERE outcome IN ('pending','sent')`; partial on `(deadline_at)` same condition; `(device_id, requested_at DESC)`; `(org_id, requested_at DESC)`.

Registration: both in `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical), `orgMergeRegistry` (`repoint`), `CORE_TENANT_EXPORT_POLICY` (`details` is `excludedOpen`, everything else `included`), `CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES`. Status also in `DEVICE_ORG_FK_CASCADE_TABLES`; attempts also in `CORE_DEVICE_ORG_MOVE_DELETE_TABLES`. If `moveOrg.coverage.test.ts` demands otherwise, follow it and keep the outcomes: status moves, attempts are deleted.

- [ ] **Step 1: Write the failing integration test**

```ts
it('forged cross-org insert fails with 42501 as breeze_app')
it('a second open attempt for one device violates the partial unique index, 23505')
it('a closed attempt does not block a new open one')
it('relay delete sets relay_device_id NULL and keeps the attempt')
it('org move deletes attempts, keeps status, and clears last_came_online_at, proof_fingerprint, consecutive_timeouts')
```

- [ ] **Step 2: Run it and confirm it fails** because the tables don't exist.

Run: `pnpm test-stack up && cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceWakeTables.integration.test.ts`

- [ ] **Step 3: Write the migration, schema and registrations; add the clearing statement to the org move transaction.**

- [ ] **Step 4: Run the contract suites** and confirm they pass: the test above, `tenantCascade`, `orgMergeRegistry`, `tenant-export-policy`, `rls-coverage` integration tests, `routes/devices/cascadeDelete.test.ts`, `routes/devices/moveOrg.coverage.test.ts`, and `pnpm db:check-drift`.

- [ ] **Step 5: Commit** `feat(devices): add wake status and attempt tables`.

### Task 2: Target-online refusal and MAC targeting

**Files:**
- Modify: `apps/api/src/services/wakeOnLan.ts`
- Test: `apps/api/src/services/wakeOnLan.test.ts`

**Interfaces:**
- Produces: `WakeFailureCode` gains `'TARGET_ONLINE'`. `resolveTargetMacs(targetDeviceId, orgId): Promise<string[]>`.

- [ ] **Step 1: Write the failing tests**

```ts
it('returns TARGET_ONLINE and sends nothing when target status is online')
it('still sends for status offline and maintenance')
it('unions device_network with device_ip_history MACs seen within 30 days, newest first')
it('ignores history MACs older than 30 days')
it('caps at 8 MACs')
it('excludes a history MAC another device in the org reported more recently')
it('keeps a device_network MAC even if another device also reports it')
```

- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/wakeOnLan.test.ts`. Expected: FAIL on the new cases.

- [ ] **Step 3: Implement.** Add `status` to the target select and return `TARGET_ONLINE` immediately after the not-found check. Exclude a MAC when another device's newest sighting in `device_network` or `device_ip_history` is later than this device's.

- [ ] **Step 4: Run again.** Expected: PASS.

- [ ] **Step 5: Commit** `fix(devices): refuse wake on online targets and keep dock MACs targeted`.

### Task 3: Record attempts

**Files:**
- Create: `apps/api/src/services/wakeAttempts.ts`, `wakeAttempts.test.ts`
- Modify: `services/wakeOnLan.ts`, `services/commandResultHandlers.ts`, `__tests__/parkedFanoutModules.ts` (classify the new service file)
- Test: also `apps/api/src/__tests__/integration/wakeAttempts.integration.test.ts`

**Interfaces:**
- Consumes: `deviceWakeAttempts`.
- Produces:
  - `openOrJoinWakeAttempt(input: { deviceId, orgId, relayDeviceId, relayHostname, requestedBy, bulkId?, macs, broadcast }): Promise<{ attemptId: string; joined: boolean }>`
  - `recordWakeRefusal(input: { deviceId, orgId, requestedBy, bulkId?, code: WakeFailureCode }): Promise<void>`
  - `applyWakeRelayResult(attemptId: string, sent: boolean): Promise<void>`
  - Constant `WAKE_OUTCOME_WINDOW_MS = 600_000`.

- [ ] **Step 1: Write the failing tests**

```ts
it('new attempt is pending with deadline_at = now + 10 min')
it('a repeat click joins: same id, send_count 2, deadline unchanged')
it('two concurrent opens for one device both succeed with one row') // integration, Review Focus 2
it('NO_RELAY, NO_MACS, NO_SUBNET write a refused row with refusal_code and null relay')
it('TARGET_NOT_FOUND, TARGET_ONLINE and parked refusals write no row')
it('relay result true moves pending to sent; false moves it to send_failed')
it('a relay result on a terminal attempt changes nothing')
it('dispatchWake payload and response carry the joined attempt id')
```

- [ ] **Step 2: Run** the unit and integration files. Expected: FAIL, module not found.

- [ ] **Step 3: Implement.** Handle 23505 on insert by re-selecting and joining. Call from `dispatchWake` before command creation. Register `commandResultHandlers[CommandTypes.WAKE_ON_LAN]`, reading `wakeAttemptId` from `command.payload` and success from the result's status plus `packetsSent` (see `wake_on_lan.go`). Leave the audit row as is.

- [ ] **Step 4: Run again, including** `services/aiDispatch.contract.test.ts` and `parkedFanout.contract.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(devices): record a wake attempt for each dispatch`.

### Task 4: Resolve outcomes, and retention

**Files:**
- Create: `apps/api/src/jobs/wakeAttemptSweep.ts`, `wakeAttemptSweep.test.ts`, `jobs/wakeAttemptRetention.ts`, `wakeAttemptRetention.test.ts`
- Modify: `jobs/scheduleRegistry.ts` (`'wake-attempt-sweep': '* * * * *'`, plus a daily retention slot), `services/workerRegistry.ts`, `jobs/workerReadinessManifest.ts`
- Test: `apps/api/src/__tests__/integration/wakeAttemptSweep.integration.test.ts`

**Interfaces:**
- Consumes: `deviceWakeAttempts`, `deviceWakeStatus`, `devices.lastSeenAt`, `devices.uptimeSeconds`.
- Produces: `resolveOpenWakeAttempts(now: Date, batchSize?: number): Promise<{ resolved: number }>`; a pure `classifyWakeAttempt(a, device, now): WakeAttemptOutcome | null`.

`classifyWakeAttempt` rules, with `seen = lastSeenAt >= requestedAt` and `late = now > deadlineAt + 2 min`:

| Condition | Result |
|---|---|
| `seen`, not `late` | `came_online` |
| `seen`, `late` | `unknown` |
| not `seen`, before deadline | `null` (leave open) |
| not `seen`, past deadline, `sent` | `timed_out` |
| not `seen`, past deadline, `pending` | `send_failed` |

- [ ] **Step 1: Write the failing tests**

```ts
it.each(/* the table above */)('classifies %s')
it('boot_after_send is true only when lastSeenAt - uptimeSeconds >= requestedAt')
it('came_online sets last_came_online_at, proof_fingerprint = current fingerprint, consecutive_timeouts 0')
it('timed_out increments consecutive_timeouts; send_failed, unknown and refused do not')
it('creates the status row when a device has none')
it('runs twice with the same result') // idempotent, CAS on open outcome
it('an attempt whose device was deleted or moved mid-window does not abort the batch') // Review Focus 3
it('retention prunes closed attempts older than 90 days and leaves open ones')
```

- [ ] **Step 2: Run** the three files. Expected: FAIL.

- [ ] **Step 3: Implement.** Follow `restorePointAttemptRetention.ts` for queue setup, `init` and `shutdown`. Use `withSystemDbAccessContext`. Finalise each attempt and its status row in one transaction, and catch per attempt. Retention uses `pruneInCtidBatches` with `WAKE_ATTEMPT_RETENTION_DAYS`, default 90, max 365.

- [ ] **Step 4: Run again.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(devices): resolve wake outcomes with a one-minute sweep`.

### Task 5: Show refusals in the UI

**Files:**
- Modify: `apps/web/src/components/devices/DevicesPage.tsx` (both `case 'wake'` sites), `apps/web/src/services/deviceActions.ts`, `DeviceDetailScreen.tsx` (mobile), locale `devices.json` ×8
- Test: `apps/web/src/services/__tests__/deviceActions.test.ts`, `DeviceList.test.tsx`

**Interfaces:**
- Consumes: bulk wake's existing `{ succeeded, failed: [{ deviceId, code, message }] }`.

- [ ] **Step 1: Write the failing tests**

```ts
it('bulk wake reports "Sent to N, skipped M" with skips grouped by code')
it('single wake on TARGET_ONLINE shows the server message')
```

- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/services/__tests__/deviceActions.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement,** and on mobile also hide Wake unless `device.status` is not online.

- [ ] **Step 4: Run again,** including `localeParity` and `no-silent-mutations`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(web): report skipped devices on bulk wake`.

---

## W02: Policy, read-only readiness, button gating

**Blocking prerequisite:** capture settings output from the lab Dell (Task 8, Step 1). Confirm it's 2019 or newer.

### Task 6: Feature type and availability resolver

**Files:**
- Create: `apps/api/migrations/2027-01-19-110000-wake-on-lan-feature-type.sql`, `packages/shared/src/validators/wakeOnLanInlineSettings.ts` + test, `apps/api/src/services/wakeAvailability.ts` + test
- Modify: every registration point for `system_protection`: `db/schema/configurationPolicies.ts`, `packages/shared/src/constants/configFeatureTypes.ts`, `validators/index.ts`, `routes/configurationPolicies/featureLinks.ts`, `services/configurationPolicy.ts`, `services/featureConfigResolver.ts`, `services/policyBaselineDefaults.ts`, `aiToolsConfigPolicy.ts`, `aiToolsConfigPolicyExamples.ts`, `featureTabs/types.ts`, `DeviceEffectiveConfigTab.tsx`, `ConfigPolicyDetailPage.tsx`, locale `policies.json` ×8
- Test: `services/wakeAvailability.test.ts`, `__tests__/integration/wakeAvailabilityParity.integration.test.ts`

**Interfaces:**
- Produces:
  - `wakeOnLanInlineSettingsSchema` → `{ configureSettings: false, buttonMode: 'verified' | 'always' }`, `.strict()`. `WAKE_ON_LAN_PLATFORM_DEFAULT`.
  - `resolveWakeOnLanSettingsForDevices(deviceIds): Promise<Map<string, WakeOnLanInlineSettings | null>>` in `featureConfigResolver.ts`, generalised from `resolveSecurityAgentsLinkChunk`, chunk 500.
  - `decideWakeAvailability(input: { settings, status, device, now }): WakeAvailability` (pure).
  - `resolveWakeAvailability(deviceIds): Promise<Map<string, WakeAvailability>>`.
  - `WakeAvailability = { show: boolean; mode: 'none' | 'verified' | 'always' | 'unknown'; state: WakeEffectiveState; testWakeAllowed: boolean; flaggedTimeouts: boolean }`.
  - `WakeEffectiveState` = stored states plus `unsupported_os`, `agent_update_required`, `no_data`, `lookup_failed`.
  - Constant `MIN_WAKE_STATUS_AGENT_VERSION`, set to the release that carries Task 8.

- [ ] **Step 1: Write the failing tests**

```ts
// validator
it('rejects configureSettings true') // until W06
it('rejects unknown keys')
// decideWakeAvailability, one row each
it('no policy: show, mode none, regardless of status')
it('always: show, even at 5 timeouts, with flaggedTimeouts true')
it('verified + ready: show')
it('verified + ready + 3 timeouts: hide')
it('verified + unproven + came online 89 days ago + matching fingerprint: show')
it('verified + unproven + came online 91 days ago: hide, testWakeAllowed true')
it('verified + unproven + fingerprint differs from proof_fingerprint: hide')
it.each(['needs_reboot','not_configured','apply_failed','firmware_protected','no_wired_adapter','unsupported_vm'])('verified + %s: hide')
it('verified + linux or darwin: state unsupported_os')
it('verified + no status + old agent: agent_update_required; new agent: no_data')
// resolver
it('policy lookup throws: every id maps to show false, mode unknown, state lookup_failed') // Review Focus 1
it('batch matches the per-device resolver across device, group, site, org and partner assignments, role and OS filters, and parked devices') // integration parity
it('page of 1000 devices runs a fixed statement count')
```

- [ ] **Step 2: Run** the test files. Expected: FAIL.

- [ ] **Step 3: Implement.** The enum file adds the value and nothing else. `NOT_ENFORCED`: "Wake button shows on every offline device; Breeze doesn't check or change WOL settings." The chunk resolver must match the per-device ordering, per `resolvePatchPolicyWinnersForDevices`.

- [ ] **Step 4: Run** the above plus `configFeatureTypes.test.ts`, `featureTypeParity.test.ts`, `policyBaselineDefaults.test.ts`, `DeviceEffectiveConfigTab.featureParity.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(policy): add wake_on_lan feature and availability resolver`.

### Task 7: Heartbeat delivery and server gate

**Files:**
- Modify: `routes/agents/helpers.ts`, `routes/agents/heartbeat.ts`, `services/devicePolicySet.ts`, `services/wakeOnLan.ts`, `routes/devices/commands.ts`, `routes/mobile.ts`, `agent/internal/heartbeat/heartbeat.go`
- Test: `routes/agents/heartbeat.test.ts`, `__tests__/integration/agentHotPathQueryBudget.integration.test.ts`, `services/wakeOnLan.test.ts`, `agent/internal/heartbeat/wake_config_test.go`

**Interfaces:**
- Consumes: `resolveWakeAvailability`.
- Produces:
  - `buildWakeOnLanConfigUpdate(deviceId, opts?): Promise<{ enabled: boolean; configureSettings: boolean; firmwareWrites: string[] }>`; on the wire `configUpdate.wake_on_lan_settings = { enabled, configure_settings, firmware_writes }`. A resolver error omits the block, meaning no change.
  - `WakeFailureCode` gains `'WAKE_NOT_READY'` and `'WAKE_LOOKUP_FAILED'`. `DispatchWakeOptions` gains `testWake?: boolean`.
  - Go: `(h *Heartbeat) applyWakeOnLanSettings(raw any)`.

- [ ] **Step 1: Write the failing tests**

```ts
it('heartbeat delivers enabled false with no policy, enabled true with one')
it('configure_settings is false and firmware_writes empty in W02')
it('heartbeat stays within the budget with a wake_on_lan link seeded')
it('dispatchWake returns WAKE_NOT_READY under verified when not ready, and records a refusal')
it('dispatchWake returns WAKE_LOOKUP_FAILED when availability lookup fails')
it('testWake bypasses WAKE_NOT_READY only for state unproven')
it('no policy and always still dispatch')
```

```go
func TestApplyWakeSettingsIgnoresUnknownFields(t *testing.T) // a setting name in the payload has no effect
func TestApplyWakeSettingsAbsentBlockMeansNoChange(t *testing.T)
```

- [ ] **Step 2: Run** the API tests and `cd agent && go test -race ./internal/heartbeat/ -run Wake`. Expected: FAIL.

- [ ] **Step 3: Implement.** Add `wake_on_lan` to `POLICY_SET_FEATURE_TYPES`. Agent handling sits above the policy-probe early return, next to `workload_inventory_settings`, and queues for a worker so the heartbeat never blocks. Update the budget's seeded links.

- [ ] **Step 4: Run again.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(policy): deliver wake_on_lan settings and enforce availability on dispatch`.

### Task 8: Agent readiness, Dell read adapter

**Files:**
- Create: `agent/internal/biosconfig/` (`adapter.go`, `dell_windows.go`, `other.go`, tests, `testdata/`), `agent/internal/wakeconfig/` (`targets.go`, `readiness.go`, `state.go`, `collect_windows.go`, `collect_other.go`, `manager.go`, tests), `agent/internal/heartbeat/wake_config.go`
- Modify: `agent/internal/heartbeat/heartbeat.go`

**Interfaces:**
- Produces:

```go
package biosconfig
type Setting struct { Name, Value string; Allowed []string }
type Protection int // ProtectionNone, ProtectionSet, ProtectionUnknown
type Adapter interface {
    Vendor() string
    Read(ctx context.Context) ([]Setting, error)
    Protection(ctx context.Context) (Protection, error)
    Apply(ctx context.Context, name, value string) error // ships in W04
}
func Detect(manufacturer, model string) Adapter // nil when unsupported

package wakeconfig
func Compute(in Inputs) Snapshot // pure
type Snapshot struct { /* JSON fields per Task 9 */ }
```

`targets.go` holds the compile-time list, starting with Dell: `WakeOnLan=LanOnly`, `DeepSleepCtrl=Disabled`. `biosconfig` contains no WOL logic. Read over `root\dcim\sysman\biosattributes`.

Windows checks: Fast Startup via `HiberbootEnabled`; magic packet per wired adapter through `Get-NetAdapterPowerManagement`; EEE through `Get-NetAdapterAdvancedProperty -RegistryKeyword '*EEE'`; Realtek shutdown wake by keyword. Exclude Wi-Fi and virtual adapters using `Get-NetAdapter`'s `NdisPhysicalMedium` and `Virtual` fields.

- [ ] **Step 1: Capture real output (manual, blocking).** On the lab Dell, as SYSTEM, save the `EnumerationAttribute` list and password-state class output to `testdata/dell-<model>-*.json` with service tag and hostnames scrubbed. Confirm names and values against `targets.go`. Record the model in the PR.

- [ ] **Step 2: Write the failing tests**

```go
func TestDellReadParsesCapture(t *testing.T)
func TestUnrecognisedSettingNameIsUnproven(t *testing.T)
func TestTargetValueNotInAllowedListIsUnproven(t *testing.T)
func TestDetectNilForOtherMakesIsUnproven(t *testing.T)
func TestComputeReady(t *testing.T)
func TestComputeNotConfiguredWithReasonPerLayer(t *testing.T)
func TestComputeVirtualMachineWins(t *testing.T) // including Microsoft Hyper-V
func TestUndockedKeepsAdapterAndStateFor30Days(t *testing.T)
func TestDockChangeDoesNotChangeFingerprint(t *testing.T)
func TestNoWiredAdapterAfter30Days(t *testing.T)
func TestNicMatchesByRegistryKeywordNotDisplayName(t *testing.T) // German capture, Review Focus 5
func TestDisabledPolicyStopsCollection(t *testing.T)
func TestCollectsOnChangeBootAnd24h(t *testing.T)
```

- [ ] **Step 3: Run** `cd agent && go test -race ./internal/biosconfig/ ./internal/wakeconfig/`. Expected: FAIL.

- [ ] **Step 4: Implement** behind a fake command and WMI layer. State persists under `config.GetDataDir()`. Upload via `sendInventoryData("wake-status", ...)` when the fingerprint changes or every 24 h. `collect_other.go` reports nothing in W02. Cross-compile for all three OSes.

- [ ] **Step 5: Run again** with `GOOS=windows go vet ./internal/...` and `GOOS=darwin go vet ./internal/...`. Expected: PASS.

- [ ] **Step 6: Commit** `feat(agent): collect WOL readiness with a Dell read adapter`.

### Task 9: Snapshot ingest

**Files:**
- Create: `packages/shared/src/validators/wakeStatus.ts` + test, `apps/api/src/routes/agents/wakeStatus.ts` + `.mounted.test.ts`, `apps/api/src/services/wakeStatusIngest.ts` + test
- Modify: `routes/agents/index.ts`, `middleware/bodyLimit.ts`, `routes/agents/parkedRouteClassification.test.ts`, `agent/tools/agentsim/sim/budget_contract_test.go`, `__tests__/parkedFanoutModules.ts`

**Interfaces:**
- Consumes: Go `Snapshot`, which must match this JSON.
- Produces: `wakeStatusSnapshotSchema`, `.strict()`: `{ readinessState, reasonCodes: string[] (max 16, each max 64), vendor: string | null (max 32), fingerprint: string (max 128), collectedAt, lastApplyAt: string | null, lastApplyResult: string | null, lastWiredAdapterSeenAt: string | null, details: record, bounded by the route's body limit }`. `ingestWakeStatusSnapshot(input): Promise<{ accepted: boolean }>`.

- [ ] **Step 1: Write the failing tests**

```ts
it('upserts by device, taking device and org from agent auth, never the body')
it('agent id mismatch returns 403')
it('a changed fingerprint resets consecutive_timeouts to 0')
it('an unchanged fingerprint keeps consecutive_timeouts')
it('rejects unknown state, extra keys, too many reason codes, and oversized bodies') // Review Focus 4
it('stores server received_at; a future collectedAt is stored but never drives freshness') // Review Focus 4
```

- [ ] **Step 2: Run** the files. Expected: FAIL.

- [ ] **Step 3: Implement,** following `routes/agents/timeStatus.ts`.

- [ ] **Step 4: Run again** with `cd agent && go test ./tools/agentsim/...`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(api): ingest WOL readiness snapshots`.

### Task 10: Gate the button on every surface

**Files:**
- Modify: `routes/devices/core.ts` (list batch, mapper, detail), `DeviceActions.tsx`, `DeviceList.tsx`, `DevicesPage.tsx`, mobile `DeviceDetailScreen.tsx` and its device type
- Test: `routes/devices/core.list-response-shape.test.ts`, `DeviceActions.test.tsx`, `DeviceList.test.tsx`

**Interfaces:**
- Consumes: `resolveWakeAvailability`.
- Produces: `wakeAvailability: WakeAvailability` on list rows and detail.

- [ ] **Step 1: Write the failing tests**

```ts
it('list rows carry wakeAvailability, using one batched lookup per page')
it('detail carries wakeAvailability')
it('device with show false: no wake in the action bar, overflow menu or row menu')
it('offline device with no policy still shows wake')
it('bulk action sends only eligible devices and reports the skipped count')
it('no WOL prompt or warning anywhere on the device page')
```

- [ ] **Step 2: Run** the files. Expected: FAIL.

- [ ] **Step 3: Implement.** Gate as `wakeAvailability?.show !== false`, combined with the existing checks.

- [ ] **Step 4: Run again,** and measure a 1000-row list locally; record the added latency in the PR. Expected: PASS.

- [ ] **Step 5: Commit** `feat(devices): show wake only where the policy allows it`.

### Task 11: Policy tab and status panel

**Files:**
- Create: `apps/api/src/routes/configurationPolicies/wakeStatus.ts` + test, `featureTabs/WakeOnLanTab.tsx` + test, `featureTabs/WakeStatusPanel.tsx` + test
- Modify: `ConfigPolicyDetailPage.tsx`, `routes/configurationPolicies/index.ts` (or the mount file), locale `policies.json` ×8

**Interfaces:**
- Produces:
  - `GET /configuration-policies/:id/wake-status?page&limit&state`: paginated rows `{ deviceId, hostname, state, reasonCodes, vendor, model, lastAttempt: { outcome, refusalCode, at } | null, consecutiveTimeouts, testWakeAllowed }`, plus `counts` by state.
  - `POST /configuration-policies/:id/wake-status/:deviceId/allow`: resets `consecutive_timeouts`, audited, requires `devices.execute`.
  - `POST /configuration-policies/:id/wake-status/:deviceId/test-wake`: `dispatchWake(..., { testWake: true })`, requires `devices.execute` + MFA.

- [ ] **Step 1: Write the failing tests**

```ts
it('lists only devices whose effective WOL policy is this one')
it('an org-scoped token never sees another org under a partner-wide policy') // RLS on real Postgres
it('rejects a device not governed by this policy on allow and test-wake')
it('counts stay bounded on a partner-wide policy over a large fleet')
it('allow writes an audit row and clears the block')
it('tab: button mode defaults to always, no configure toggle is rendered')
it('panel: shows "came online", never "woke"; test wake appears only when testWakeAllowed')
it('panel: laptops show the AC-only advisory from device form factor; Modern Standby varies wording; repeated timeouts are flagged under always')
it('mutations go through runAction')
```

- [ ] **Step 2: Run** the files. Expected: FAIL.

- [ ] **Step 3: Implement.** Resolve over the policy's assignment scope, one page at a time, using the batch resolver. Use a capped or background count if needed; state which in the PR. Copy from `SystemProtectionTab.tsx`. The PR states settings rule 9: home = config policy WOL tab, level = policy assignment hierarchy, resolver = `resolveWakeAvailability`, places configured 0 before and 1 after.

- [ ] **Step 4: Run again,** with `localeParity` and `no-silent-mutations`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(policy): add WOL policy tab and device status panel`.

---

## W03: Windows and NIC writes (inactive)

### Task 12: Apply Windows and NIC settings

**Files:**
- Create: `agent/internal/wakeconfig/apply_windows.go`, `apply_other.go`, `apply_test.go`, `limits.go`
- Modify: `manager.go`, `readiness.go`

**Interfaces:**
- Consumes: delivered `configure_settings`.
- Produces: `Apply(ctx, in ApplyInputs) ApplyReport`, `Limiter` persisted in the data dir. Exposed to Task 13 and Task 15.

Order: Fast Startup (`HiberbootEnabled = 0`), magic packet, EEE off, Realtek shutdown wake. NIC cmdlets always pass `-NoRestart`. Read back each. A value stored but not yet in effect reports `needs_reboot` until a boot later than the write.

- [ ] **Step 1: Write the failing tests**

```go
func TestNoWriteWhenConfigureFalse(t *testing.T)
func TestNoWriteWhenAlreadyCorrect(t *testing.T)
func TestEveryNicWriteHasNoRestart(t *testing.T)
func TestReadbackMismatchIsApplyFailed(t *testing.T)
func TestNeedsRebootClearsOnlyAfterLaterBoot(t *testing.T)
func TestPendingStateSurvivesAgentRestart(t *testing.T)
func TestLimiterOnePer24hStopsAfterThree(t *testing.T)
func TestPolicyFingerprintChangeResetsLimiter(t *testing.T)
func TestDriftTriggersReapplyWithinLimits(t *testing.T)
func TestPolicyRemovedStopsAndRevertsNothing(t *testing.T)
```

- [ ] **Step 2: Run** `cd agent && go test -race ./internal/wakeconfig/`. Expected: FAIL.

- [ ] **Step 3: Implement.** `onedrivehelper_windows.go` is the write-then-read pattern; exec from System32 per `timesync/writer_windows.go`.

- [ ] **Step 4: Run again.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(agent): apply WOL Windows and NIC settings`.

---

## W04: Dell firmware writes (inactive)

### Task 13: BitLocker guard and Dell apply

**Files:**
- Create: `agent/internal/wakeconfig/bitlocker_windows.go`, `bitlocker_other.go`, `bitlocker_test.go`
- Modify: `biosconfig/dell_windows.go`, `wakeconfig/apply_windows.go`, `targets.go`

**Interfaces:**
- Consumes: `Adapter`, `Limiter`, delivered `firmware_writes`.
- Produces: `firmwareWriteAllowed(ctx) (bool, reason string)`, `Adapter.Apply` for Dell (`SetAttribute`, `SecType 0`).

Firmware write needs all of: `configure_settings` true, vendor in `firmware_writes`, `Protection == ProtectionNone`, BitLocker check passes, value wrong, limiter allows. Never suspend BitLocker.

- [ ] **Step 1: Write the failing tests**

```go
func TestFirmwareSkippedUnlessVendorSwitchOn(t *testing.T)
func TestProtectionSetIsFirmwareProtectedNoApplyCall(t *testing.T)
func TestProtectionUnknownIsFirmwareProtectedNoApplyCall(t *testing.T)
func TestBitLockerPcr1BlocksWrite(t *testing.T)
func TestBitLockerProfileUnreadableBlocksWrite(t *testing.T)
func TestBitLockerDefaultProfileAllowsWrite(t *testing.T)
func TestBitLockerOffAllowsWrite(t *testing.T)
func TestDellReturnCodesMapToApplyFailed(t *testing.T) // 1-6
func TestOnlyTargetListNamesReachApply(t *testing.T)
func TestAfterWriteStateIsNeedsReboot(t *testing.T)
```

- [ ] **Step 2: Run** `cd agent && go test -race ./internal/wakeconfig/ ./internal/biosconfig/`. Expected: FAIL.

- [ ] **Step 3: Implement,** with the Windows-side changes running first, firmware last.

- [ ] **Step 4: Run again.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(agent): apply Dell WOL firmware settings behind guards`.

---

## W05: Mac

### Task 14: Mac readiness and setting

**Files:**
- Create: `agent/internal/wakeconfig/collect_darwin.go`, `apply_darwin.go`, `darwin_test.go`
- Modify: `collect_other.go` and `apply_other.go` build tags, `services/wakeAvailability.ts` + test, `MIN_WAKE_STATUS_AGENT_VERSION` handling for Mac

**Interfaces:**
- Consumes: `Snapshot`, `Limiter`.
- Produces: Mac snapshots, always `unproven` when `womp` is on, `not_configured` when off; `vendor: "apple"`.

- [ ] **Step 1: Write the failing tests**

```go
func TestParsesWompFromPmsetG(t *testing.T)
func TestWompOnIsUnprovenNeverReady(t *testing.T)
func TestAppliesPmsetAWomp1OnlyWhenConfigureTrueAndOff(t *testing.T)
func TestReadbackMismatchIsApplyFailed(t *testing.T)
```

```ts
it('verified + darwin + unproven + recent proof: show')
it('verified + linux: still unsupported_os')
```

- [ ] **Step 2: Run** the Go and API tests. Expected: FAIL.

- [ ] **Step 3: Implement,** following `pmset` handling in `collectors/battery.go`.

- [ ] **Step 4: Run again,** with `GOOS=darwin go vet ./internal/...`. Expected: PASS.

- [ ] **Step 5: Lab: on an Apple Silicon Mac and an Intel Mac, wake from sleep through a relay; try from shutdown. Record results in the PR.** If Apple Silicon doesn't wake reliably, delete `apply_darwin.go`'s write and ship read-only. Never run a lab agent on a host with the installed agent.

- [ ] **Step 6: Commit** `feat(agent): report and set Mac wake for network access`.

---

## W06: Activation (Dell, OliveTech first)

### Task 15: Turn it on

All of this lands in one PR, so nothing can write before its gates exist.

**Files:**
- Create: `routes/configurationPolicies/wakeConfigureGate.ts` + test
- Modify: `wakeOnLanInlineSettings.ts`, `featureLinks.ts`, `crud.ts`, `services/configurationPolicy.ts`, `services/aiGuardrails.ts`, `routes/agents/helpers.ts`, `WakeOnLanTab.tsx`, locale `policies.json` ×8, `apps/docs`, `docs/release-notes/next-release-draft.md` (append under its own heading)
- Test: `featureLinks.test.ts`, `aiGuardrails.approvalScope.contract.test.ts`, `routes/agents/heartbeat.test.ts`, `WakeOnLanTab.test.tsx`

**Interfaces:**
- Consumes: `hpCmslGate.ts` as the exact pattern, including assignment and parent-link inheritance (`policyEffectivelyEnablesHpCmslCollection`, `parentPolicyEnablesHpCmslCollection`).
- Produces: `checkWakeConfigureWriteAllowed(auth, perms)`, `policyEffectivelyEnablesWakeConfigure(policyId)`, env `WOL_FIRMWARE_WRITE_VENDORS` (comma list, default empty), `wakeOnLanInlineSettingsSchema.configureSettings: z.boolean()`.

- [ ] **Step 1: Write the failing tests**

```ts
it('enabling configureSettings needs devices.execute and satisfied MFA')
it('assigning a policy with it on, or inheriting it, needs the same')
it('the AI tool path is gated the same way')
it('turning it off and button-mode changes keep plain devices.write')
it('stored links with configureSettings false stay false')
it('delivery sends firmware_writes from WOL_FIRMWARE_WRITE_VENDORS')
it('delivery sends configure_settings false when device_execute trust is denied')
it('trust is evaluated only when configureSettings is true, within the heartbeat budget')
it('form defaults for a new link: configure on, buttonMode verified')
it('form states Fast Startup is turned off and warns about CIS when the policy targets Macs')
```

- [ ] **Step 2: Run** the files. Expected: FAIL.

- [ ] **Step 3: Implement.** Correct the `cis-hardening.mdx` row in the same PR, since no such check exists.

- [ ] **Step 4: Run** the files, then the full API, web, shared and agent suites plus Integration Tests. Expected: PASS.

- [ ] **Step 5: Commit** `feat(policy): let policies turn WOL on`.

### Task 16: Lab gate and rollout (manual, blocking merge)

- [ ] **Step 1: Run spec §9's PC checklist on the lab Dell from this branch** on a worktree stack with `WOL_FIRMWARE_WRITE_VENDORS=dell`: names and password state, apply/read back/reboot/wake from S5 and sleep, no network drop, **no BitLocker recovery with BitLocker on**, password machine reports `firmware_protected` with no write, `needs_reboot` across an agent restart.
- [ ] **Step 2: Record results in the PR.** A BitLocker prompt stops this wave for redesign.
- [ ] **Step 3: Tear down the stack, and say what's left running.**
- [ ] **Step 4: After release, follow canary pins:** set `WOL_FIRMWARE_WRITE_VENDORS=dell` in production, enable on OliveTech only, and clear pins at the next promote. Check `apply_failed` and timeout counts before widening.

---

## W07, W08, W09: HP, Lenovo, Surface

One wave each, started only when a machine is found. They don't depend on each other.

### Task 17: Add a vendor (template)

**Files:**
- Create: `biosconfig/<vendor>_windows.go` + test + `testdata/` (HP, Lenovo); `wakeconfig/surface.go` + test (Surface)
- Modify: `biosconfig/adapter.go` (`Detect`), `wakeconfig/targets.go`

**Interfaces:**
- Consumes: `Adapter`, `firmwareWriteAllowed`, `Limiter`.

| Vendor | Interface | Targets (confirm in capture) | Specifics |
|---|---|---|---|
| HP | `root\HP\InstrumentedBIOS`, `SetBIOSSetting` | `Wake On LAN=Boot to Hard Drive`, `S5 Maximum Power Savings=Disable` | Names vary by model. Sure Admin counts as protected |
| Lenovo | `root\wmi`, `Lenovo_SetBiosSetting`, `Lenovo_SaveBiosSettings` | `WakeOnLAN=ACOnly` or equivalent | Case-sensitive. Certificate auth counts as protected. "System Busy" is `needs_reboot` |
| Surface | No adapter, no writes | None | Listed models per spec §6 with a Microsoft adapter seen in 30 days are `ready`. Third-party dock, Studio 2 and unlisted models are `unproven`. Fast Startup not changed. Check VM first |

- [ ] **Step 1: Capture settings and protection output on a real machine** into `testdata/`, scrubbed.
- [ ] **Step 2: Write failing tests** matching `TestDellReadParsesCapture`, the protection tests and return-code mapping in Tasks 8 and 13; for Surface: `TestSurfaceListedWithMicrosoftAdapterIsReady`, `TestSurfaceThirdPartyDockIsUnproven`, `TestSurfaceStudio2IsUnproven`, `TestSurfaceNeverWrites`, `TestHyperVIsNotSurface`.
- [ ] **Step 3: Run** `cd agent && go test -race ./internal/biosconfig/ ./internal/wakeconfig/`. Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run again.** Expected: PASS.
- [ ] **Step 6: Run spec §9's checklist on the machine,** add the vendor to `WOL_FIRMWARE_WRITE_VENDORS` after release, record results in the PR.
- [ ] **Step 7: Commit** `feat(agent): add <vendor> WOL adapter`.
