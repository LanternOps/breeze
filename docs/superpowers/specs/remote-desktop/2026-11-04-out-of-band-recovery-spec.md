---
title: Out-of-band recovery — Intel AMT management and a remote recovery environment for unbootable Windows devices
status: draft for review
date: 2026-11-04
owner: Todd
tracking_issue: LanternOps/breeze#11024
related: "#5493 (bare-metal recovery), #9200 (Redfish from a site probe), #8950 (designated site probes), #4978 (IP-KVM), #10838 (Wake-on-LAN management), #6854 (hardware monitoring, in-band BMC)"
---

# Out-of-band recovery

## 1. Problem

When a Windows device stops booting, Breeze loses it. A bad update loops the boot, a BitLocker recovery screen waits for a key, a partition or BCD store is damaged, or a local account is locked. The agent never starts, so every Breeze tool is gone and the MSP drives to site.

A design-partner MSP asked for three things:

1. Intel AMT/vPro management (and iLO/iDRAC on servers): discovery, provisioning state, power control, KVM and boot redirection, with credentials stored per customer.
2. A Breeze recovery environment that can be reached remotely and driven from the console for the common repairs: remove the offending update, reset local users, repair the boot partitions, unlock BitLocker.
3. A clear statement of what is possible without AMT, using only the agent and Windows RE (WinRE).

