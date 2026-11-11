---
title: Wake-on-LAN management — configure WOL through config policy and show the wake button only where the policy says it should work
status: draft 2026-10-31 — awaiting Todd's approval
date: 2026-10-31
related: "#720 (wake feedback), #2078 (action-bar gating); precedents: time_sync (#7452), warranty config delivery, system_protection attempts (#4609, #8582), device form factor (#8834)"
---

# Wake-on-LAN management

## 1. Why

Todd has the wake button on every device, and none of his devices had WOL enabled. The button offers a
wake that was never going to work, and Breeze cannot tell, because it collects none of the settings
involved. Sending the packet is already built. What is missing is turning WOL on, knowing whether it is
on, and knowing whether a wake worked.

BIOS is only one of the things that can block a wake. Fast Startup, NIC driver settings, power state,
docks and the network can each do it too, so this feature treats readiness as a whole-machine check with
thin vendor adapters underneath.

### Current state (verified on `main` at `83272d8edd`, by reading code; nothing run)

- **Sending:** `dispatchWake` (`apps/api/src/services/wakeOnLan.ts`) picks an online relay at the same site
  and subnet. The agent sends 3 rounds to UDP 7 and 9 (`agent/internal/remote/tools/wake_on_lan.go`).
  `dispatchWake` is the single chokepoint; its only callers are `routes/devices/commands.ts` (single and
  bulk) and `routes/mobile.ts`.
- **No readiness data:** the agent has no `powercfg`, `HiberbootEnabled`, `MSPower_DeviceWakeEnable`,
  `Set-NetAdapterPowerManagement` or vendor BIOS code.
- **No outcome:** `wakeAttemptId` lives only in the relay's `device_commands.payload` and the audit row.
  Nothing reads it. The audit row says `result: 'success'` before the send happens.
- **Button gating:** web shows wake on `can("devices","execute")` plus `status === 'offline'`
  (`DeviceActions.tsx`, `DeviceList.tsx`). The bulk action and the mobile button
  (`DeviceDetailScreen.tsx`) have no status gate, and `dispatchWake` never reads the target's status.
- **Dock MACs:** `resolveTargetMacs` only uses `device_ip_history` when `device_network` has no MACs at all,
  so a dock's MAC is dropped once the laptop is undocked.

## 2. Goals

1. A config policy can turn WOL on across a fleet, from inside the OS, with no install and no reboot forced
   by Breeze. Covers Dell, HP and Lenovo with BIOS and Windows changes, Surface with detection only, and Mac with one
   setting.
2. A policy decides when the wake button shows, including "show it whatever Breeze detects".
3. Admins can see, per policy, which devices are ready and why the others aren't.
4. Every wake attempt ends in a recorded outcome.

## 3. Non-goals

- Other BIOS settings. No "After Power Loss", scheduled power-on, BIOS inventory or password management.
  The agent module is built so these can be added later, but none ship now.
- Linux readiness or configuration. It reports `unsupported_os`, and wake still works with no policy or
  under "Always".
- Changing Surface UEFI or enrolling devices in SEMM. Microsoft documents neither as needed for WOL.
- Automatic wake for patch windows or schedules. A tech clicking wake is the only trigger.
- Wake over Wi-Fi, Intel AMT/vPro, or a wake proxy across subnets.
- Live relay availability in the button decision (§6).

## 4. Anti-goals: a failure even if it technically works

- **The button disappears at upgrade.** With no WOL policy, nothing changes: same button, and no new agent
  activity.
- **Breeze reboots a customer's machine** to apply a setting.
- **Breeze accepts a BIOS setting name from the server.** The agent's list of settings is fixed at compile
  time; the server only sends a yes/no. A compromised admin account or a bug must not be able to reach
  Secure Boot or TPM settings through this path.
- **Breeze stores BIOS passwords.**
- **Applying settings drops the machine's network**, for instance by restarting the adapter during a
  remote session.
- **An already-correct setting gets rewritten**, or a failing write retries in a loop.

## 5. Decisions from Todd

