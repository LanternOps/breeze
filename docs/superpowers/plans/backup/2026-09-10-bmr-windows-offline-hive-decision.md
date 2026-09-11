---
title: Windows BMR registry-hive restore — offline apply vs. drop from scope
status: decided — Option B (2026-09-10)
date: 2026-09-10
source: docs/superpowers/plans/backup/2026-09-09-bmr-system-state-contract.md §3 ("Windows" paragraph)
owner: Todd
tracking_issue: LanternOps/breeze#5439
---

# Windows BMR Registry-Hive Restore — Decision: Option B

**Decided 2026-09-10 (backup assurance campaign): Option B.** Windows bare-metal recovery applies files, certificates and firewall automatically; registry hives and BCD remain collected for manual reference and are never live-applied. Rationale: live-hive `reg restore` is unsupported on a running OS, and Option A needs a Windows boot-media, ADK, WinPE driver-injection and media-signing pipeline the product does not have, contradicting the reinstall-then-recover model. Implementation tracked in [#5470](https://github.com/LanternOps/breeze/issues/5470); Option A can return as its own feature if registry-level Windows recovery is required.

## 1. What's true right now

`agent/internal/backup/bmr/restore_windows.go`'s `importRegistryHives` (lines ~69-91) runs, for each
collected hive:

```go
cmd := exec.Command("reg", "restore", regKey, hivePath) // regKey ∈ {HKLM\SYSTEM, \SOFTWARE, \SAM, \SECURITY}
```

against `HKLM\SYSTEM` / `HKLM\SOFTWARE` / `HKLM\SAM` / `HKLM\SECURITY` — the **live, in-use hives of
the running OS the `breeze-backup` process is itself executing under**. `SYSTEM` and `SOFTWARE` are
memory-mapped by the kernel; `reg restore` against a hive that is loaded and in use either fails
outright ("file in use" / access denied — matches the campaign's O13 finding, where Defender also
flags the SECURITY save attempt as `Trojan:Win32/Commando.A!ml`) or, if it succeeds, doesn't take
effect until reboot and can leave the boot volume inconsistent with what's actually loaded at that
point. Errors here are caught and logged (`slog.Warn`) but do **not** fail `RestoreSystemState` — a
Windows BMR recovery today reports `stateApplied: true` (once Wave 2 lands) with the registry
unchanged, or currently `stateApplied: false` (D15) because nothing connects producer to consumer at
all yet.

This is not a robustness bug to patch — live-hive `reg restore` of the boot/security hives of a
running OS is not a supported operation. It needs a different model. This feature (#5439, W01-W03)
implements that different model for **Linux** (`cp -a /etc`, package reinstall, `systemctl enable`,
firewall, crontabs — all safe to apply live). **No Windows restorer code change ships in this
feature** — this doc records the follow-up decision instead, per the plan's §3 recommendation to
decide, not implement, here.

`certutil -restoreDB` (certificates) and `netsh advfirewall import` (firewall) in the same file do
**not** have this constraint — they operate on data files / configuration APIs, not memory-mapped
kernel hives, and can stay live-applied under either option below.

## 2. Option A — Offline apply via WinPE/WinRE

Boot the target into a WinPE/WinRE recovery environment (matching what `bare-metal-recovery.mdx`
already led readers to expect before the campaign corrected it), where `HKLM\SYSTEM` etc. are not the
running OS's own hives. From there, `reg load HKLM\OfflineSystem <path-to-offline-SYSTEM-hive>` +
`reg restore`/direct file copy of the collected hive files, then `reg unload`, correctly replaces the
target's boot-time registry before it's ever loaded by the running kernel.

**Requires:**
- A boot-media pipeline Breeze does not have today: BMR currently builds a Linux/amd64 ISO from an
  *operator-supplied* template only (`recoveryBootMediaService.ts`); there is no WinPE/WinRE image
  build, no Windows ADK integration, and no signing story for a bootable Windows recovery image.
- A driver-injection story for WinPE itself (storage/NIC drivers for arbitrary target hardware) on top
  of the existing post-boot driver injection (`InjectDrivers` via `pnputil`).
- Test coverage on real Windows hardware/VMs with a WinPE boot path — **the lab's Hyper-V host is
  LAN-only with no SSH/WinRM exposed** (campaign §9 decision 2), so this cannot be built and proven
  in the current lab without that access being granted, or a different Windows test environment.
- Media signing infrastructure parity with the Linux ISO path (`legacy_unsigned` today per the
  campaign's B1 bundle result — that gap would need closing for Windows boot media specifically,
  since an unsigned bootable image is a materially larger trust concession than an unsigned recovery
  binary tarball).

## 3. Option B — Scope Windows BMR to files + certs/firewall; drop hive restore

Keep Windows `system_image` collection as-is (hives, BCD, drivers, services, certs, firewall are still
*collected* — useful for manual reference, per what the docs already promise), but remove the
`importRegistryHives` and `restoreBootConfig` (BCD) live-apply calls from `RestoreSystemState`, leaving
only `restoreCertificates` and `restoreFirewall` as automatically applied. Manifest metadata already
lets a future consumer distinguish "collected for reference" from "automatically restorable" per
artifact if that distinction becomes useful later.

**Requires:**
- A small, low-risk code change (removing two call sites) — cheap once decided.
- A docs correction scoping Windows `system_image` BMR to "files + certs + firewall auto-applied;
  registry/BCD/services/drivers are collected for manual reference only," mirroring the Linux/macOS
  page's existing honesty about what is and isn't applied.
- No new infrastructure, no new test environment, no signing work.

## 4. Recommendation

**Option B**, until Option A's prerequisites (WinPE build pipeline, driver injection into WinPE, boot
media signing, and real Windows-hardware test access) exist independently of this feature. Rationale:

- Option A is a multi-quarter infrastructure project (boot media authoring + signing + WinPE driver
  injection), not a fix scoped to this feature's blast radius (agent-shipped backup/restore code).
- Shipping the unsafe live-hive path (even gated as "best effort, warnings only") risks the exact
  Defender false-positive-malware-alert outcome the campaign already proved on the *backup* side
  (O13/SECURITY hive save) recurring on the *restore* side, and risks leaving a target's boot volume
  in a state inconsistent with what's loaded, which is worse than doing nothing.
- Option B is honest about current capability, matches the already-corrected
  `bare-metal-recovery.mdx` posture (no overclaim to walk back), and doesn't block Linux BMR (this
  feature's actual deliverable) on unrelated Windows infrastructure work.
- If/when WinPE boot media becomes a roadmap item for other reasons (e.g. true disk-imaging BMR), Option
  A's registry-restore piece can be folded into that larger effort rather than justifying its own
  standalone WinPE pipeline.

**Action if approved:** file a follow-up issue against #5439 (or a new tracking issue) for the Option B
code change (remove `importRegistryHives`/`restoreBootConfig` call sites in
`restore_windows.go`'s `RestoreSystemState`) and the corresponding doc note; out of scope for Wave 4.
