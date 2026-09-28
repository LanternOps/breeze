# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.118.0** (2026-09-27).

---

## Release to-do (pre-cut gates — see `/release` Step 0.2)

## Self-Hosting / Upgrade Notes (fold into the release body)

- **HEADLINE — S3 restores now require HTTPS end to end and the v0.118+ agent. No fallback.** Restores, test restores and verification (file, MSSQL, Hyper-V) that read from S3 or S3-compatible storage are served only through a short-lived storage session. The previous path, which sent the storage destination to the device, is gone, and there is no setting to turn it back on. A read is refused, with a message naming the fix, when:
  - the device's agent is older than v0.118 (the restore, MSSQL, Hyper-V and verification routes answer **409** "Update the Breeze agent on this device, then try again" before anything is queued);
  - agents reach the API over plain `http://`, or `PUBLIC_API_URL` is unset or does not match the address agents use;
  - the storage configuration's endpoint is `http://` (typical for a self-hosted MinIO).
  **Self-hosters on plain-HTTP MinIO or a plain-HTTP API: move to HTTPS before upgrading**, or every S3 restore is refused. Keep MinIO's host and port when you switch; only the scheme may change, or earlier backups cannot be restored. Guide: `/backup/https-restores/`. Local/NAS destinations and backups themselves are not affected. A snapshot whose file list is not yet prepared is held and delivered automatically once it is.