- WOL is turned on only through config policy. The device page has no setup prompt, warning or enable button.
- The button's visibility is a policy option: "Only when verified" or "Always".
- With no WOL policy, the button stays as it is today, to avoid the upgrade problem. **Consequence accepted:**
  devices with no policy still show the button whether or not WOL works.
- First version covers WOL only. No BIOS passwords needed for machines that don't have one set.
- Surface and Mac are in scope.

Everything marked "my call" is mine, not Todd's, and is listed for his review. Advisor quorum: Codex gpt-6-astra xhigh,
folded in; where I went against it, the section says so. Certificate-auth references (Lenovo, HP Sure Admin) come from
the advisor and are confirmed in the lab.

## 6. Behaviour

### Policy settings

New config-policy feature type `wake_on_lan`, inline settings on the feature link (JSONB, like `warranty`):

```ts
{
  configureSettings: boolean,            // Breeze changes BIOS and Windows settings
  buttonMode: 'verified' | 'always'
}
```

- **Settings form defaults (my call):** from W6, `configureSettings` on and `buttonMode: 'verified'`. Adding WOL to a
  policy is the act of turning it on. The form states what will change, including Fast Startup being turned off.
  Before W6 the form defaults to `buttonMode: 'always'`, because with nothing able to turn WOL on, `verified` would make
  buttons vanish.
- Hierarchy, partner-wide assignment and role/OS filters come from the existing policy system. **No new
  config table.**
- **Authorization:** any write that turns `configureSettings` on, or newly exposes a device to it through assignment
  or inheritance, requires `devices.execute` plus satisfied MFA, because it changes endpoints the same way a
  deployment does. `routes/configurationPolicies/hpCmslGate.ts` is the exact precedent: keyed on the result of the
  write, not the feature type, and checked in the AI guardrails path too (`aiGuardrails.ts`). Turning it off isn't
  gated. Button-mode-only changes keep plain `devices.write`.
- **Removing the policy (my call):** Breeze leaves settings as they are and does not revert them. The
  button goes back to today's behaviour. Reverting could undo settings Breeze never set.

### When the button shows

Applies on device detail, device list, bulk and mobile, on top of today's permission and offline checks.

| Effective policy | Button |
|---|---|
| None | Shows (today's behaviour) |
| `always` | Shows. Repeated failures are flagged in the status panel but don't remove it |
| `verified` | Shows if the device is **verified** |

A device is **verified** when all of these hold:

1. Its state is `ready`, or its state is `unproven` with a `came_online` wake in the last 90 days. The second
   route exists because on some machines correct settings can't prove the hardware will wake (other PC makes,
   third-party docks, Macs).
2. It has fewer than 3 consecutive `timed_out` attempts.

The last snapshot stands while a device is offline, since an offline device can't report. A proving wake counts only
while the readiness fingerprint (which includes the wired adapter MACs) matches the one recorded with that wake, and
never survives an org move. The panel calls it "came online after a wake", not "verified". A manual power-on can
produce a false proof (my call to accept that): the worst result is a button that shows, then blocks after 3 timeouts.

**Test wake (my call):** under `verified`, an `unproven` device has no button, so it could never earn its proof.
The status panel offers "Send test wake" for those devices, with the same permission as the button. It is the
only path that bypasses `WAKE_NOT_READY`. "Always" also works.

**The 3-failure block clears (my call)** when the agent's readiness fingerprint changes (something on the
machine changed) or an admin clicks "Allow wake again" in the status panel, which is audited. A later
snapshot alone doesn't clear it, because a machine can report correct settings and still never wake.

**One resolver:** `resolveWakeAvailability(deviceIds[])` serves list, detail, mobile and `dispatchWake`. A lookup
failure is not "no policy": the list hides the button for that device and `dispatchWake` returns an error, otherwise
today's allow-by-default becomes a way past the gate. The server enforces it, so an old mobile build or stale tab gets
a clear refusal rather than a silent wake:

- New failure code `WAKE_NOT_READY` when the effective policy is `verified` and the device isn't.
- New failure code `TARGET_ONLINE` when the target's status is `online`, for every device regardless of
  policy. This also gives the bulk action and mobile a status gate.
