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
- **Restores now require a v0.120.0 or later backup helper.** Restores that write, import or boot a backup (file, SQL Server, Hyper-V, restore as VM, instant boot, bare-metal recovery and rebuild) are refused for devices whose backup helper does not check restores against snapshot attestations, with "Update the Breeze agent on this device, then try again." Recovery media and recovery tools older than v0.120.0 are refused at code exchange and authentication. Verification and test restore are unchanged. Update agents and rebuild recovery media before upgrading the server.
- **Backups without an attestation restore after a two-factor confirmation.** Snapshots taken before attestations existed are labelled "Not verified"; restoring one requires a technician's two-factor confirmation (an explicit confirmation when `ENABLE_2FA=false`; a technician without a second factor types the device name instead), recorded in the new `backup_restore_authorizations` table and the audit log (`backup.restore.unattested_override`). AI tools and DR plans refuse such snapshots. New migration: `2026-12-17-170000-backup-restore-authorizations.sql`. `breeze_backup_restore_integrity_total` gains `status="override"` and `status="refused"`.
