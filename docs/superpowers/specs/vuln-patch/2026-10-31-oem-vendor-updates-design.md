---
status: draft-for-approval
related: [3855, 4226, 5511, 5512, 6960]
---

# Vendor updates: Dell Command Update, Surface, HP and Lenovo

Code references were checked against `origin/main` at `83272d8edd`. Vendor facts were researched on 2026-10-31. Each one is labelled **(vendor doc)**, **(observed)** or **(not confirmed)**. Anything marked "not confirmed" must be settled by the named lab gate, not assumed.

## 1. Why this exists

Today a tech logs in to a struggling Dell and runs Dell Command Update (DCU) by hand, usually applying everything. Machines where DCU was pre-configured for a monthly install-all with an overnight reboot have less trouble, and their users aren't bothered.

This feature makes that the managed default for a fleet and removes the login from the troubleshooting step. Breeze keeps each hardware vendor's own update path running on a schedule, and a tech can trigger it remotely.

**Success looks like:**
- A policy gets every supported Dell onto the monthly schedule without anyone configuring a machine.
- A tech can click one button instead of remoting in.
- A machine that has quietly stopped updating is visible.

## 2. Goals, non-goals, anti-goals

**Goals**
1. A partner-wide or org config policy turns on monthly, install-everything vendor updates with an overnight reboot.
2. A per-device **Run vendor updates** action, without logging in.
3. Breeze installs the vendor tool when one is needed and keeps it at or above a safe version.
4. Each device shows its last run, its outcome and what was installed. A fleet view shows overdue, failing and unsupported machines.
5. Dell ships first. Surface, HP and Lenovo follow behind the same policy and behaviour, so a tech doesn't care which brand it is.

**Non-goals (v1)**
- Approving individual BIOS, firmware or driver updates. This doesn't match how the work is done, and it would double the build.
- A "pending vendor updates" compliance score. There is no scan-only mode.
- BIOS passwords. Breeze delivers no BIOS secret. Affected machines report a failure the tech can act on.
- Servers, virtual machines, macOS and Linux. Dell servers use different tooling (other source).
- Mirroring vendor binaries through Breeze. Redistribution rights are not confirmed for any vendor.

**Anti-goals: failures even if the feature technically works**
- Bricking machines, or leaving users at a BitLocker recovery prompt the next morning.
- Interrupting someone during the working day with an install or reboot they didn't expect.
- Reporting a machine as healthy when its updates have silently stopped.
- Shipping an HP, Lenovo or Surface BIOS path nobody has tested on real hardware.

## 3. Decisions

| Decision | Whose call |
|---|---|
| Install everything the vendor recommends, with no per-update approval | Todd |
| Monthly schedule with an overnight reboot, no user prompts during the day | Todd |
| Dell's BitLocker and BIOS handling is trusted, and suspend is used during updates | Todd (his experience) |
| Include Microsoft Surface | Todd |
| No daytime installs or wake timers; laptops that miss every night show as Overdue | Todd |
| Buy used test units for Surface, HP and Lenovo BIOS and firmware testing | Todd |
| **HP, Lenovo and Surface BIOS and firmware stay off until a lab leg passes on that vendor** | My call; Todd has no experience with these vendors, and the docs below are weak or conflicting |
| Breeze triggers each run; the vendor tool's own scheduler is turned off | My call (§4.2) |
| The agent makes sure the tool is present as part of the run; no generated software policy | My call (§4.4) |
| The tool never reboots itself; Breeze's reboot path does. If Dell can't flash BIOS that way, Dell BIOS stays off until the lifecycle is revised | My call (§4.5), after advisor review |
| One owner per update class, for Breeze patch jobs only and only where the vendor lane is really delivering. Native Windows Update isn't touched | My call (§4.6), after advisor review |
| Protective trust tier, with arming still requiring `devices.execute` and MFA | My call (§4.1), after advisor review |
| BIOS and firmware need an overnight reboot, AC power and an escrowed recovery key | My call (§4.5) |
| A new lane or BIOS gate never turns on by itself in existing policies | My call (§4.1) |
| Ships dark behind an env flag until the W3 canary | My call (§6) |

