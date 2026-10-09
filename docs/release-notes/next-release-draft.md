# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.121.0** (2026-10-03).

---

## Release to-do (pre-cut gates — see `/release` Step 0.2)

## Self-Hosting / Upgrade Notes (fold into the release body)

- **Bootstrap tokens embedded in downloaded installers now default to 7 days
  and last at most 30 days.** The previous default was 30 days in code and
  1 day under the bundled compose files (`1440`). `INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES`
  now defaults to `10080` in code and in both compose files. A value above
  `43200` (30 days) is clamped, with a warning at API startup. Set the variable
  to keep a different value up to 30 days.
  - The installer download (`GET /enrollment-keys/:id/installer/:platform`) and
    `POST /enrollment-keys/:id/bootstrap-token` now reject an explicit
    `ttlMinutes` above `43200` with `400`. The child enrollment key embedded in
    the legacy macOS zip is held to the same 30 days.
  - The Add Device modal's Installer tab offers expiries up to 30 days (it
    previously offered 90 days and 1 year); a longer partner/org default
    preselects 30 days there. That picker also sizes links generated from the
    tab. The CLI tab is unchanged.
  - The installer-link API (`POST /enrollment-keys/:id/installer-link`) and
    enrollment keys still accept lifetimes up to a year; each installer
    downloaded from a link carries a token of at most 30 days.
  - Installers already downloaded keep their original expiry.
- **Database migrations take brief exclusive locks on busy tables.** The
  `2026-12-13-110000/110100/110200` migrations redefine foreign keys on child
  tables of `users`, `devices`, `alerts`, `tickets`, `roles` and others. Each
  swap briefly takes an ACCESS EXCLUSIVE lock on the child **and** the parent
  table, and waits at most 5 s for it (`lock_timeout`). If a long-running
  reader holds one of those tables (a large report, a `pg_dump`/backup window),
  the migration stops, the API fails to boot with a lock-timeout error, and it
  re-applies cleanly on the next restart. Avoid deploying this release during a
  database backup window. No data is rewritten; the new constraints are
  validated afterwards without blocking writes.
- **Deleting a role that an access review covered now returns 409** ("Role is
  referenced by access reviews") instead of a server error, so review evidence
  is kept. Deleting a notification channel keeps the alert delivery history it
  produced (shown without a channel name), and deleting a maintenance window
  removes all of its occurrences.
- **New `webhooks:read` permission.** Viewing webhooks and their delivery history (the Webhooks tab under Integrations, `GET /webhooks`, `GET /webhooks/:id`, `GET /webhooks/:id/deliveries` and the AI assistant's `query_webhooks` tool) now requires `webhooks:read` instead of `organizations:read`. Managing webhooks still requires `organizations:write`. The built-in Org Admin, Org Technician and Partner Technician roles receive it on upgrade (Partner Admin already holds everything), and so does any custom role that holds `organizations:write` (or a wildcard grant covering it). Viewer, billing and security-approver roles do not, so Partner Viewer and Partner Security Approver, which could see webhooks through `organizations:read`, no longer can. **A custom role that holds `organizations:read` but not `organizations:write` loses access to webhooks and their delivery history until an administrator adds `webhooks:read` to it under Settings → Roles.** The upgrade log lists those roles: the migration writes a `webhooks-read-permission:` warning with their count and up to 20 names. In the dashboard, the Webhooks tab is hidden for users without `webhooks:read`, and users with `webhooks:read` but not `organizations:write` see webhooks and their delivery history without the create, edit, delete, test, pause/resume or retry controls. New migration: `2026-12-18-110000-webhooks-read-permission.sql`.
- **Restores now require a v0.120.0 or later backup helper.** Restores that write, import or boot a backup (file, SQL Server, Hyper-V, restore as VM, instant boot, bare-metal recovery and rebuild) are refused for devices whose backup helper does not check restores against snapshot attestations, with "Update the Breeze agent on this device, then try again." Recovery media and recovery tools older than v0.120.0 are refused at code exchange and authentication. Verification and test restore are unchanged. Update agents and rebuild recovery media before upgrading the server.
- **Backups without an attestation restore after a two-factor confirmation.** Snapshots taken before attestations existed are labelled "Not verified"; restoring one requires a technician's two-factor confirmation (an explicit confirmation when `ENABLE_2FA=false`; a technician without a second factor types the device name instead), recorded in the new `backup_restore_authorizations` table and the audit log (`backup.restore.unattested_override`). AI tools and DR plans refuse such snapshots. New migration: `2026-12-17-170000-backup-restore-authorizations.sql`. `breeze_backup_restore_integrity_total` gains `status="override"` and `status="refused"`.
- **Building the agent from source now needs Go 1.26.9.** The agent module and the release builds move from Go 1.26.6 to 1.26.9, and `golang.org/x/net` from v0.59.0 to v0.60.0, picking up the upstream `net/http` and HTTP/2 fixes in those releases. With the default `GOTOOLCHAIN=auto`, `go build` fetches 1.26.9 on its own; with `GOTOOLCHAIN=local`, install Go 1.26.9 first. Pre-built agent binaries need no action.
