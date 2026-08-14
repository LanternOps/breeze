# NU RMM — Operating Principles

These are the non-negotiable standards for how Nodes Unlimited manages a customer's
fleet. They apply to **every** managed device regardless of customer — the bar is set by
the fact that behind each endpoint is someone's work that must not be disrupted, exposed,
or misreported. Every script, agent build, config policy, and deploy is held to these.

## 1. Non-disruptive by default

Managed machines may be running critical, long-lived work (lab instruments crunching data
for days, production servers, clinician workstations). **Nothing we do interrupts a machine
that is mid-run.**

- **Agent updates are a ~2-second service blip, never a machine reboot.** An MSI upgrade
  stops/replaces/restarts only the NU services (`BreezeAgent` / `BreezeWatchdog`); it never
  touches customer software and never forces a restart. macOS/Linux updates are equally
  in-place (launchd/systemd service restart only).
- **Collectors stay lightweight.** Inventory, metrics, and compliance scans must not spike
  CPU or I/O on a machine doing real work. Prefer read-only queries; back off under load.

## 2. Reboots require a maintenance window AND approval

Any change that genuinely needs a reboot (some patches, some driver updates) is **never
automatic**. It is scheduled into a **customer-approved maintenance window** and executed
only with explicit sign-off. Surprise reboots are a Sev-1 process failure.

## 3. Patch management

- **Scanning is read-only and safe at any time** — detect missing patches, CVEs, and
  version drift continuously.
- **Installation and any reboot it entails are gated** behind the maintenance-window +
  approval flow above. Configure patch policies with **no auto-reboot** by default.
- Report patch/vulnerability posture per device so the customer sees exactly what's pending
  before anything is applied.

## 4. Scripts must be precise

Library scripts run on real, in-use machines — imprecision has consequences.

- **No hangs.** Wrap any CLI/IPC call that can block (e.g. `rustdesk --get-id` under ARM
  emulation) in a timeout; prefer reading state from config/registry over blocking calls.
- **Output is always surfaced — even on failure.** A failed run must show its error text;
  "failed with no output" is a defect. (Enforced end-to-end: agent captures stdout/stderr +
  error, server stores them, UI renders the error banner, and the reaper recovers output
  from recovered runs.)
- **Non-destructive unless explicitly written to be, and approved.** No reboots, no killing
  user processes, no forced logoffs by default.
- **Access passwords are shown in plain text** in script output (operators must read the
  RustDesk unattended code to start a session); this is deliberate NU policy and is paired
  with per-session password rotation as the hardening path.

## 5. Full audit trail + accurate logs

- Every script execution, remote session, and configuration change is **tracked per device**
  with who/when/result.
- Agent, install, and execution logs are captured accurately and land in known locations
  (Windows install transcript: `C:\Temp\Logs\NURmm-logs\`; agent data/logs under the
  platform config dir).
- Never silently discard an error — a recorded failure with its cause beats a blank success.

## 6. Compliance = security posture, visible per device

Compliance reporting must show real pass/fail per device for at least: disk encryption
(BitLocker / FileVault / LUKS), firewall enabled, AV/Defender healthy, screen-lock policy,
and patch currency. For regulated customers (labs, healthcare) this is a must-have, not a
nice-to-have.

## 7. Cross-platform accuracy

A mixed fleet is the norm (Windows x64, Apple Silicon + Intel Macs, Linux). Every collector
and script is validated on a **real** machine of each platform before it ships to a fleet —
virtual/test boxes under-report hardware and are not representative. Inaccurate inventory is
worse than none: it erodes trust in the whole dashboard.

---

*If a proposed change violates any principle above, it is not done — redesign it. These
standards are what let a customer trust us with machines they cannot afford to lose.*