## 4. Design

### 4.1 Shape: a new config-policy feature with inline settings

Append `oem_updates` to `config_feature_type` (`apps/api/src/db/schema/configurationPolicies.ts:33-68`). The UI name is **Vendor updates**. Settings live inline on the link because they are a few values with nothing else to reference. `featurePolicyId` stays NULL. Partner-wide authoring works through the existing path, with fan-out by the device's org.

```
{ version: 1,
  enabled: boolean,
  schedule: { weekOfMonth: 'first'|'second'|'third'|'fourth'|'last',
              dayOfWeek: 'sun'…'sat',
              windowStart: 'HH:MM', windowHours: 1-8 },
  catchUpNights: 0-14,
  reboot: 'overnight' | 'never',
  vendors: {                     // an absent vendor or category means off
    dell?:    { enabled, categories: { bios?, firmware?, driver?, application? },
                blockedUpdateIds: string[] },
    surface?: …, hp?: …, lenovo?: … } }
```

**Defaults (my call):**
- Third Wednesday, 01:00, a 4-hour window. It stays clear of Patch Tuesday, and a problem shows up on a working day when techs are available.
- 7 catch-up nights and an overnight reboot.
- A new policy pre-selects Dell with all categories, plus any other lane that has shipped, with only the categories whose gate is open.

**No category turns on by itself.** A release that ships a lane or opens a BIOS gate must not start flashing on existing policies. Settings store only explicit choices, the UI offers a category only once its gate is open, and turning it on is a new `devices.execute` decision. Existing policies get a visible "now available" note and nothing else changes.

**Resolution:** closest wins within `oem_updates`, using the same hierarchy walk as other features. A closer link replaces the farther one entirely. The timezone comes from the existing `resolveEffectiveTimezone` path, as `patchSchedulerWorker.ts` does.

**Trust tier:** `protective` in `CONFIG_POLICY_FEATURE_TRUST_TIER` (`packages/shared/src/constants/configFeatureTypes.ts`). The contract's test is whether a feature "grants the device a capability it does not already have", not whether it installs something, and it uses `patch` as its example. A fixed vendor payload carries no credential or admin-authored content, unlike `security_agents`.

Gating would also be unsafe here. Gated group rows are dropped before closest-wins (`configurationPolicy.ts:2966-2976`), so dropping a group override that turns BIOS off could expose a broader policy that turns it on.

**Writers:** arming the policy requires `devices.execute` as well as the normal link write (`devices.write` + MFA), and `canManagePartnerWidePolicies` for a partner-wide policy. This matches the `security_agents` install-arming rule and is independent of the trust tier.

**Settings rule 9:**
- Home: the config policy's Vendor updates tab
- Levels: partner-wide, overridden by org
- Resolver: `resolveOemUpdatesLinkForDevice`
- Places the concept is configured: 0 before, 1 after

Reboot prompt text, grace and deferral are read from the existing patch settings, not copied.

### 4.2 Scheduling: Breeze triggers the run

A repeatable BullMQ worker ticks about every 10 minutes, on the `maintenanceRebootWorker.ts` model. It selects devices that are:
- online, not parked (`notParkedDeviceCondition`) and **not ephemeral**. Quick Support devices are strangers' borrowed machines, and that filter doesn't exclude them; `maintenanceRebootWorker.ts` filters them separately, and this worker must too
- resolved to an enabled `oem_updates` link
- applicable (§4.3)
- inside their local window
- without a finished run for this month's occurrence, and without a run in flight
- under the attempt limit

It re-resolves the winning link immediately before dispatch, and honours maintenance-mode and claim holds as patch jobs do. A stable per-device offset within the first hour of the window spreads downloads.