- Bulk wake reports how many were skipped and why.

**Relay availability stays out of the button decision (my call).** It changes minute to minute and can't be
computed cheaply on a list. A click with no relay returns today's specific `NO_RELAY` message, and the status panel
shows that refusal as the device's last attempt.

### Readiness states

Agent-reported unless noted. Each snapshot also carries reason codes naming which layer failed.

| State | Meaning |
|---|---|
| `ready` | Firmware, Fast Startup and at least one wired NIC are all correct and in effect |
| `needs_reboot` | Correct values are written but not yet in effect |
| `not_configured` | Settings are wrong and `configureSettings` is off |
| `apply_failed` | Breeze tried and couldn't, with the vendor's return code |
| `firmware_protected` | A BIOS admin password or certificate authentication (Lenovo, HP Sure Admin) is set, or protection can't be positively ruled out. Firmware isn't changed |
| `unproven` | What Breeze can read is correct, but that doesn't prove this hardware wakes: other PC makes, unrecognised BIOS settings, older Dell, third-party dock on a Surface, Surface Studio 2, every Mac |
| `no_wired_adapter` | No wired NIC seen in the last 30 days. Wi-Fi doesn't count |
| `unsupported_vm` | Virtual machine |
| `unsupported_os` | Linux (server-derived) |
| `agent_update_required` | Agent is too old to report (server-derived) |
| `no_data` | Policy applies, no report yet (server-derived) |

**Wired adapters are remembered, on every make (my call).** A dock-only laptop collected while undocked keeps its last
known adapter and readiness for 30 days through `last_wired_adapter_seen_at`. The fingerprint uses the remembered set,
so docking and undocking neither flip the button nor clear a 3-failure block.

Laptops get an advisory, not a state: WOL works only on AC power, and Modern Standby support varies by model.
`devices`' existing form factor drives the wording. Promise desktops; laptops are best effort.

### What gets checked and changed (Windows)

| Layer | Check / set | Notes |
|---|---|---|
| Firmware | Vendor table below | Written only if wrong, and only when no BIOS admin password is set |
| Fast Startup | `HiberbootEnabled = 0` | Side effect: full shutdowns, so slower cold boots. Stated in the form |
| NIC wake | Wake on Magic Packet enabled on wired adapters | Must not restart the adapter (`-NoRestart` or equivalent) |
| Energy-Efficient Ethernet | Off where the driver has it | Same no-restart rule. Dell lists this as required |
| Realtek | Shutdown Wake-on-LAN, where present | Keyword varies by driver |

Applied in that order of least risk first: Windows and NIC, then firmware. Each write is read back
(`onedrivehelper_windows.go` is the pattern). Read-back shows the value was stored, not that it's in effect: firmware
and `-NoRestart` NIC changes stay `needs_reboot` until a later boot confirms them.

### Vendor adapters

Native WMI only, with no vendor tool installed. **From vendor docs and community guides, not tested on
hardware. Exact names and values are confirmed in lab (§9).**

| | Interface | Settings | Known problems |
|---|---|---|---|
| **Dell** | `root\dcim\sysman\biosattributes`, `SetAttribute` | `WakeOnLan=LanOnly`, `DeepSleepCtrl=Disabled` | Post-2018 hardware only, per a third-party guide. Older Dell reports `unproven` rather than installing `DellBIOSProvider` (my call) |
| **HP** | `root\HP\InstrumentedBIOS`, `SetBIOSSetting` | `Wake On LAN=Boot to Hard Drive`, `S5 Maximum Power Savings=Disable` | Names vary by model; `S5 Wake on LAN` is also seen |
| **Lenovo** | `root\wmi`, `Lenovo_SetBiosSetting` then `Lenovo_SaveBiosSettings` | `WakeOnLAN=ACOnly` or the model's equivalent | Case-sensitive, names vary, "System Busy" means reboot pending |

Each adapter reads the machine's own settings list, matches exact names in a compile-time table and checks the target
value is allowed. Anything unrecognised is `unproven`; the agent never guesses.

