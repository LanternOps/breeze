# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.119.0** (2026-09-30).

---

## Release to-do (pre-cut gates — see `/release` Step 0.2)

## Self-Hosting / Upgrade Notes (fold into the release body)

- **Backups to S3 storage use storage sessions only (minimum agent v0.119.0).** Scheduled, SQL Server and Hyper-V backups to S3 or S3-compatible storage are written only through a short-lived, write-scoped storage session; no backup command carries the storage destination or its keys. A device whose agent predates v0.119.0 is refused with `Update the Breeze agent on this device, then try again. Backups now require secure storage access, …` (HTTP 409 on the on-demand routes; scheduled jobs fail with the same message). `http://` storage endpoints, `http://` agent API addresses (or a missing `PUBLIC_API_URL`) and providers other than S3/local are refused for backups, as they already are for restores. **Before upgrading:** update every device that backs up to S3 to agent v0.119.0+, and move storage endpoints and the agent API to HTTPS. Local/NAS destinations are unchanged. New migration `2026-11-12-100000-backup-storage-credential-history.sql` (new table, no data rewrite). At its first start the API records the storage key each S3 destination uses; the Backup policy's Destination section then lists keys used before the upgrade until each is replaced and disabled with the provider (**Check old key**, or an operator confirmation). Docs: [HTTPS for Backups](/backup/https-backups/). The `breeze_backup_write_dispatch_unexpected_legacy_total` metric now counts any backup delivered with its storage key (none are expected).
- **AI tool `manage_backup_configs` accepts only `s3` and `local` providers,** matching the backup destination API (other provider values were accepted by the tool but cannot be used for backups).
