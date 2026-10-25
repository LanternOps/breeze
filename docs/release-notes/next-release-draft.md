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
- #9840: run the lab checklist (`docs/superpowers/plans/ai-mcp/2026-10-25-ai-chat-move-conversations-lab-checklist.md`) on a real-key stack before the tag; W1 #9852, W2 #9996, W3 #10029, W4 #10044 and W5 ship together.

## Self-Hosting / Upgrade Notes (fold into the release body)

- **Install scripts (#6958).** Install scripts stored on software versions before this release stay inactive until the version is re-created; the version manager shows a notice.
- **`software_compliance_status` forced RLS (#10022).** The table now has forced row-level security on databases created from the baseline.
- **Boot task: pinned built-in package refresh (#6958).** On start the API moves provisioned DNS built-in packages to the code-pinned version. Log line: `[startup] pinned built-in package refresh: refreshed N, failed M`.
- #6958 adds no new environment variables.
- #9840 adds no new environment variables, no migration and no setting; the new route needs no proxy change beyond what `POST …/messages` already needs for SSE.
- **IOC sweeps: nine optional settings (#6263 W05).** All are optional and default sensibly: `SECURITY_SWEEP_MAX_DEVICES` 10000 (devices per sweep request), `SECURITY_SWEEP_MAX_ACTIVE_PER_ORG` 5, `SECURITY_SWEEP_PUMP_INTERVAL_MS` 30000, `SECURITY_SWEEP_PUMP_BATCH` 100 (scans admitted per sweep per organization per tick), `SECURITY_SWEEP_PARTNER_RUNNING_CAP` 200, `SECURITY_SWEEP_TTL_HOURS_DEFAULT` 24 (a request may ask for 1 to 72), `SECURITY_SWEEP_MFA_DEVICE_THRESHOLD` 50, `SECURITY_SWEEP_RUNNING_GRACE_MINUTES` 65 and `IOC_HUNT_FOUR_EYES_DEVICE_THRESHOLD` 25 (AI-started sweeps above this many expected devices need a second approver). They are not mapped in the Compose files; add them to the `api` service `environment:` if you want to change one. "MFA" here means multi-factor authentication as the organization's policy requires it: a sweep above 50 devices needs an interactive sign-in with that check satisfied, and API keys are refused above 50 whether or not `ENABLE_2FA` is on.

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

- **Install scripts, zip packages and built-in DNS packages (#6958).** Software versions can use the `zip` package type (extract-only; a post-install script is required) and carry pre/post-install scripts that run as SYSTEM/root with a 10-minute timeout each. Creating a version with a script requires `devices.execute`. Partner admins can also add two Breeze-pinned DNS filtering clients, Control D and NextDNS CLI for Windows, from Software → Catalog → Built-in packages. Agent 0.125.0 or newer is required for zip packages and scripts; older agents fail the device with `agent_update_required` and nothing is dispatched.
- **Move AI conversations between the side panel and the AI Assistant (#9840).** A conversation moves from the side panel to an AI Assistant tab (**Open in AI Assistant**) and back (**Continue in side panel**, in the chat header and the tab menu) with its history, device binding, model and unsent text; nothing is duplicated or deleted. A reply that is still streaming carries over and keeps streaming, and a pending approval card moves with its original deadline. The side panel's History and the AI Assistant's new **Open a past conversation** picker share one list with organization and **Device** chips, and label a conversation open on the other surface. `/workspace#session=<id>` deep-links a conversation and the URL follows the active tab. API: `GET /api/v1/ai/sessions/:id/stream` is a new read-only route that follows a session's current turn; `GET /api/v1/ai/sessions` and `/search` return only chat conversations and now carry `orgId`, `type` and `deviceId` (search also `status`). The mobile app's history list stops showing script-authoring and MCP sessions — intended.
- **Service compliance (#6958).** New `service_running` detection clause and two new software-policy violation types, `not_running` (high) and `service_unverified` (low, never triggers a reinstall). Allowlist rules derive per-device service watches, shown on the device monitoring tab, and an armed policy restarts a stopped service automatically.

- **PAM: agents report an elevation they cannot act on (#9517).** New agent route `POST /api/v1/agents/:id/pam/elevation-unable` (admission class `protected`). When the agent gives up on the PAM flow (requester session found but not active, helper did not start within the 30-second wait or lacks the PAM scope), it reports the request; uncertain cases (session unresolved, session check failed, session not in the snapshot before or during the helper wait, lease refused, a ready helper not found, no session broker or lifecycle manager yet) stay pending for the stale-request expiry; a still-pending request is closed as `expired` and the server then withdraws its mobile approvals (best-effort; a phone approval of a closed request is refused either way), and the PAM requests list shows that the device could not act under the Expired or All filter. New log lines: agent `pam: reported the elevation as unable to the server` / `pam: could not report the elevation as unable`; the API publishes `elevation.expired` with `cause: device_unable` (best-effort, like the stale-request expirer's: a failed publish is logged and the row stays the record). Older agents keep the previous behavior (the request stays pending until the stale-request expiry).

- **IOC sweeps (#6263 W05).** Run published detection rule sets across many devices at once. New routes under `/api/v1/security`: `POST /sweeps/preview`, `POST /sweeps` (needs the `previewDigest` from the preview), `GET /sweeps`, `GET /sweeps/:id`, `GET /sweeps/groups/:groupId`, `POST /sweeps/:id/cancel` and `POST /sweeps/groups/:groupId/cancel` (writes need `devices:execute`, reads `devices:read`). The console gets **Sweep now** on a rule set and a **Sweeps** tab on **Security → IOC Scans** (`#sweeps&group=<groupId>` deep link). Sweeps are detect-only and never start a Defender scan. Each sweep pins the rule-set versions it was approved with; threats show **Version N**, and a republish mid-sweep fails the remaining scans with `rule_set_changed`. Scans gain two states, `cancelled` and `expired`, so API consumers filtering `GET /security/scans/:deviceId` by status will now see them. The AI assistant and MCP get an `ioc_hunt` tool: reads are Tier 1, `cancel_sweep` Tier 2, and `sweep` and `import_iocs` Tier 3 (approved; a second approver above 25 devices; one organization per AI sweep; importing into an auto-quarantine set is refused). Also fixed: a throttled scheduled security scan was previously never retried; the AI `security_scan` `scan` action now records a scan row and returns without waiting; custom scan paths on `POST /security/scan/:deviceId` are now capped at 1024 characters.

- **Destination form:** the Path Prefix field explains the new layout and
  validates as you type; Save stays disabled while the prefix is invalid.
- **BMR:** the recovery authenticate and exchange routes refuse with `409`
  `recovery_requires_token_mode` if a prefixed snapshot's bootstrap ever lacks the
  token-mode download descriptor (defensive; the descriptor is always issued today).

## Migrations

- `2027-01-02-180000-elevation-device-unable.sql`: three nullable columns on `elevation_requests` (`device_unable_at`, `device_unable_reason`, `device_unable_detail`) and the `device_unable` value on `elevation_audit_event_type`. The column adds are metadata-only, but the new CHECK `elevation_requests_device_unable_chk` is validated in the same statement, so Postgres scans `elevation_requests` once under the migration's lock (no rewrite). The table holds every elevation request (UAC prompts, technician JIT grants, governed AI tool actions), so the lock is held for one sequential scan of it. Scan time depends on the table's size on disk, its live row count (each row's CHECK is evaluated) and the storage's read speed. Measured on one idle host (PostgreSQL 16, local NVMe, a synthetic copy of the table at about 600 bytes a row): 1 million rows (600 MB) validated in 0.21 to 0.22 s over three warm runs; 10 million rows (6 GB) in 5.0 s with the OS and Postgres caches cleared and 2.1 s warm (one run each). Anything that reads or writes `elevation_requests` (new UAC requests, approvals, the requests list) waits that long. These are single-host measurements, not a guarantee: slower, shared or busy storage, lock waits and concurrent traffic can make it materially longer. Check `SELECT pg_size_pretty(pg_relation_size('elevation_requests'))` before upgrading and plan a quiet window when that size is large for your storage.
- `2027-01-04-140000-security-scan-sweeps.sql` (#6263 W05): creates `security_scan_sweeps` (empty at upgrade, row-level security forced) and adds three nullable columns to `security_scans` (`sweep_id`, `dispatched_rule_sets`, `command_id`; metadata-only, no table rewrite) plus one partial index on `sweep_id IS NOT NULL`, which is empty until the first sweep.