**Which models get firmware writes (my call, against the advisor):** the advisor recommends limiting writes to
lab-certified model and firmware combinations, since one machine can't certify a whole vendor. That list would cover
too few models to fix a mixed MSP fleet, and these are vendor-supported interfaces that validate names and values. So
writes go to any model with an exact name and value match, controlled instead by a staged rollout (OliveTech first) and
a **per-vendor server-side switch** that stops firmware writes without an agent release.
Interface: `Detect / Read / PasswordState / Apply`, in a new `agent/internal/biosconfig` package with no
WOL logic in it, so WOL policy code owns the allowlist.

### Surface

Microsoft documents this directly, so Surface is simpler than the other vendors: **no firmware adapter and no
writes.** WOL from Modern Standby works by default on listed models, needs no IT configuration, and requires AC
power plus a Surface Ethernet adapter or dock on a wired network. Surface Dock 2 also wakes from hibernation and
shutdown on its supported models, with no SEMM or UEFI policy.

- A listed model with a Microsoft adapter or dock seen in the last 30 days is `ready`.
- New models not yet on the compile-time list, third-party docks and Surface Studio 2 are `unproven`. Studio 2 needs
  a registry change Microsoft says must be redone after a Windows version upgrade, which isn't worth automating.
- Breeze doesn't change Fast Startup on Surface. Microsoft documents no need for it.
- Advisory: "Needs AC and a wired dock or adapter. Wakes from sleep; from shutdown only on Surface Dock 2."
- Check the virtual-machine classification first, since `classify.go` notes Microsoft is both the Surface and
  Hyper-V manufacturer.

### Mac

- **Read:** `pmset -g` for `womp` ("Wake for network access"). **Write under `configureSettings`:** `pmset -a womp 1`,
  read back.
- **Always `unproven` until a real wake is recorded.** There's no Apple support statement to rely on. The setting
  existing doesn't show it works, and a third-party report says Apple Silicon isn't reliable with magic packets
  (anecdotal). As far as I know Macs don't wake this way from a full shutdown, which isn't sourced and goes in the
  lab gate. Advisory: "Wakes from sleep only, on AC and wired."
- **Conflict with CIS:** the CIS Apple macOS benchmark says to disable Wake for Network Access, so a customer's CIS
  audit will flag this. The form says so when the policy targets Macs. Breeze's own docs
  (`apps/docs/src/content/docs/features/cis-hardening.mdx:508`) list this as a check, but no such check exists in
  `agent/internal/cis` or the API (searched for `womp` and wake-network patterns). If one is added later, it needs to
  reflect this policy rather than contradict it. Correct or implement that docs row separately.

### Agent behaviour

- Only runs with a delivered policy. No policy means no collection and no writes.
- Collects after a settings change, after boot, and every 24 h. Uploads when the fingerprint changes or
  every 24 h.
- Firmware writes: at most one attempt per setting per 24 h, stopping after 3 failures until the policy
  fingerprint changes.
- Writes firmware only when protection is **positively confirmed absent**. Unknown means no write. Trying a write
  just to see if it's refused could count against lockouts on some models.
- **BitLocker (my call, confirmed in lab):** before a firmware write, read the OS volume's protectors. If BitLocker is
  on and the TPM validation profile includes PCR 1 (BIOS configuration), or the profile can't be read, don't write and
  report `firmware_protected` with a reason. As I understand it, the default UEFI profile doesn't include PCR 1, so most
  machines are still writable; this is from memory, so the lab confirms it. The agent never suspends BitLocker. It reads
  BitLocker status today (`agent/internal/security/status.go`), but no protector or PCR logic exists yet.
- **Partner trust (my call):** partners whose trust level denies `device_execute` don't get `configureSettings` delivered,
  and their devices report `not_configured` with a reason, so a probation or restricted tenant can't change firmware on
  enrolled machines. Wake itself stays exempt as a lifecycle command. The check must fit `agentHotPathQueryBudget`.
- Persists write attempts and pending state across agent restarts, so limits survive and `needs_reboot` clears only
  after a boot later than the write.
- Never reboots. `needs_reboot` clears at the machine's next natural reboot.
- Re-applies on drift (a driver or BIOS update can reset settings), subject to the same limits.

