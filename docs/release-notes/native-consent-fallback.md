# Release note — Native Remote-Session Consent Without the Assist App (behavior change)

**Feature:** Native remote-session consent dialog + active-session banner from the Go user-helper
**Issue:** #2229
**Affects:** Devices running the Breeze agent's user-helper, when the Tauri "Breeze Assist" app is NOT installed

---

## What changed

The remote-session consent/notification feature (shipped in v0.83.0) previously
required the **Breeze Assist** Tauri app to be installed on the target device to
show the Allow/Decline consent dialog and the on-screen "Remote session active"
banner. On devices without the Assist app, `session_prompt_mode: "consent"`
fell through to `consent_unavailable_behavior` (default `proceed`) — i.e. no
prompt was shown.

Starting with this release, the **Go user-helper that ships with every agent**
renders these surfaces natively, so consent works without the Assist app:

- **Consent dialog** (all three OSes): a native Allow/Decline prompt —
  `MessageBoxTimeoutW` on Windows, an `osascript` dialog on macOS, `zenity` on
  Linux. It carries the same auto-decision-on-timeout behavior as the Assist
  dialog.
- **Active-session banner** (**Windows only**): a topmost "…​is connected" pill.
  On macOS/Linux there is no native persistent banner — the Assist app still
  provides it there (see Limitations).
- **Connect / session-ended notices** continue to work as before via native OS
  notifications.

When the Assist app **is** installed, it still wins — its richer dialog is
preferred over the native fallback.

## Trust-signal change: prompts now name the MSP, not the client

The consent dialog and notices now read **"<Technician> from <Your MSP>
connected"** (e.g. "Billy from Olive Technology connected"). Previously the name
shown was the **client organization's own** name (the end user's own company),
which was not a useful trust signal. The partner/MSP name is now shown, and it
is retained even when `technician_identity_level` redacts the technician's own
name (e.g. "A technician from Olive Technology").

## Behavior change on upgrade

If you run `session_prompt_mode: "consent"` on a `remote_access` configuration
policy, devices that previously had **no Assist app** — and therefore silently
proceeded under `consent_unavailable_behavior: proceed` — will now **show a real
Allow/Decline dialog** once their user-helper updates. This is the intended
behavior, but it is a change from the prior silent-proceed on those devices.

To keep the old behavior on a device group, set `session_prompt_mode: "off"` (no
prompt, no banner, no notice) or `session_prompt_mode: "notify"` (notice only,
no gating dialog) on the applicable policy.

Devices that are genuinely headless / have no interactive graphical session are
unaffected: they don't run an interactive user-helper (or, on Linux, don't
advertise consent support without a display), so consent mode still resolves via
`consent_unavailable_behavior` rather than blocking.

## Mixed-fleet safety

- New IPC fields are additive and optional. An **older** user-helper (or an
  older broker) simply ignores them and keeps the prior `helper_absent`
  semantics — no stalls.
- The native consent scope is granted **only** to user-helpers that explicitly
  advertise native consent support, so a new daemon never sends a consent
  prompt to a helper that can't answer it.
- Mixed fleets (some devices on the Assist app, some on the native helper, one
  unchanged server) all interoperate over the same wire protocol.

## Limitations (by design)

- **No partner branding** (logo/accent color) on the native dialog — it uses
  plain OS chrome. The Assist app remains the branded experience.
- **No native banner on macOS/Linux** — the consent dialog and notices work
  there without the Assist app, but the persistent on-screen "session active"
  pill is Windows-only in the native helper; the Assist app provides it on
  macOS/Linux.
- **Linux requires `zenity` and a graphical display** for the native consent
  dialog. Without both, the device keeps `consent_unavailable_behavior`
  semantics.

## Not included (tracked separately)

Step-up MFA before starting a remote tool or performing a Tier 3 action — the
other half of issue #2229 — is **not** part of this release and is tracked as a
separate issue.
