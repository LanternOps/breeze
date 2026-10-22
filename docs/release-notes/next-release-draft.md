# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.124.0** (2026-10-19).

---

## Release to-do (pre-cut gates — see `/release` Step 0.2)

- **Backup destination prefix (#7081 W03):** this release must not ship until the
  v0.124.0 release (W01+W02 readers, GC and base scoping) runs on every API and
  worker replica in EU and US, with version parity confirmed. A pre-v0.124.0
  replica that redelivers a write session for a prefixed snapshot would presign
  bucket-root keys. Rollback below v0.124.0 is off the table from here on.

## Self-Hosting / Upgrade Notes (fold into the release body)

- **S3 destination prefixes now relocate new snapshots (#7081).** A destination
  with a **Path Prefix** writes its new snapshots under `<prefix>/snapshots/`
  instead of bucket-root `snapshots/`. Existing snapshots are not moved and keep
  restoring from where they are. Applies automatically to every destination that
  already has a prefix:
  - The first backup after upgrading on such a destination is a **full backup**
    (an incremental never builds on a snapshot stored under another prefix). The
    same happens after any later prefix change; an incremental already scheduled
    against a base under the old prefix is refused (`base_key_root_mismatch`) and
    the next run is full.
  - **IAM:** a policy scoped to `bucket/snapshots/*` must also allow
    `bucket/<prefix>/*`. **Test connection** writes under the prefix and catches
    this. The conditional-write capability probe now also writes under
    `<prefix>/breeze-capability-probe/`.
  - A destination whose stored prefix is invalid (empty or `.`/`..` segments,
    characters outside `A–Z a–z 0–9 ! _ . * ' ( ) -`, a `snapshots` segment, over
    256 characters) is no longer backed up: its backups fail with
    `invalid_destination_prefix` and a message asking for a corrected prefix, and
    **Test connection** now fails for it (it used to pass). Fix it in the
    destination form (it flags the problem inline).
  - Do not roll back below v0.124.0 after this release has written prefixed
    snapshots: older API versions cannot read them.

## Features / API

- **Destination form:** the Path Prefix field explains the new layout and
  validates as you type; Save stays disabled while the prefix is invalid.
- **BMR:** the recovery authenticate and exchange routes refuse with `409`
  `recovery_requires_token_mode` if a prefixed snapshot's bootstrap ever lacks the
  token-mode download descriptor (defensive; the descriptor is always issued today).

## Migrations