### Wake outcomes

Every `dispatchWake` writes an attempt row, except `TARGET_NOT_FOUND`, `TARGET_ONLINE` and parked refusals, which would
only be noise. `relay_device_id` and the command reference are nullable for refused attempts, which close immediately.

| Outcome | Meaning | Counts as a failure |
|---|---|---|
| `pending` | Created, relay not yet confirmed | - |
| `sent` | Relay reported packets sent | - |
| `send_failed` | Relay reported failure, or no result by the deadline | No, the target wasn't tested |
| `came_online` | Target seen online after sending, observed by a sweep inside the window | Clears the count |
| `timed_out` | Packets sent, target not seen by the deadline | Yes |
| `unknown` | The sweep didn't run in time to tell | No |
| `refused` | `dispatchWake` stopped before sending, with the code stored (`NO_RELAY`, `NO_MACS`, `NO_SUBNET`, `WAKE_NOT_READY`) | No |

- **Window:** 10 min from the server's send time; the relay's clock isn't used.
- The UI says "came online", never "woke". A user could have pressed the power button, and the record
  shouldn't claim more than it knows. Store `boot_after_send` when `uptime_seconds` shows a boot after the
  send, as stronger evidence. Uptime can't prove a wake from sleep, so it isn't required.
- **A sweep job resolves outcomes, not the heartbeat path.** Status writes are scattered across `heartbeat.ts`,
  `agentWs.ts` and `heartbeatParked.ts`, with no single offline-to-online transition. A minute-granularity sweep over
  a partial index on open attempts adds nothing to the heartbeat's query budget.
- **Late sweeps can't prove anything.** `last_seen_at` only holds the newest time, so `last_seen_at >= sent_at` proves
  arrival inside the window only if the sweep itself runs inside it. If the worker was down and first checks after the
  deadline plus 2 minutes, a device showing a later `last_seen_at` is `unknown`, not `came_online`. The advisor preferred
  capturing timestamped evidence in the ingest paths. I kept the sweep (my call): that adds hot-path writes for a rare
  case, and `unknown` is honest about it.
- **One open attempt per device** (partial unique index). A repeat click re-sends packets on the open attempt and doesn't
  move its deadline, so three impatient clicks can't become three failures.
- Finalising an attempt and updating the status row's counters happen in one transaction. A relay result arriving after
  a terminal outcome is ignored.
- Relay result: add a `wake_on_lan` handler in `commandResultHandlers.ts`.
- This table does not replace the audit row. Leave its existing `result: 'success'` semantics alone.

### MAC targeting

Union `device_network` MACs with `device_ip_history` MACs seen in the last 30 days, newest first, capped at 8.
This keeps dock MACs targeted after undocking. **Exclude any MAC another device in the org reported more recently:** on
a shared or hot-desk dock, an old dock MAC now belongs to someone else's laptop, and the packet would wake that machine.

### Status panel

Inside the `wake_on_lan` policy tab: counts by state, then a paginated device list with state, reason, vendor
and model, last attempt and outcome, and the "Allow wake again" action. Nothing WOL-related is added to the
device page apart from the button itself. `DeviceEffectiveConfigTab` shows the resolved policy like every other
feature. Finding the devices governed by a policy has no reverse lookup today, so the endpoint resolves over the
policy's assignment scope using the bulk resolver.

## 7. Data model

Both tables are new, tenant-scoped, and get RLS in the creating migration. Read `docs/agents/tenancy-rls.md`
first; the registration lists there are mandatory (`CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts`,
`CORE_TENANT_EXPORT_POLICY`, device cascade lists, org-move disposition).

**`device_wake_status`**: one row per device, mirroring `device_time_status` (PK `device_id`, `org_id` NOT NULL,
composite FK to devices). Readiness state, reason codes, vendor, fingerprint, collected-at, last apply result,
`details` JSONB (`excludedOpen`), `last_came_online_at`, `consecutive_timeouts`, `blocked_fingerprint`.
Created at first snapshot or first attempt.