The third point decides how useful the feature is. AMT with KVM needs a vPro SKU (Intel Standard Manageability supports power and boot management but has no KVM, per Intel's published feature matrix; not lab-checked), a network path to the AMT interface while the OS is down, and provisioning that most SMB fleets have never done. WinRE ships on nearly every Windows 10/11 device and Windows already boots into it automatically after repeated boot failures. **This spec therefore treats the agent + WinRE path as the broadest tier and AMT as the higher tier for the machines that have it. The WinRE path is gated on a feasibility wave (§7) because its hardest parts — a background hook, WinRE servicing, BitLocker — are unproven.**

### What exists today (verified on `origin/main` at `36f9d9ca53`)

| Capability | State | Where |
|---|---|---|
| AMT / ME / MEI / vPro / LMS / CIRA / WS-Man | **Nothing.** No code or docs match. | — |
| In-band BMC detection (iDRAC/iLO/XCC/IPMI) | Shipped, read-only, no credentials | `agent/internal/collectors/hwhealth/bmc*.go` → `device_hardware_components` (`component_type='bmc'`, `apps/api/src/db/schema/hardwareHealth.ts`); `redfish` is a reserved `hardware_source` value nothing emits |
| TCP tunnel through an agent to a LAN host | Shipped | `apps/api/src/routes/tunnels.ts` (`type: 'vnc' \| 'proxy'`, `proxy-connect` to a discovered asset via a bridge agent), `tunnelWs.ts`, agent `agent/internal/tunnel/tunnel.go`; default-deny `tunnel_allowlists` (`CIDR:portRange`, site-scoped) and hardcoded loopback/link-local blocks (`tunnels.ts` `BLOCKED_CIDRS`, `agent/internal/tunnel/allowlist.go`) |
| Browser and desktop RFB (VNC) client | Shipped | noVNC in `apps/web/src/components/remote/VncViewer.tsx` / `VncViewerPage.tsx` and `apps/viewer/src/lib/transports/vnc.ts` |
| Relay selection "online peer, same site, same subnet" | Shipped | `selectRelay` in `apps/api/src/services/wakeOnLan.ts`, with `relayDeviceIdOverride` and named error codes |
| Safe Mode with networking reboot | Shipped | `agent/internal/safemode/safemode_windows.go`, `reboot_safe_mode` command |
| WinRE / `reagentc` / boot-to-recovery | **Nothing.** The BMR rebuild recreates the WinRE partition empty (`agent/internal/backup/rebuild/win_encryption.go`) | — |
| Breeze WinPE recovery console (BMR) | Console + engine shipped; media builder spec-only | `agent/internal/recoveryconsole/`, `agent/cmd/breeze-backup/recovery_console_host_winpe.go`; spec `docs/superpowers/specs/backup/2026-09-10-bare-metal-boot-media-recovery-design.md` §7.2, plan `plans/backup/2026-10-03-bare-metal-w07-windows-winpe-media.md` |
| BitLocker recovery-key escrow + audited reveal | Shipped | `device_recovery_keys`, `recovery_key_access_events` (`schema/recoveryKeys.ts`); reveal `routes/security/recoveryKeys.ts` (`devices:read` + `requireMfa()` + rate limit + ledger) |
| Secret encryption | Shipped | `services/secretCrypto.ts` (AES-256-GCM, `enc:v3` with AAD), `services/encryptedColumnRegistry.ts` (`aadBinding: 'row'`) |
| Org-XOR-partner encrypted secret precedent | Shipped | `tenant_variables` (`schema/tenantVariables.ts`, `services/tenantVariables.ts`) |
| Per-site collector holding an encrypted local key | Shipped | `unifi_collectors` (`schema/unifi.ts`) |
| Agent credential roles | `agent \| watchdog` | `AgentCredentialRole` in `apps/api/src/middleware/agentAuth.ts`; hashes on `devices` |
| Operation-bound step-up | Shipped | `services/mfaStepUpGrant.ts` (`StepUpOperation`, e.g. `device_force_reboot`) |

## 2. Users and scope

- **Partner (MSP) technicians** are the primary users. They define the policy once for every customer (partner-wide config policy feature), hold a partner-wide AMT credential default, and run recovery sessions on any device they can reach.
- **Org-scoped users** (an internal IT team, or a customer's own admin with MSP-granted rights) can run recovery sessions on their org's devices, override the AMT credential default for their org, and link their own policy. They never see partner-wide secrets in plaintext.
- **End users** see nothing new on a healthy machine. In WinRE, the Breeze recovery hook runs in the background and never replaces the WinRE UI an on-site person sees.
- **Platforms:** Windows 10/11 x64 for the recovery environment. AMT detection runs on Windows and Linux agents (both expose the MEI; macOS has no AMT). Servers with iDRAC/iLO are covered by #9200; this spec defines the shared controller model they will use.

## 3. Proposed design

Three tiers, one device-page surface ("Recovery and out-of-band"), one readiness signal.

| Tier | Needs | Reaches | Can do |
|---|---|---|---|
| 0 — online repair | agent running | OS that still boots | existing scripts, Safe Mode with networking, restore points, BitLocker key reveal, plus the new "Restart into recovery" |
| 1 — Breeze recovery hook in WinRE | agent once (to stage), WinRE enabled, wired network | device that fails into WinRE, or one sent there by tier 0 | remote terminal + curated repairs (§3.4) |
| 2 — Intel AMT | vPro SKU, AMT provisioned, TLS, a reachable relay agent on the LAN | powered-off, hung, or pre-boot device (BIOS, BitLocker prompt) | power on/off/reset, KVM, one-time boot to WinRE/BIOS/PXE; later boot redirection |

Tier 1 and tier 2 compose: AMT can power-cycle a hung box into WinRE, where the hook takes over; AMT KVM types the BitLocker recovery key at the pre-boot prompt that tier 1 cannot reach.

### 3.1 Detection and readiness (agent, read-only)

**AMT probe** (`agent/internal/oob/amt/`, Windows + Linux amd64):
- Opens the MEI (HECI) interface — on Windows the Intel MEI driver's device interface, on Linux `/dev/mei0` — and issues the read-only host commands for AMT version, SKU / feature flags (KVM present), provisioning state (pre / in / post), control mode (none / CCM / ACM), DNS suffix, wired LAN settings (DHCP or static, IPv4, MAC, shared vs dedicated), and the AMT TLS certificate hash when TLS is configured (read locally through LMS, never over the network).
- Implementation reuses Intel's open-source Go code (`rpc-go` host-command packages and `go-wsman-messages`, Apache-2.0) vendored as a library, not shelled out to a separate binary (Open Decision 7).
- No MEI device, driver missing, or non-Intel → `status: not_present` with the reason. The probe never writes to the ME in this tier.

**WinRE probe** (`agent/internal/recoveryenv/`, Windows):
- `reagentc /info` (enabled, location, BCD identifier), BCD values that decide whether Windows ever reaches WinRE on failure (`recoveryenabled`, `recoverysequence`, `bootstatuspolicy` on `{current}`), recovery-partition size and free bytes, `winre.wim` SHA-256 and version, whether the image carries network support, and BitLocker protector types on the OS volume (already partly collected by the key escrow collector).
- Reasons are first-class (`winre_disabled`, `bootstatuspolicy_ignores_failures`, `recovery_partition_too_small`, `wifi_only`, …) so readiness explains itself, as the BMR restorability guard does.

**Readiness** is computed server-side per device from the two probes and shown as one card on the device page and as a fleet filter/report column: `tier1: ready | not_ready(reasons) | not_applicable`, and tier 2 per capability, not as one flag — `power`, `boot_control`, `kvm` each `ready | needs_consent | adoptable | provisionable | not_capable` (an ISM device can be `power: ready, kvm: not_capable`). "WinRE installed" alone never counts as tier 1 ready: tier 1 is ready only when the hook is staged and its last self-check passed. A device with no online relay candidate at its site reports `tier2: no_relay` rather than ready. The existing `recovery_readiness` table (`schema/backupVerification.ts`) is backup-RTO scoring and stays separate; its `risk_factors` may later cite these reasons.

Cadence: the probes are cheap and slow-changing. They run at agent start, daily, and after Windows servicing events, and report through a new heartbeat sub-payload gated on availability (the #10911 probe-gating pattern).

### 3.2 Tier 0 additions (agent, no new environment)

- **Restart into recovery** — new command `reboot_to_winre`: `reagentc /boottore` then reboot. One-time; the next boot goes to WinRE and the following one returns to Windows. Requires WinRE enabled. New step-up operation `device_reboot_to_recovery` with its own digest; the existing `device_force_reboot` digest binds only the device id and must not be reused for a different action.
- **Suspend BitLocker for one reboot** — `manage-bde -protectors -disable <os-volume> -RebootCount 1` (the OS volume is discovered, never assumed to be `C:`), offered on the Restart-into-recovery dialog and on firmware/BIOS change flows, so a planned recovery does not land on the BitLocker prompt. Its own step-up operation `bitlocker_suspend_once` (it lowers the device's at-rest protection for one boot).
- Existing Safe Mode with networking stays as is.

### 3.3 Tier 1 — the Breeze recovery hook in WinRE

**What is staged.** When the `out_of_band_recovery` policy feature enables the hook (§3.6), the agent:
1. Mounts the device's own `winre.wim` (DISM, offline) into a scratch directory on the OS volume.
2. Adds a slim, Authenticode-signed `breeze-recovery.exe` (a new Go binary built from the existing `agent/internal/recoveryconsole` code plus a WinRE transport; target < 15 MB), the CA roots and server URL the BMR WinPE media already carries, and the device's **recovery credential** (below).
3. Adds a launch hook so the binary starts in the background whenever WinRE boots and **then starts the normal WinRE shell unchanged**. `winpeshl.ini` runs its entries sequentially and waits for each to exit, so the entry must be a small launcher that detaches the hook and returns; a resident process in that list would block the WinRE UI. This mechanism is unproven and is the first thing the feasibility wave (§7, wave 3) must demonstrate on Windows 10 22H2, Windows 11 23H2/24H2 and an OEM-customised WinRE.
4. Re-captures the image, verifies it, and swaps it in crash-safely (`reagentc /disable` → copy → `/setreimage` → `/enable`, with a journal so an interrupted swap is detected and finished or rolled back at the next agent start). The rollback image is the **current** Microsoft image captured at staging time; if Windows services WinRE after staging, the old copy is discarded and never restored, because restoring it would undo a WinRE security update.

**Guards (all refuse with a named reason, nothing half-written):**
- Free space after staging must keep Microsoft's servicing headroom (target ≥ 250 MB free on the recovery partition; exact threshold an Open Decision input). The agent never resizes partitions. A small recovery partition is the same failure that made a 2024 WinRE security update fail on many devices, and Breeze must not cause it.
- Staging is skipped while a WinRE servicing update is pending, and re-applied after one lands: the agent compares the live `winre.wim` hash with the staged hash at start, daily, and on a servicing event; a mismatch means Windows replaced the image, readiness drops to `not_ready(hook_stale)` immediately, and the agent re-stages. The window between a servicing update and the re-stage is a known gap and is shown, not hidden.
- If a WinRE servicing failure is detected after staging, the agent restores the current rollback image and marks the device `hook_withdrawn(servicing_conflict)`.
- Modifying the image may change how WinRE is measured and stop it auto-unlocking a TPM-protected OS volume (inferred from Microsoft's BitLocker recovery documentation; not lab-checked). The feasibility wave must record auto-unlock behaviour before and after staging; it decides Open Decision 3.
- Disabling the feature, uninstalling the agent, or moving the device out of an org whose policy enables it un-stages the hook (restore original image, revoke the credential).

**Recovery credential.** A new agent credential role `recovery` (extending `AgentCredentialRole` in `middleware/agentAuth.ts`). The server mints it at staging time; only its hash is stored (§4). It is deliberately narrow because it sits on an unencrypted partition:
- It can open one WebSocket as "device X in recovery", post readiness facts about the environment, and receive commands from a **fixed allowlist** (§3.4). It cannot fetch config, scripts, secrets, other devices, or anything a normal agent token reaches. Today the agent auth path lets a token claim any command (`middleware/agentAuth.ts`), so the allowlist must be a positive check enforced on every agent surface — WebSocket, HTTP polling, heartbeat and command-result submission — with a 403 matrix test per surface.
- Each announce is visible on the device page ("In recovery environment since …") and raises an informational alert; nothing runs until a technician opens a session.
- It is rotated on every re-stage and revoked on un-stage, device retirement, or device move to another partner.

**BitLocker.** When WinRE cannot auto-unlock the OS volume it prompts for the recovery key. Sending an escrowed full-disk key to an environment that authenticates with a bearer credential copied from an unencrypted partition is the riskiest part of this design. A protector ID is not secret, so matching it proves nothing. **No key is released over the recovery credential alone**; Open Decision 3 decides what additional proof is required, after the feasibility wave. Whatever is chosen, a release:
- reuses the existing ledger (`recovery_key_access_events`) and audit entry, but not `requireMfa()` alone, which only checks the session meets the tenant's MFA policy (`middleware/auth.ts`). It consumes a step-up grant (`recovery_key_release`) whose digest binds device, protector ID, recovery session id, a server challenge and the action;
- is delivered as a transient, encrypted, single-use payload. `device_commands.payload` is plaintext unless explicitly protected (`services/sensitiveCommandPayload.ts`), so the key never sits in that column; it is not echoed in results or transcripts; replay is refused;
- shows the technician which device, recovery session, source IP and hook version is asking before they confirm.

Until that is settled, BitLocker-protected devices whose WinRE cannot auto-unlock are reachable in tier 1 for reporting and boot repairs that do not need the OS volume, and need tier 2 KVM or someone on site to type the key.

**Network.** Wired Ethernet with inbox WinRE drivers is the supported path in the first release. Wi-Fi either reuses a profile through a mechanism Windows itself supports in WinRE (Microsoft's WinRE technical reference describes profile reuse; version-specific, not lab-checked) or would require writing the device's Wi-Fi key into the image on an unencrypted partition. Neither ships until validated (Open Decision 4). Proxy settings are copied from the agent's config.

**What tier 1 cannot reach:** the BitLocker pre-boot recovery screen (it runs before the boot manager hands off to WinRE), firmware/POST hangs, a dead disk, devices whose image disabled WinRE or set `bootstatuspolicy IgnoreAllFailures` (readiness reports both, and the policy can optionally fix them — Open Decision 5), and Wi-Fi-only devices without the opt-in.

### 3.4 The recovery console (tier 1 session)

A technician opens "Recovery console" from the device page while the device is in recovery. The session uses the existing command pipeline: commands are rows in `device_commands`, dispatched over the recovery WebSocket, results returned the same way. One console session per device holds a lock, so two technicians cannot issue conflicting disk operations; a second technician can watch read-only. The `remote_access` policy's session limits and consent setting apply to the console. Windows and EFI volumes are discovered from the environment report (drive letters differ in WinRE); the `C:` in the table below is illustrative. The `recovery` role's allowlist:

| Action | Implementation | Guard |
|---|---|---|
| Environment report | volumes, BitLocker state, Windows build, last boot failure code (`bcdedit /enum`, SrtTrail log), pending update actions | read-only |
| Unlock BitLocker volume | `manage-bde -unlock -RecoveryPassword` with the released key | step-up `recovery_key_release`, ledger |
| Revert pending update actions | `DISM /Image:C:\ /Cleanup-Image /RevertPendingActions` | confirmation |
| Remove a specific update package | `DISM /Image:C:\ /Get-Packages` → pick → `/Remove-Package` | confirmation; list shown first |
| Rebuild boot files | `bcdboot C:\Windows` (UEFI) with a pre-change BCD export kept in the session log | confirmation |
| Disk / file check | `chkdsk C: /f`, `sfc /scannow /offbootdir=C:\ /offwindir=C:\Windows` | confirmation |
| Schedule a one-shot repair at next boot | offline `SYSTEM\Setup` `CmdLine` / `SetupType` so Windows runs a Breeze-provided repair (re-enable the agent service, reset a named local account's password to a generated value escrowed back to Breeze) as SYSTEM once. The original values are saved first; the repair restores them itself, and the agent verifies and restores them on its next start if the repair crashed, so the hook cannot persist past one boot | step-up; the generated password is shown once via the action-intent one-time reveal (`routes/actionIntents.ts` `reveal-secret`) |
| Hand off to bare-metal rebuild | launch the BMR Windows engine against this disk with the BMR consent flow (`bare_metal_recoveries`) | BMR's own guards |
| Exit and boot Windows | `wpeutil reboot` | — |
| Remote terminal | line-mode `cmd.exe` over the session (no ConPTY in WinPE) | `remote:access` + separate permission (Open Decision 6); full transcript in the audit log |

Every action writes an audit entry (`device.recovery.<action>`) with the session id, the technician, and the command result. Destructive curated actions (package removal, `bcdboot`, `chkdsk /f`, one-shot repair) need the same elevated permission as the terminal (§3.7), not only `remote:access`. The curated actions are the product; the raw terminal is the escape hatch. Terminal transcripts are redacted of released secrets before they are stored.

AI tools: read-only (`get_recovery_readiness`, `get_recovery_environment_report`) in the first release; no AI-initiated recovery actions. Any later write tool goes through action intents.

### 3.5 Tier 2 — Intel AMT

#### 3.5.1 Controller model and credentials

One `device_oob_controllers` row per management controller per device (§4). `kind` is `intel_amt` now; `redfish` (iDRAC/iLO/XCC) is reserved so #9200 lands on the same table, links the in-band `bmc` hardware component by key, and reuses the credential, transport and audit design below.

Credential resolution follows the settings contract: **partner default → org override → snapshot on the controller row.**
- `oob_credential_profiles` holds the shared AMT admin credential an MSP typically used across a fleet it provisioned before Breeze. It is org XOR partner (§4).
- When a controller is **adopted** (AMT already provisioned by someone else), the gateway verifies the resolved credential against the device once and, on success, **rotates the AMT admin password to a per-device generated value** and stores only that on the controller row (row-bound AAD). A snapshot of the shared ciphertext would not isolate anything: an org admin revealing "this device's" password would learn the password used across the MSP's other customers. Rotation also means a later edit to the default never breaks adopted devices. If rotation fails, the controller stays `adopted_shared` and its credential cannot be revealed by anyone below partner scope with `remote:out_of_band`.
- A device moved to another org in the same partner keeps its per-device credential. A move to another partner first rotates the credential (or withdraws the controller if the device is offline) so the source partner's knowledge of it ends.
- When **Breeze provisions** a controller (wave 7), the admin password is generated per device, never shown, and stored only on the row. Breeze also creates a second AMT digest user with only the redirection, KVM and power realms and uses it for day-to-day sessions; the admin credential is used only to change configuration.
- Plaintext never leaves the server. The relay agent never sees an AMT credential (§3.5.2). Revealing the admin password is an explicit, step-up-gated action (`oob_credential_reveal`) with an audit entry, for the day the MSP needs to enter MEBx by hand.

#### 3.5.2 Transport: a relay agent and a server-side gateway

AMT's network interface answers on TCP 16993 (TLS WS-Man) and 16995 (TLS redirection: KVM, SOL, storage redirection). When the OS is down, Breeze needs some machine with a route to that interface. In the first release that is another Breeze agent on the device's network (a deployment choice, not an AMT limit: CIRA or a routed management network would also work).

- **Two parties, authorized separately.** The existing tunnel route requires the target device to be online and evaluates that device's policy (`routes/tunnels.ts`). An AMT session inverts this: the **target controller** belongs to a device that is usually offline, and the **relay** is a different, online device. The session authorizes the technician against the target device (permission, site scope, `remote_access` policy) and the relay against its own policy and site, and fails if either refuses.
- **Relay agent.** The session picks an online agent at the device's site, using the `selectRelay` ranking from `services/wakeOnLan.ts` (same site, same subnet first). Unlike WoL, a relay override must stay inside the target's site. When #8950's designated site probes ship, a designated probe is preferred and pinned relays fail closed, as #8950 requires. No candidate → `no_relay`, said plainly.
- **Tunnel type `oob_amt`.** The relay opens a raw TCP connection through the existing tunnel subsystem. The target host comes only from the controller row (the AMT address the device's own agent last reported through the MEI); ARP/MAC lookups from the relay are a hint for a changed DHCP lease, never authorization. The port is 16993 or 16995 only, the server issues the relay an exact, expiring `ip:port` grant for that session, and the existing loopback/link-local blocks stay in force. The client never supplies a host or port, so this type cannot be used as a generic LAN pivot.
- **Gateway.** The server side of that tunnel terminates TLS to AMT, pinning the certificate hash the device's own agent reported through LMS (never trust on first use over the network). The pin is what actually proves the relay reached the right controller: a stale or spoofed address fails the TLS check and the session stops. The gateway performs HTTP Digest, speaks WS-Man for power and boot actions, and speaks Intel's redirection protocol for KVM, exposing plain RFB to the existing noVNC viewer. Credentials, TLS and protocol parsing live in one place, which is also where CIRA would terminate later. Where the gateway process runs is Open Decision 2.
- **TLS only.** Non-TLS ports 16992/16994 are refused in the first release; a controller without TLS reports `not_ready(tls_not_configured)` and becomes ready when Breeze provisions it.
- **CIRA** (AMT dials out to a Management Presence Server, which reaches laptops off-site) is out of scope for the first release; `transport` on the session leaves room for it (Open Decision 8).

#### 3.5.3 Actions

| Action | WS-Man | Guard |
|---|---|---|
| Read power state, AMT event log | `CIM_AssociatedPowerManagementService`, `AMT_MessageLog` | `remote:access` |
| Power on | `RequestPowerStateChange(2)` | `remote:access`; refuse if the device is online through its agent (same rule as #10838 wake) |
| Graceful off / hard off / reset / power cycle | `RequestPowerStateChange(12 / 8 / 10 / 5)` | new permission (Open Decision 6) + step-up `oob_power_action` + typed confirmation for hard off on servers |
| One-time boot to BIOS setup, PXE, local WinRE | `AMT_BootSettingData` + `CIM_BootConfigSetting`; WinRE via AMT One Click Recovery only where the controller reports it (Intel documents it from CSME 15 / 11th-gen platforms, subject to OEM enablement; not lab-checked) | as power actions; in CCM, boot-option changes also need the user-consent code |
| KVM session | redirection protocol → RFB → noVNC (web `VncViewerPage.tsx`, viewer `transports/vnc.ts`) | `remote:access` + `remote_access` policy gate; if the controller is in CCM, AMT requires the six-digit user-consent code shown on the device's screen — the viewer prompts for it (someone on site reads it out); in ACM the consent policy can be "none" |
| Boot from Breeze media over the network (storage redirection or One Click Recovery HTTPS boot) | later wave (§7) | — |

KVM shares the remote session's audit, idle timeout and maximum duration from the `remote_access` policy (`services/remoteAccessPolicy.ts`), and a session row in the existing tunnel/session tables.

#### 3.5.4 Provisioning

| Mode | What Breeze does | Result |
|---|---|---|
| **Adopt** | AMT already provisioned. The technician (or the policy, using the partner/org default) supplies the credential; the gateway verifies it over the relay and pins TLS. | power + KVM per the existing consent policy |
| **CCM activation** (wave 7) | The agent activates Client Control Mode locally through LMS/MEI (rpc-go code path), sets the generated admin password, enables TLS with a firmware-generated certificate, enables KVM and redirection, creates the restricted ops user, reports the cert hash. | power works; KVM, redirection and boot-option changes need the on-screen consent code (CCM limitation) |
| **ACM activation** (wave 8) | The MSP uploads an AMT provisioning certificate (from a CA Intel's firmware trusts, matching the network's DNS suffix). The agent relays the ME's activation nonce; **the server signs it**, so the certificate's private key never reaches an endpoint. | full unattended power, KVM, boot control |

Unprovisioning (`full unprovision`) is offered for devices leaving management and runs automatically when a Breeze-provisioned device is retired, so a decommissioned laptop does not leave with a firmware admin password only Breeze knows.

### 3.6 Settings and policy

- **New config policy feature `out_of_band_recovery`** (partner-linkable, added to `CONFIG_FEATURE_TYPES` in `packages/shared/src/constants/configFeatureTypes.ts`, `configFeatureTypeEnum`, `PARTNER_LINKABLE_FEATURE_TYPES`, `featureConfigResolver.ts`, web `featureTabs/types.ts`; the `containment` feature is the latest precedent). Inline settings, Zod-validated with safe defaults in the style of `remoteAccessInlineSettings.ts`:
  - `recoveryHook: boolean` (default `false`)
  - `recoveryHookWifi: boolean` (default `false`; not selectable until Open Decision 4 is settled)
  - `repairWinreReachability: boolean` (default `false`; Open Decision 5 — when on, the agent saves the original values, skips settings another management tool owns, and verifies the result)
  - `amtProvisioning: 'off' | 'adopt' | 'ccm' | 'acm'` (default `off`; `ccm`/`acm` only selectable once those waves ship)
- **`remote_access` feature** gains `amtKvm: boolean`, `amtPower: boolean` and `recoveryConsole: boolean`. All three default to **`false`, and an absent value in an existing policy means `false`**: a policy written to close every current transport must not silently open a new one at upgrade. Rationale: `remote_access` is the one home for "which remote transports may be used"; `out_of_band_recovery` is the one home for "what the agent changes on the device". Open Decision 1.
- **AMT credential defaults** live at Settings → Remote access → Out-of-band credentials, partner page with an org override (blank = inherit, inherited value's source shown, value never shown). Home: Remote access. Level: partner default → org override → snapshot on the controller. Resolver: `services/oobCredentialResolver.ts` (one function used by adopt and by the policy-driven auto-adopt). Places configured: 0 before, 1 after.
- Detection has no setting; it is read-only and always on where the probe is available.

### 3.7 Permissions and step-up

- Read readiness and controller state: `devices:read`.
- Open a recovery console, KVM session, power on, read AMT state: `remote:access`.
- Destructive tier 2 power actions, destructive curated repairs, the raw recovery terminal, adopting or provisioning a controller, editing credential defaults: a new `remote:out_of_band` permission (Open Decision 6), plus MFA.
- New `StepUpOperation`s in `services/mfaStepUpGrant.ts`, each with its own canonical digest (device id plus the action's subject: protector + session + challenge for key release, controller + action for power): `device_reboot_to_recovery`, `bitlocker_suspend_once`, `oob_power_action`, `recovery_key_release`, `oob_credential_reveal`, `recovery_account_reset`.

## 4. Tenancy and data-model impact

All new tables get RLS enabled + forced + policies in the creating migration. Migrations sort after the newest committed migration (currently a `2027-01-20-…` name) and are idempotent.

### 4.1 `device_oob_controllers` (shape 1, org_id + device_id)

`id`, `org_id`, `device_id` (composite FK `(device_id, org_id) → devices(id, org_id) ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE`, as the org-merge contract requires), `kind` (`intel_amt` | `redfish`), `hardware_component_key` (nullable, for redfish ↔ `bmc` link), detection facts (`fw_version`, `sku`, `kvm_capable`, `provisioning_state`, `control_mode`, `dns_suffix`, `lan_mac`, `lan_ipv4`, `lan_dhcp`, `tls_cert_sha256`, `consent_policy`, `ocr_supported`, `last_detected_at`), management state (`management_state`: `detected` | `adopted_shared` | `adopted` | `breeze_provisioned` | `withdrawn`, `credential_source`: `profile_shared` | `rotated` | `generated` | `manual`, `admin_username`, `admin_password_encrypted`, `ops_username`, `ops_password_encrypted`, `last_verified_at`, `last_error`), `capabilities` jsonb, timestamps. Unique `(device_id, kind)`.

Registrations:
- `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`), `orgMergeRegistry.ts` (`repoint`), `CORE_TENANT_EXPORT_POLICY` (`tenantExportPolicyRegistry.ts`): both `*_password_encrypted` → `excludedSensitive`; `capabilities` → `excludedOpen`; every other column classified explicitly in the plan, with names that match `SUSPICIOUS_NAME_PARTS` (`credential_source`, `admin_username`, `ops_username`, `tls_cert_sha256`) as `reviewedIncluded` with the reason. No "the rest included" shortcut.
- `CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES`, and `DEVICE_ORG_FK_CASCADE_TABLES` (database restamp: the credential is in the device's firmware, so it follows the device).
- `encryptedColumnRegistry.ts` entries with `aadBinding: 'row'` for both password columns.

### 4.2 `oob_credential_profiles` (org XOR partner, partner-wide-first playbook)

`id`, `partner_id` (nullable FK), `org_id` (nullable FK), `kind`, `username`, `password_encrypted` (row-bound AAD), `description`, `version`, `created_by`, timestamps. `oob_credential_profiles_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL))`; partial unique indexes on `(partner_id, kind)` and `(org_id, kind)`.

- One dual-axis policy (`system OR org-access OR partner-access`) plus the separate `FOR SELECT`-only partner read branch (`org_id IS NULL AND partner_id = breeze_current_partner_id()`, template `2026-10-05-110000-config-policy-partner-wide-select.sql`) so an org-scoped adopt can resolve the partner default server-side. Plaintext is never returned by any route regardless.
- `DUAL_AXIS_TENANT_TABLES` in `rls-coverage.integration.test.ts`; writes gated on `canManagePartnerWidePolicies` for partner rows; `ownerScope` create field.
- Org rows: cascade order, merge registry (two orgs with an override for the same `kind` collide on the unique index — policy keeps the surviving org's row; must be stated in the registry entry), export policy (`password_encrypted` → `excludedSensitive`, `username` → `included`).
- Encrypted-column registry entry, `aadBinding: 'row'`.

### 4.3 `device_recovery_environments` (shape 1, org_id + device_id)

One row per device: WinRE facts (`winre_status`, `winre_location`, `winre_wim_sha256`, `winre_version`, `recovery_partition_free_bytes`, `recovery_enabled`, `boot_status_policy`, `network_capable`, `wifi_only`, `last_probed_at`), hook state (`hook_state`: `absent` | `staged` | `stale` | `withdrawn`, `hook_version`, `staged_wim_sha256`, `staged_at`, `withdrawn_reason`), the recovery credential (`recovery_token_hash`, `previous_recovery_token_hash`, `recovery_token_issued_at`), presence (`in_recovery_since`, `last_announce_at`, `last_announce_ip`, `environment_report` jsonb), `readiness_reasons` text[], timestamps.

Registrations: same lists as §4.1 (database restamp via a `DEFERRABLE INITIALLY IMMEDIATE` composite FK). Export policy: `recovery_token_hash` and `previous_recovery_token_hash` → `excludedSensitive`; `environment_report` → `excludedOpen`; `recovery_token_issued_at` → `reviewedIncluded`; every other column classified explicitly in the plan. The token hash columns are hashes, not ciphertext, so no encrypted-column entry. An org move must also end any live recovery console and AMT session for the device (tested).

The `recovery` agent role reads its hash from this table instead of adding a fourth set of columns to `devices`.

### 4.4 Later-wave table (sketch only)

`oob_provisioning_certificates` (wave 8): org XOR partner (a customer with its own DNS suffix needs its own certificate), `pfx_encrypted` + `pfx_password_encrypted` (`excludedSensitive`), `dns_suffix`, `not_after`, `thumbprint`. Same partner-wide-first playbook. Specified in that wave's plan.

### 4.5 Unchanged / reused

- Commands and results: `device_commands` (system-scoped by design) with a recovery-role allowlist enforced on the WebSocket path.
- Sessions: the existing tunnel/session tables gain a `type` value; no new session table.
- Audit: `audit_logs` entries; BitLocker reveals keep using `recovery_key_access_events`.
- Org move: the hook credential is device-bound and survives an org move inside the same partner; a move to another partner revokes and re-stages it, and rotates or withdraws the AMT credential (§3.5.1).

## 5. Out of scope

- CIRA / an MPS service; AMT over Wi-Fi while the OS is down.
- AMD DASH and other vendor out-of-band stacks.
- Redfish implementation (#9200 owns it; this spec only reserves `kind: redfish` and the shared credential/transport/audit design).
- IP-KVM appliances (#4978).
- Graphical WinRE screen sharing from the hook (terminal and curated actions only).
- PXE boot infrastructure.
- Resizing or creating recovery partitions; repairing a missing WinRE image by downloading one (detected and reported only).
- AI-initiated recovery or power actions.
- macOS and Linux recovery environments (the BMR Linux live media remains a backup-restore tool).

## 6. Open Decisions

An independent advisor review (Codex, read-only, xhigh) was run on the first draft. Its factual corrections (One Click Recovery platform range, CCM consent covering boot-option changes, ISM capabilities, `winpeshl.ini` sequential launch, stale rollback images, plaintext command payloads, shared-credential leakage through snapshots, default-on transport flags, deferrable FKs, explicit export classification) are already folded into §3–§4. Where it disagreed with a recommendation, both positions are recorded below.

1. **Where the AMT transport toggles live.** (a) In the existing `remote_access` feature (`amtKvm`, `amtPower`, `recoveryConsole`) with device-changing behaviour in a new `out_of_band_recovery` feature; (b) everything in `out_of_band_recovery`. **Recommend (a)**: `remote_access` is already the single home for which remote transports are allowed, and its session limits must apply to AMT KVM and the recovery console too. *Advisor: agrees.*
2. **Where the AMT gateway runs.** (a) Inside the API process on the tunnel relay path; (b) a worker thread inside the API; (c) a separate `oob-gateway` service in the compose bundle with narrowly scoped, per-session authorization from the API; (d) on the relay agent, which receives the credential per session (the `vncPassword` precedent). **Recommend (c) from the first AMT wave.** The first draft accepted (b) as a stepping stone; the advisor argued a worker thread gives no isolation for protocol parsing and credential handling, and I now agree. (d) hands a firmware admin credential to a neighbouring workstation. Cost: one more service for self-hosters.
3. **What proof a recovery hook must give before a BitLocker key is released.** (a) Recovery bearer credential + technician-initiated session + protector-ID match + bound step-up; (b) additionally a TPM-resident key created at staging and a recovery-image integrity check, if WinRE's TPM stack supports it; (c) never send the key — it is typed through AMT KVM or read to someone on site. **Disagreement.** The first draft recommended shipping (a) with a (b) spike. The advisor rejected (a): a copied bearer token plus a non-secret protector ID authenticates neither the hardware nor the software, and TPM possession alone does not exclude malicious software on the real device. **Revised recommendation: do not ship (a). Ship (c) until the feasibility wave shows (b) works, then ship (b).** Also measure whether unmodified WinRE auto-unlocks the volume and whether the hook breaks that; if a hook can be staged without losing auto-unlock, key release is needed far less often. Needs Todd's call, because (c) means BitLocker devices with no AMT and no auto-unlock get only limited tier 1 help.
4. **Wi-Fi in WinRE.** (a) Wired only; (b) opt-in policy that writes the device's Wi-Fi profile, with its key, into the WinRE image; (c) a Windows-native profile-reuse mechanism, validated per Windows version. **Disagreement, resolved toward the advisor.** The first draft recommended (a) plus (b) as an opt-in; the advisor said ship wired-only and validate native reuse before embedding reusable network passwords. **Revised recommendation: (a) for the first release; spike (c); (b) only if (c) fails and a design partner asks.**
5. **Should the policy fix WinRE reachability** (`reagentc /enable`, reset `bootstatuspolicy` and `recoveryenabled`)? (a) Report only; (b) opt-in repair. **Recommend (b), default off**, saving original values, skipping settings another management tool owns, and verifying the result. *Advisor: agrees with those conditions.*
6. **Permission shape.** (a) Reuse `remote:access` for everything; (b) add `remote:out_of_band` for destructive power actions, destructive curated repairs, the raw recovery terminal, provisioning and credential defaults; (c) separate permissions for shell, power, credential administration and key release. **Recommend (b) now**, keeping (c) open if MSPs ask for finer roles. *Advisor: (b) as a minimum, (c) longer term.*
7. **How the agent carries AMT code.** (a) Vendor Intel's importable packages (`go-wsman-messages`, the MEI/host-command parts of `rpc-go`) from a pinned release behind an adapter; (b) ship Intel's `rpc` binary and shell out; (c) write our own MEI client. **Recommend (a)**, checking that the packages are importable without CLI internals and what they need from LMS. *Advisor: agrees.*
8. **CIRA.** (a) Out of scope now, revisit on demand; (b) plan it as a later wave. **Recommend (a)**, with readiness saying `no_relay` plainly so the gap is visible. *Advisor: agrees.*
9. **Wave order.** (a) Detection → tier 0 → tier 1 (hook, console) → tier 2 (AMT); (b) AMT first, as asked; (c) detection → tier 0 → a WinRE + BitLocker feasibility spike, with AMT adopt/power/KVM running in parallel while the spike decides tier 1. **Disagreement, resolved toward the advisor: recommend (c).** The first draft put all of tier 1 before AMT on the grounds that WinRE is on nearly every device. The advisor pointed out that an installed WinRE is not usable recovery coverage until the hook, servicing and BitLocker questions are answered, and tier 2 does not depend on them.
10. **Hook inside WinRE vs a separate Breeze WinPE boot entry.** (a) Inject the hook into the device's own `winre.wim` (inherits Windows' automatic failover, OEM storage drivers and BitLocker tooling; must survive servicing); (b) stage a Breeze WinPE image as a separate one-time BCD entry, used by "Restart into recovery" while WinRE stays the automatic failover target (needs the ADK media builder and its licence terms); (c) both. **Disagreement.** The first draft recommended (a). The advisor said not to commit until both are prototyped, and noted (b) need not replace Windows' failover target. **Revised recommendation: prototype both in the feasibility wave and decide on its evidence**; (a) remains the only one that helps a device that fails to boot on its own.

## 7. Test and rollout notes

### Waves (sketch)

1. **Detection + readiness** — AMT MEI probe (Windows, Linux), WinRE probe, `device_oob_controllers` (detection columns only) + `device_recovery_environments` (WinRE columns only), heartbeat sub-payload, per-capability readiness card, fleet column. Read-only.
2. **Tier 0** — `reboot_to_winre`, BitLocker one-reboot suspend, their step-up operations, UI.
3. **Feasibility spike (no shipping code)** — lab proof of the detached launcher in three WinRE variants, servicing after staging, crash-safe swap and rollback, BitLocker auto-unlock before/after staging, TPM-bound credential in WinRE, native Wi-Fi reuse, and the separate-BCD-entry alternative. Output: decisions 3, 4 and 10, written into this spec.
4. **Recovery hook staging** (if wave 3 passes) — `breeze-recovery.exe`, inject/verify/withdraw, servicing re-stage, `recovery` agent role with the positive allowlist on every agent surface, `out_of_band_recovery` feature, announce + presence.
5. **Recovery console** — allowlisted commands, console lock, curated actions, one-shot repair at next boot, terminal with redaction, audit; BitLocker release only in the form decision 3 chose.
6. **AMT adopt + power** (can run in parallel with 3–5) — credential profiles + settings page, adopt-and-rotate, `oob-gateway`, `oob_amt` tunnel type with two-party authorization, relay selection, power/boot actions, step-ups, permission, `remote_access` flags (default off).
7. **AMT KVM** — redirection → RFB, consent-code prompt, web + viewer.
8. **CCM activation** — agent provisioning, generated credentials, ops user, TLS, unprovision on retire, cross-partner rotation.
9. **ACM activation + network boot** — provisioning certificates with server-side signing, One Click Recovery / storage redirection of Breeze media where the controller supports it.

### Tests

- Agent: MEI response parsing from recorded fixtures (no real hardware in CI); `reagentc`/`bcdedit` output parsing across locales (output is localised — prefer structured sources where they exist); WinRE staging against a fake DISM seam; allowlist enforcement in the recovery transport. `go test -race ./...`.
- API: gateway WS-Man/redirection against a recorded-transcript AMT simulator; relay target resolution refuses any client-supplied host; recovery role can reach only allowlisted commands (403 matrix); step-up required for each new operation.
- Contract suites: `rls-coverage`, `tenantCascade`, `orgMergeRegistry`, `tenant-export-policy` and `tenantExportErasureRoundtrip` run only under **Integration Tests**, not `pnpm test`; `moveOrg.coverage` and `cascadeDelete` run in **Test API**. New `oobCredentialProfilesPartnerRls.integration.test.ts` (cross-partner forge 42501, XOR 23514, org isolation, org-token partner-default read).
- API: `oob_amt` refuses when either the target or the relay authorization fails, and when the TLS pin does not match; one console session per device; org move ends live sessions; `remote_access` policies written before this feature keep every new flag off.
- Lab: a vPro laptop with AMT in CCM and one in ACM, plus an ISM device (power without KVM); Windows 10 22H2 and 11 24H2 VMs plus an OEM WinRE for staging, a forced boot failure (two interrupted boots) to prove automatic WinRE → hook announce → console repair → normal boot, with and without BitLocker.

### CI traps

- Stacked wave PRs (base ≠ `main`) run no CI; dispatch `gh workflow run CI --ref <branch>`.
- A new `apps/api/src/services` file must be classified in the fan-out/area-gating contract.
- New config feature type: DB enum `ADD VALUE` migration + `policyBaselineDefaults.test.ts` parity + web `featureTypeParity.test.ts`.
- New locale keys go to all 8 locales.

### Rollout

Detection ships first behind nothing (read-only). Hook staging is policy opt-in and defaults off, so no device's WinRE changes at upgrade. AMT power/KVM need an adopted or provisioned controller, so nothing changes for a device until a technician acts. The agent changes in waves 1, 2, 4, 5 and 8 are agent-shipped code (full review rigor), released through the normal canary ring.