**Dispatch safety:**
- Every background dispatch passes `expectedOrgId`, the org the decision was made under (`commandQueue.ts`, #5264), so a device moved mid-flight can't receive the old org's firmware command.
- Each command carries an occurrence key and a `notAfter` time. The window must also bound delivery: the existing offline `reject` policy has no deadline, and online at dispatch doesn't mean it runs in the window. The agent refuses to start after `notAfter` and reports `retry_later`.

**Why not DCU's own scheduler.**

DCU can schedule itself (`-scheduleMonthly=third,Wed,01:00`, vendor doc), which is what Todd does today. Breeze drives the run instead because:
- HPIA has no scheduler, Lenovo's options are limited, and Surface has none, so a single behaviour needs a single trigger.
- DCU's behaviour after a missed window is not confirmed.
- Breeze needs the result, a central way to stop runs, and reboots through its own safety rails.

The cost is that a device must be online with a running agent during the window.

**Taking over and handing back the vendor schedule.** Only a *scheduled* run takes over. Before the first one on a device, the agent saves the tool's settings (`-exportSettings` on Dell) in its own protected directory, then runs `dcu-cli /configure -scheduleManual -updatesNotification=disable` and re-asserts it on later runs. This stops double runs on machines already configured by hand. Policy-controlled settings can make this a no-op (vendor doc), so the agent checks the result.

When a device stops resolving to an enabled lane, the server queues a release and the agent restores only what it changed. This follows `winupdate.go`, which records Breeze's ownership and reverts only its own state. Without this, removing a policy would silently stop updates on a machine that used to update itself.

**Run Now changes no settings**, so one click on an unmanaged Dell doesn't disable its schedule.

**Missed runs:** a device retries on each of the next `catchUpNights` nights, up to 3 attempts per occurrence. It then shows as **Overdue**. A scheduled run never starts outside the window (§8).

**Outcomes that don't use up an attempt:**
- `blocked_on_battery`. Patch jobs have a known retry gap (#4226); here the next night retries.
- `blocked_reboot_pending`, covering Dell exit 5 and an existing pending reboot. On `reboot: 'overnight'`, Breeze reboots inside the window and the run follows the next night. On `reboot: 'never'`, the device shows **Waiting for reboot**, not Failing.

### 4.3 Which devices apply

A pure server function returns the lane or a reason. Inputs are `device_hardware.manufacturer` and `model`, the OS, `devices.isVirtual` and the device role. **Don't reuse `normalizeManufacturer` as is:** its `includes('hp')` match (`warrantyProviders/index.ts:14-21`) is too loose to authorise flashing a BIOS. Use exact or anchored matches, with tests that include near-miss manufacturer names.

| Reason | Treated as |
|---|---|
| Not Windows, virtual, a server, or an unknown manufacturer | `not_applicable`, not a failure |
| Vendor disabled in the policy, or its lane not yet shipped | `not_applicable` |
| The tool itself refuses the model (Dell exit 3 or 7, HP exit 4096) | `not_supported`; sticky until the model or tool version changes, so consumer models aren't retried monthly |

The tool's own answer decides model support. Vendor model lists are partial, and consumer-line support is unclear (other source).

### 4.4 New command `oem_update_run`, separate from patch providers

**Why not a patch provider.** The provider interface (`agent/internal/patching/types.go:80-87`) assumes per-patch inventory and approval. `ScanWithCoverage` (`manager.go:57`) runs every provider and feeds compliance. A separate command fits "run the vendor's tool and report back".

**Registration.** Follow the `force_reboot` example (#8729):
- `commandTypes.ts`, `commandTimeouts.ts` (2-hour class), `commandOfflinePolicy.ts`, `partnerTrust.ts`
- the audit set in `commandQueue.ts`
- `commandMinVersion.ts` (fail closed, gated before queueing)
- `mcpCoverage.ts`
- agent handler and `privilege/check.go`
- classification in `parkedFanout.contract.test.ts` and the per-area gating contract

**Payload**
```
{ lane, trigger: 'scheduled'|'on_demand', categories, blockedUpdateIds,
  tool: { version, minSafeVersion, url, sha256, prerequisites[] } }
```

**Agent steps**
1. Take a per-device run lock, so duplicate runs can't overlap.
2. Run `patchInstallPreflight` (disk, service health), then the mandatory power check in §4.5.
3. Detect the tool and its version. Check its Authenticode signature and publisher before every execution, not only after download.
4. If the tool is missing or outside the supported version range, download it, verify SHA-256 and publisher, install prerequisites, install silently, then verify the installed version and signature again.
5. Run the lane and map its result to the normalized outcome.
6. Report the result.

The agent refuses `oem_update_run` unless it's running elevated. The existing privilege check only warns (`heartbeat.go:7857`), so this needs its own check. Likewise, a `commandMinVersion.ts` entry alone isn't universal: the route and the scheduler must both call the shared fail-closed helper before queueing.

**Why not a generated software policy.** `security_agents` uses one, and it's a good pattern for "keep this product installed everywhere". It doesn't fit here because:
- Run Now must work on any Dell, with or without a policy.
- The tool only matters at the moment of a run.
- Desired state checks `minVersion` but doesn't guarantee a safe install: remediation picks a package-manager method or the latest catalog version without enforcing the floor. Winget's DCU is below the security fix (§5).
- It avoids the managed-policy resolution work in `security_agents` §2.2.

**The tool manifest** is a code registry in the API (`services/oemUpdates/toolManifest.ts`), updated by normal releases. It holds the pinned version, URL, SHA-256, prerequisites and a supported version range per lane, because a newer major version may change exit codes and flags. If a URL disappears, a tool already inside the range keeps working, and a device without one reports `tool_unavailable`.

**Agent-side hard limits.** The agent holds its own per-lane list of allowed publishers and download hosts. The command can't make it fetch or run anything else. SHA-256 checks exist today (`software_install.go:293-301`), but Authenticode verification does not, so this feature adds it. Reports, logs and downloads go in an agent-owned directory that standard users can't write to, because the tools run as SYSTEM.

**Normalized outcomes**

`success`, `success_reboot_required`, `no_updates`, `partial`, `failed`, `not_supported`, `tool_unavailable`, `blocked_on_battery`, `blocked_reboot_pending`, `blocked_no_recovery_key`, `retry_later`, `interrupted`

The result carries the lane, tool version, raw exit code, an error code, and an item list (title, category, version, result) capped at 200 entries with bounded strings. Raw tool logs aren't uploaded by default. Exit-code tables are per lane and per tool major version, because Dell's differ across versions (other source).

**An agent stop during a run** becomes a synthetic failure (`command_journal.go:36-48`). The agent therefore writes a run marker before starting, and after a restart reports `interrupted` with whatever it knows. Interrupted runs count as attempts.

### 4.5 Reboots and BitLocker

**Reboots.** Tools run with their reboot disabled where possible. The agent reports `rebootRequired`, and the API hands off to the existing `schedule_reboot` path (`patchRebootHandler.ts`). That keeps the warning ladder, end-user deferral, circuit breaker and prompt text.

- **The invariant stays:** "no reboot is ever silent" (`reboot_plan.go:91-93`, #3197). Overnight, the notice reaches nobody, which is what "doesn't bother the user" means.
- **A new overnight mode is needed.** Reusing `executeReboot` unchanged doesn't hold the window: `computeRebootDeadline` won't pull a deadline in front of the scheduled time, the inherited delay can be up to 1440 minutes, and deferral is off by default. This feature's rules are:
  - The reboot must begin inside the window. The grace period is clamped to fit, and the default is 15 minutes.
  - The "next window opening" is **tomorrow night's** window at the same time, not next month's. A pending vendor reboot is held and retried nightly.
  - If a policy allows deferral and someone at the machine defers, it can't run past the window's close. It moves to the next night and is never pushed into the working day.
  - After 3 nights of holding, the device shows **Reboot overdue** to the tech. It isn't forced.
- **Run Now** asks the tech to choose **reboot when finished** or **leave reboot to me**.
- **Shutdown vs reboot:** Lenovo's ThinkCentre BIOS packages can request a shutdown (other source). The result must be able to carry that, and it must not be treated as a reboot.

**BIOS and firmware get stricter rules than drivers:**
- **They need a reboot Breeze controls.** With `reboot: 'never'` or **leave reboot to me**, that run skips those categories. A `RebootCount` limits reboots, not time, so a machine that never reboots could stay suspended indefinitely.
- **AC power is mandatory**, whatever `PatchRequireACPower` says, since that config can turn the check off. The battery must also be at or above 25%, because Surface capsules fail below that (vendor doc) and AC-connected alone passes today. The check runs immediately before the install.
- **An escrowed recovery key is required when BitLocker is on.** If Breeze doesn't hold a current key for the device, those categories are skipped and the outcome is `blocked_no_recovery_key`. Otherwise a tech can't help a user locked out the next morning. The plan must define "current" against the existing recovery-key flow.
- **Nothing may interrupt a flash.** `schedule_reboot` deliberately bypasses the command barrier (`commandClaimEligibility.ts:110`), and agent upgrades defer for backups but not firmware. The agent holds a durable local critical section while a BIOS or firmware install runs, and reboot timers, agent upgrades and duplicate runs all respect it. `force_reboot` gets the same treatment: it must wait.
- **Durable state.** The agent records suspend → update → reboot → verify and resume on disk. The generic pending-reboot detector checks Windows registry signals only and can't confirm that a vendor update completed.

**BitLocker by lane**

| Lane | Approach | Evidence |
|---|---|---|
| Dell | `-autoSuspendBitLocker=enable` on `/applyUpdates`: suspends, reboots, re-enables | Vendor doc, and Todd's experience |
| Surface | Caller suspends with `Suspend-BitLocker -RebootCount` ≥ 3 after a PCR 7 binding preflight (`manage-bde -protectors -get C:`); never `0`, which means indefinite | Vendor doc; Microsoft's docs conflict on the count |
| HP | CMSL `Get-HPBIOSUpdates -Flash -Yes -BitLocker suspend` for BIOS; the HPIA guide doesn't mention BitLocker | Vendor doc for CMSL, HPIA not confirmed |
| Lenovo | Not documented; assume the caller must suspend | Not confirmed |

Breeze has no BitLocker suspend or resume code for updates today, though recovery-key rotation does add and remove protectors (`recoverykeys.go:110`). Non-Dell lanes add suspend and resume, with an agent-side guarantee that BitLocker comes back on.

**Dell lab gate (W1, blocks merge):** Dell's documentation describes suspension together with an automatic reboot, and doesn't establish the combination this design wants. Confirm that `-reboot=disable` together with `-autoSuspendBitLocker=enable` still includes BIOS updates, how long protection stays suspended before the reboot, and that protection returns afterwards.

**If that combination fails, W1 ships Dell with BIOS off, and drivers, firmware and applications on where the lab shows they work.** The decision on BIOS then comes back to Todd with the lab evidence. `-reboot=enable` is the likely answer, because it's Dell's own path and the one he trusts, but it would give up the warning, deferral and circuit-breaker behaviour. That trade isn't made automatically.

### 4.6 One owner per update class

Windows Update includes drivers by default (`feature_update_policy.go:167-181`). Left alone, Windows Update and DCU can offer different versions of the same driver.

**The rule:** a driver or firmware Windows Update patch is excluded from a device's Breeze patch jobs only when the lane is really delivering that category on that device. All of these must be true:
- the policy has the category on
- the manifest gate for that category is open
- the device is `applicable`, not `not_supported`
- the lane has completed at least one run there
- the device isn't currently Overdue or Failing

Otherwise Windows Update keeps delivering it. A consumer Dell the tool refuses, or a Surface whose firmware gate is closed, must not lose its only update path. Excluded patches are shown as "managed by Vendor updates". Devices without a lane are unchanged, and security and quality updates aren't affected.

**What this doesn't cover, on purpose:**
- **Native Windows Update isn't touched.** It's a separate channel (`winupdate.go`), and suppressing drivers there could also starve the Surface lane. If the lab shows real version conflicts, that's a later change.
- **A tech's manual install on a device still works** (`routes/devices/patches.ts:227`). An explicit action wins.

**Implementation notes:**
- `excludeCategories` is a ring field, so a per-device exclusion needs new wiring into the evaluator and job snapshot.
- Identify drivers by the WUA update type, not the category string alone. A security classification beats driver and firmware in `category.go:28`, and such an update stays with Windows Update.

### 4.7 Status, history, and machines that don't come back

**New table `device_oem_update_status`**: one row per device, org-scoped, updated by the command-result handler and the scheduler.

- **Columns:** `device_id`, `org_id`, `lane`, `applicability`, `reason`, `tool_version`, `occurrence_key`, `attempts`, `last_attempt_at`, `last_success_at`, `last_outcome`, `last_command_id`, `installed_count`, `failed_count`, `reboot_required`, `bios_version_before`, `updated_at`.
- **Tenancy:** direct `org_id`, because this is device state, not config. RLS enabled and forced with policies in the creating migration, composite device/org FK `DEFERRABLE INITIALLY IMMEDIATE` with `ON UPDATE` and `ON DELETE CASCADE`, as in `securityAgents.ts:65`. No JSON columns.
- **Registration:** `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts`, `CORE_TENANT_EXPORT_POLICY`, and **both** device org-move registrations in `docs/agents/tenancy-rls.md`.
- **Precedent:** `security_agent_device_status`, `device_restore_point_attempts`.

**Run history** stays in `device_commands.result`. `patch_jobs` is not reused, because it's built around approved-patch snapshots. Command rows currently have no retention limit. The existing history route (`routes/devices/patches.ts`) needs two changes before reuse, tracked separately: its result set must be scoped to the current organization, and the type filter must normalize the OEM result (adding to `PATCH_COMMAND_TYPES` covers `all`, not `type=install`).

**Machines that don't come back.** The worst failures happen before a final result can be sent, so the check can't depend on one. When a run's categories include BIOS or firmware, the API arms a monitor at dispatch and records `bios_version_before`. If the device doesn't check in within 24 hours of the run starting, raise an alert. It stands in for what a tech would otherwise find at the next ticket: a machine stuck at BitLocker recovery or a failed flash. After reboot, compare `device_hardware.biosVersion` to the value before the run and record any mismatch.

### 4.8 Stopping a bad update

Vendor bad-update incidents are real, so there are four stops:

1. **Policy:** turn a category off (BIOS, say) or add an ID to `blockedUpdateIds`. Dell maps these to `-updateType`, `-updateDeviceCategory` and `-localblockedswb`, HP to `/Category` plus an allowlist built from the analyze step (`/SPList`), Lenovo to package filtering, Surface to `UpdateID`. Dell dock updates ignore type and category filters (vendor doc); whether they honour `-localblockedswb` is not confirmed, and the plan must document it.
2. **Pilot groups:** a policy assigned to a pilot group with an earlier week. This is the staged rollout in v1; no new ring concept.
3. **Fleet-wide:** a code-level lane and category block in the tool manifest, shipped by a normal deploy, and an env var that disables dispatch for a lane without a deploy.
4. **DCU's slow ring** (`-delayDays`, `-ringdeployment`) is deliberately not exposed in v1, since the other vendors have no equivalent.

### 4.9 UI

- **Policy:** a Vendor updates tab in the config policy editor, using the existing feature-tab pattern.
- **Device actions:** **Run vendor updates** in `DeviceActions.tsx`, disabled with an upgrade hint below the minimum agent version. The route requires `devices.execute` and MFA, and writes an audit entry.
- **Device detail:** a Vendor updates section in `DevicePatchStatusTab.tsx`: last run, outcome, tool version, installed items, reboot state.
- **Fleet:** a Vendor updates view next to Patch compliance, with counts and a filterable list for Up to date, Overdue, Failing, Not supported and Not managed.
- **Mutations:** use `runAction`. New strings go in all 8 locales.

## 5. Vendor lanes

Each lane is one small module behind the same interface. It reaches customers only after its lab leg passes. Until its BIOS and firmware gate passes, the manifest forces those categories off for that lane, whatever the policy says, and the UI says so.

### Dell (W1, the only lane Todd has run)
- **Tool:** DCU, currently 5.7.2 for Intel/AMD (vendor doc).
- **Run:** `dcu-cli /applyUpdates -silent -reboot=disable -autoSuspendBitLocker=enable -outputLog=<path>`, plus category filters.
- **Floor:** at least 5.7.1 (DSA-2026-309).
- **Don't install from winget.** Its latest DCU is 5.7.0, below the fix (observed). Use Dell's pinned URL. URLs change per release (observed).
- **Prerequisite:** .NET Desktop Runtime ≥ 10.0.8. A silent install can end without it, with the reason only in a log (vendor doc).
- **Exit codes (5.x guide):** 0 success; 1 reboot required; 5 reboot pending, so reboot first and don't re-run; 500 no updates; 3 and 7 not supported; 6 and 3003–3005 retry later; 1000–1002 and 501–503 failed.
- **Lab gate:**
  - capture a real report and apply log (the report schema and whether `-report` takes a file or folder are not confirmed)
  - confirm the §4.5 reboot behaviour
  - confirm the install on a clean machine, including whether Dell's download host accepts the agent's client
  - record what happens with a BIOS password set
  - record what happens alongside Dell Update and SupportAssist (conflict claims are third-party only, so Breeze detects and reports them and doesn't remove anything)

### Surface (W4)
- **Tool:** none. There's no vendor CLI that research could find (not confirmed as a negative). This lane installs no software.
- **Run:** the existing Windows Update API: search `Type='Driver' and IsInstalled=0 and IsHidden=0`, filter `IWindowsDriverUpdate` properties to Surface updates, then install. It extends `agent/internal/patching/windows.go`.
- **Not v1:** per-model MSIs. They are large (about 975 MB), Microsoft describes them for imaging and controlled deployments, and there's no documented feed.
- **Facts:** firmware can't be rolled back, and capsules are blocked if BitLocker isn't bound to PCR 7 (vendor doc).
- **Lab gate:**
  - how Surface updates identify themselves (`DriverClass` strings not confirmed)
  - behaviour under `ExcludeWUDriversInQualityUpdate`
  - BitLocker through a firmware update, after which the firmware gate can open

### HP (W5)
- **Tool:** HP Image Assistant (HPIA), currently 5.3.7 (vendor doc); floor at least 5.3.3 (other source, CVE-2025-13492).
- **Run:** `HPImageAssistant.exe /Operation:Analyze /Action:Install /Category:<list> /Selection:All /Silent /ReportFolder:<d> /SoftPaqDownloadFolder:<d> /AutoCleanup`. HPIA has no reboot switch, so the agent acts on exit 3010.
- **BIOS:** starts off. The expected approach is CMSL with `-BitLocker suspend`; `docs/superpowers/specs/device-lifecycle/2026-09-10-hp-warranty-cmsl-design.md` covers the existing CMSL decisions and licensing. HP Sure Admin makes BIOS updates download-only (vendor doc).
- **Exit codes to handle:** 256 and 257 no updates; 3010 reboot; 3011 skipped; 3020 failed; 4096 not supported. Use `/IgnoreGenericOsError`, since 4104 otherwise masks 3010 and 3020.
- **Lab gate:** silent install switches, licence terms ("valid license from HP required", vendor doc), and the BIOS and BitLocker path.

### Lenovo (W6, starts with a spike)
- **Lenovo System Update is ruled out.** Its maintenance ended on 2026-10-31 and it reaches end of life on 2027-03-31 (vendor doc).
- **Tool undecided.** W6 starts with a spike on real ThinkPad and ThinkCentre hardware, then records the choice in this document before any lane code:
  - **Thin Installer:** a vendor tool, lifecycle and repository requirement not confirmed. `-noreboot` covers only type 3 packages; types 1 and 4 can force a reboot or shutdown themselves.
  - **LSUClient:** open source, not shown to be Lenovo-official, filters by unattended install, and never reboots. Using it means shipping or fetching a third-party PowerShell module with a pinned version.
  - **Commercial Vantage:** named successor, needs Lenovo Vantage removed, weekly default, and has its own CVEs. Least likely to fit.
- **BIOS:** starts off. Lenovo says Thin Installer BIOS installs "cannot be deployed in an unattended mode" (vendor doc), which conflicts with this feature's purpose.

## 6. Delivery

Register as a multi-wave feature once the plan is written. Per Todd's standing rule (2026-10-25), this queues behind features with waves already in flight.

| Wave | Content | Gate |
|---|---|---|
| W1 | Lane interface, `oem_update_run`, Authenticode check, firmware critical section, Dell lane, status table, command-result handling, not-returned alert, kill switches, Run Now route and button, device section | Dell lab gate on a real Dell laptop and desktop with BitLocker on |
| W2 | `oem_updates` feature, policy tab, scheduler worker, catch-up, schedule takeover and release, §4.6 exclusions, overnight reboot mode | Scheduled overnight run on a lab device, including a missed night and a policy removal |
| W3 | Fleet view, overdue alerts, docs and release notes | Prod canary on OliveTech Dells, then the flag turns on more widely |
| W4 | Surface lane | Surface lab gate |
| W5 | HP lane | HP lab gate |
| W6 | Lenovo spike, then lane | Lenovo lab gate |
| Later | AI access as a Tier 3 `manage_patches` action | Not v1 |

W1 alone delivers the troubleshooting win. W1 and W2 deliver the prevention win for Dell.

**Availability.** From W1, the route and the scheduler sit behind a default-off env flag, `BREEZE_OEM_UPDATES_ENABLED`, following `BREEZE_WISP_ENABLED`, with an optional partner allowlist for the canary. Self-hosters opt in with the same flag. It must be mapped in the compose templates, and the kill switches ship with W1 because Run Now can flash a BIOS from that wave on.

**Risk class:** high. This code ships to customer machines, runs as SYSTEM and flashes firmware. It gets full process, and agent changes need `go test -race`. Non-Dell lanes are not enabled on the strength of mock tests. Tests must feed captured real tool output to the parsers.

## 7. Left to the builder

- Table and file names beyond those fixed above, the worker's query shape at 10,000+ agents, and whether the scheduler reuses part of `patchSchedulerWorker`.
- Copy, and exact layout of the UI within the patterns named.
- How to warn when a new tool version ships. A scheduled check of vendor pages is acceptable but not required.
- Whether a System Restore checkpoint wraps a run (`newCommandCheckpoint` exists).

## 8. Resolved questions (Todd, 2026-10-31)

1. **Laptops that are asleep or off every night:** a scheduled run never starts outside the window, and there are no wake timers. These laptops show as Overdue, and a tech uses Run vendor updates. The W3 fleet view will show how many are affected before anyone considers a daytime path.
2. **Lab hardware:** buy used test units for W4–W6: a Surface, an HP business laptop, and a Lenovo ThinkPad and ThinkCentre. No BIOS or firmware test runs on a machine anyone relies on. The units must be on hand before each vendor's lab gate.