**`device_wake_attempts`**: mirroring `device_restore_point_attempts`. `id` = `wakeAttemptId`, device, org, relay,
command, requested-by, `bulk_id`, MACs, broadcast, outcome, `boot_after_send`, sent-at, resolved-at. Partial index
on open attempts. Retention 90 days, registered like `restorePointAttemptRetention`. Unlike that job (#8582), this
sweep does relabel stale rows, since `timed_out` is its purpose.

**Org move (#8634), decided rather than left to the builder:**

- `device_wake_status` moves with the device (database restamp through the composite FK), and the move clears proof and
  failure counts in the move transaction, because the new org means a new network and relay set.
- `device_wake_attempts` rows are deleted on move. They're 90-day telemetry about a network the device left.
- `relay_device_id` is a plain nullable reference with `ON DELETE SET NULL` plus a relay hostname snapshot, not a composite
  FK sharing `org_id`, because a relay and target can't be guaranteed to stay in one org.
- If `moveOrg.coverage.test.ts` demands a different list registration for these outcomes, follow the test and keep the
  outcomes.

**Enum:** `config_feature_type` ADD VALUE in its own migration file, named after the newest on main (currently
`2027-01-18-130000`). Re-check at merge.

## 8. Contracts and registration

- **Delivery:** `configUpdate.wake_on_lan_settings` with a fingerprint (`buildTimeSyncConfigUpdate` and
  `buildWarrantyConfigUpdate` are the patterns). Add to `POLICY_SET_FEATURE_TYPES`. Agent handling must sit above
  the policy-probe early return in `heartbeat.go`. Must stay within `agentHotPathQueryBudget`.
- **Upload:** `PUT /agents/:id/wake-status` (like `time-status`), which touches `parkedRouteClassification`,
  `bodyLimit.ts` and `agentsim` budgets.
- **No new command type,** so `partnerTrust` command classification and offline policy don't change. Delivery has its own
  trust check (§6, Agent behaviour).
- **Bulk resolver:** generalise the existing batch path rather than writing a new one
  (`resolvePatchPolicyWinnersForDevices`, `featureConfigResolver.ts:743`, which has an integration test pinning it
  against the per-device resolver; also `resolveSecurityAgentsLinksForDevices`). Add a parity test. Resolve only the
  page's device IDs. Add `wakeAvailability` to list rows through the batch at `routes/devices/core.ts`, and to detail.
  `remoteAccessPolicy` is the detail-page precedent. Measure rows and latency on a large page, not just statement count.
  Status-panel counts must be bounded: a partner-wide policy can reach a very large fleet, so the builder may use
  background aggregation.
- **Feature-type registration:** mirror `system_protection`: `configFeatureTypes.ts`, validators,
  `featureLinks.ts`, `configurationPolicy.ts`, `featureConfigResolver.ts`, `policyBaselineDefaults.ts`
  (`NOT_ENFORCED`: "Wake button shows on every offline device; Breeze doesn't check or change WOL settings"), AI tool
  registration, `ConfigPolicyDetailPage.tsx`, `featureTabs/types.ts`, `DeviceEffectiveConfigTab.tsx`, parity tests, and
  all 8 locales.
- **Settings rule 9:** home = config policy WOL tab. Level = policy assignment hierarchy. Resolver =
  `resolveWakeAvailability`. Places configured: 0 before, 1 after.

## 9. Delivery order

Multi-wave feature; register it after the plan. **Writes reach customers only in the last wave.**

| Wave | Contents | Customer-visible |
|---|---|---|
| W1 | Attempts table, sweep, relay handler, `TARGET_ONLINE`, MAC union, status row | Outcome recorded; wake refused on online devices |
| W2 | Feature type, delivery, read-only collection and the Dell read adapter, resolver, gating on all surfaces, status panel. API rejects `configureSettings: true` at write and leaves it out of delivery; toggle hidden | Policies can gate the button and report readiness |
| W3 | Agent Windows and NIC writes, inactive because nothing can set the flag | None |
| W4 | Agent firmware writes for Dell only, inactive likewise | None |
| W5 | Mac read and `womp` write. Reports `unsupported_os` until this ships | Macs report readiness |
| W6 | Toggle in the tab with form defaults changed for new policies, docs, release notes, staged activation: Dell switch on, OliveTech first | Policies can turn WOL on, with BIOS changes on Dell only |
| W7+ | One wave per vendor as machines are found: HP, Lenovo (read and write adapters), Surface (detection) | That vendor moves from `unproven` to supported |

Keeping the toggle until W6 matters, and hiding it isn't enough on its own, since the API and AI tools can also write
policies. Rejecting `true` server-side until W6 means no stored policy can start writing to BIOS the moment an agent
update delivers W4. Policies saved before W6 keep their explicit `false`.

**Hardware (Todd, 2026-10-31):** one Dell is in the lab. HP, Lenovo and Surface machines still have to be found, so
vendors ship one at a time and none waits on another. Confirm the lab Dell is 2019 or newer, since older Dell doesn't
have the native WMI interface.

**No adapter ships before its vendor's machine has been tested (my call).** A server switch can stop writes, but
untested write code shouldn't reach customer machines at all. Until a vendor's wave lands, its devices report `unproven`:
"Always" or a test wake still gives them a button, and under `configureSettings` they still get the Windows and NIC changes,
just no firmware change. Those Windows changes are lab-tested on the Dell only, which is an accepted risk until more
hardware is available.

**Capture step before W2 and each W7+ wave (blocking):** vendor read adapters decide who gets a button, and their tests
need real captured output. Capture that vendor's settings list and confirm its name table first.

**Lab gate before W6 for Dell, and before each later vendor's switch turns on (blocking):** a real machine from that
vendor. VMs can't exercise any of this. Surface and Mac get their own checks below. On each PC:

1. Confirm setting names, values and password-state reads.
2. Apply through policy, read back, reboot, then wake from S5 and sleep through a relay.
3. Confirm no network drop during apply.
4. **Confirm no BitLocker recovery prompt after the BIOS change on a BitLocker-enabled machine. This hasn't been
   verified. If any vendor triggers it, stop and redesign that vendor's path.**
5. Confirm a machine with a BIOS password reports `firmware_protected` with no write attempted, plus HP Sure Admin or
   Lenovo certificate auth if a machine can be set up with it.
6. Confirm `needs_reboot` clears only after a real reboot, including after an agent restart in between.

**Surface and Mac, same gate:**

- A Surface on a Microsoft dock or adapter: wake from sleep, confirm the model and adapter detection.
- An Apple Silicon Mac and an Intel Mac: wake from sleep and try from shutdown. **If Apple Silicon doesn't wake
  reliably, Macs stay read-only, with no `womp` write, and W5's write path doesn't ship.** Dropping this doesn't block
  the other vendors.

Agent rollout follows the normal canary pin path, clearing pins at the next promote.

## 10. Testing

Full rigor: agent code on customer machines plus new tenant tables.

- **Agent:** `go test -race`; adapters run against a fake WMI layer fed by captured per-model output; prove that
  already-correct values cause no write, that a password stops a write, that rate limits hold, and that only allowlisted
  names can be written.
- **API:** resolver truth table including no-policy, partner-wide, parked devices and lookup failure; bulk/single parity;
  every outcome transition including a late sweep; repeat-click coalescing; sweep idempotence; the 3-failure block and its
  two clears; shared-dock MAC exclusion; org-move clearing; `devices.execute` plus MFA gate on enable, assign and AI paths;
  `configureSettings: true` rejected before W6.
- **Integration suites:** RLS coverage with a cross-tenant forge, cascade, merge and export-policy, and heartbeat
  query budget. All blocking, and only under Integration Tests.
- **Web and mobile:** button matrix on each surface, mixed-selection bulk, and status panel.

## 11. Left to the builder

- WMI method calls via `go-ole` or PowerShell CIM. `yusufpapurcu/wmi` only covers reads; `hardware_windows.go` has
  the CIM pattern.
- Fingerprint contents, exact reason-code names, the minimum agent version for `agent_update_required`.
- The 8-MAC cap, 24-hour cadence and 3-failure threshold may be tuned given a reason, and the reason goes in the PR.
