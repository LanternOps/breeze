# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.122.1** (2026-10-12). v0.122.0 was tagged but never released.

---

## Release to-do (pre-cut gates — see `/release` Step 0.2)

## Self-Hosting / Upgrade Notes (fold into the release body)

- **System Protection (#4609):** deploy the API and web first; there are no new environment variables. The migrations below run automatically on API start. Nothing changes on devices until an agent release that supports System Protection ships.

## Features / API

- **Windows System Restore: policy-controlled System Protection and per-action reporting (#4609, #4751).** A new **System Protection** policy tab (also available on partner-wide "All orgs" policies) sets whether Breeze requests a System Restore checkpoint before patch installs, scripts and software installs. The server resolves the setting per device, records every request in a new per-device attempts ledger, and shows the outcome as a badge on patch history, script execution details and software deployments, plus a **System Restore** tab on Windows devices. **The agent side is not in this release.** Checkpoint creation and reporting by the agent roll out with a future agent release, so until devices run it every attempt reads **Awaiting the device** and no outcome is reported. Patch installs keep their existing best-effort behavior (a command with no System Protection setting is treated the legacy way: patch installs requested, scripts and software installs not). Turning patch checkpoints *off* cannot be enforced on a device until its agent reports support, and the policy tab says so. Scripts and software installs take no checkpoint until you opt in **and** an agent release that supports it is deployed. Breeze AI can read the same ledger with the read-only `list_device_restore_point_attempts` tool (devices:read, #8584). System Restore is not a backup. Separately, the native Windows call used for restore points had the wrong struct layout (the SDK header declares both structs under `#pragma pack(1)`); the corrected layout is in the agent code and takes effect with the agent release that includes it. Docs: Configuration Policies > System Protection (includes the support matrix; only Windows 11 25H2 and Server 2022 are verified so far, Windows 10 and Server 2025 are tracked in #8265).

- **Mobile: arrival suggestions (#8209, W2).** With the partner's *Location suggestions* setting on (off by default) and the technician's own opt-in, the app suggests starting a timer when opened at a pinned client site. Foreground only; the phone's position is compared on the device and never sent. Adds the `expo-location` dependency and iOS/Android location permission strings, so it ships with the next **mobile app build** (not an API/web deploy). Technicians with the *Set site location* permission can pin a site from the phone. Docs: Mobile app > Arrival suggestions.

## Migrations

- `2026-12-24-110000-system-protection-feature-type.sql` adds the `system_protection` value to the `config_feature_type` enum. Idempotent (re-running is a no-op), but Postgres cannot drop an enum value, so this one is effectively one-way.
- `2026-12-24-160000-device-restore-point-attempts.sql` creates the `device_restore_point_attempts` table (RLS enabled and forced, org-cascade and export registered). Additive.
