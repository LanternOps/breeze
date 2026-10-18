# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.123.0** (2026-10-17).

---

## Release to-do (pre-cut gates — see `/release` Step 0.2)

- Lab checks OWED before the tag (merged on Todd's instruction with checks outstanding): #8919 viewer on NVIDIA Linux, #8921 bcdboot failure path, #8935 caller-verify absolute deadline, #8912 Windows DHCP in-process read, #8878 WinRT toasts (Win11 real-helper check per PR body), #8755 macOS permission probe (checks per PR body).
- YARA W02 (#9112) ships dark; Windows benchmark on the lab Windows Server VM is owed before the W03 sidecar decision, not a release blocker.
- AI model registry W08b (#9130): take the DO backup / PITR point BEFORE deploy; after deploy run G3 (archive query in `deploy/upgrades.mdx` vs the G2 counts held by the features-work session, zero blocking rows on both regions 10-17).

## Self-Hosting / Upgrade Notes (fold into the release body)

- **AI model registry legacy drop (#9130)** — R2 of the two-step migration (W08a shipped in v0.123.0). Archives legacy AI model storage into `ai_model_registry_legacy_archive` and drops the old storage. Back up before upgrading. **Rollback caveat:** with the workspace extension enabled, the previous image's boot tripwire refuses to start while the archive table exists, so going back is a database restore, not an image rollback. A partner may now hold several Anthropic connections (cap removed).
- **Connection-health notifications complete (#8844: W2 #8936, W3 #9011, W4 #9045, W5 #9047)** — customer-admin notices are OFF by default (partner default, org override) under the new mail purpose `customer.connection_health_digest`.

- **Connection-health digest (#9011)** — on the first deploy that includes it, every admin/owner with an open connection incident receives a digest email at 08:00 partner-local time. Expected one-time burst, not a fault.
- **AI device file read policy (#8866 W01 + #9010 W02)** — both waves ship together; W02 asserts the partner id in the resolver (W01 alone fails open).
- **AI tool output retention (#9044)** — the first nightly run after deploy scrubs AI tool outputs older than 30 days for partners with no AI data policy row; affected chats lose resumable model context. Partners who want to keep history must set retention to blank ("keep forever") *before* upgrading.
- **Connection-health W04 (#9045)** — new webhook and Google Workspace health sources seed silently, then begin real notices for stale syncs and dead webhooks. The Google probe makes one Directory API call per Google-connected org every 6 h, impersonating the org admin.

## Features / API

- **Breeze AI: System Restore ledger read (#8584).** The read-only `list_device_restore_point_attempts` chat tool (devices:read) lists a device's System Protection checkpoint attempts, newest first, with trigger and status filters. No new env vars or migrations.

## Migrations

- `2026-12-30-200000-ai-model-registry-legacy-drop.sql` (#9130) — archive + drop of legacy AI model storage; irreversible without PITR on hosted (see Self-Hosting note).
