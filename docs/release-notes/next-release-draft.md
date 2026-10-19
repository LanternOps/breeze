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

- **Sweep + lab pass done 2026-10-19 at freeze `7727a0bd39`** — `docs/testing/release-sweeps/2026-10-19-v0.123.0-to-v0.124.0-sweep.md` (branch `qa/sweep-v0.124.0`). Lab checks cleared on the KIT rigs: #8912 DHCP in-process, #8878/#9207 WinRT toasts (incl. the real-desktop `get_Setting` question — Enabled on the active console session), #9138 desktop fence, #9145 WS back-off, #9146 watchdog overload, #9237 trickle ICE over relay, #9148 CIM NULs, #9186 VPN detection (faked process). **Still no rig for:** #8919 NVIDIA Linux viewer, #8921 bcdboot (no Hyper-V on the guest), #8755 macOS probe, #8265 restore checkpoint on Win10/Server 2025, #9238 Win10 1507, iOS #8885 — carry into the release body's known-gaps note by name.
- **Known gap to name in the release body (accepted by Todd 2026-10-19): #9253** — the YARA-X engine never starts when the agent runs as a Windows service (`GetFileType /dev/stderr: The handle is invalid`); scans on Windows fall back to `engine=legacy` with `rule_set_errors=[engine_unavailable]`. YARA ships dark (no rule UI until W04 #6267), so not a cut blocker; Linux scans with `engine=yara`.
- **Endpoint messaging / live chat stay dark in v0.124.0 (Todd, 2026-10-19):** `ENDPOINT_MESSAGING_MIN_AGENT_VERSION`, `ENDPOINT_MESSAGE_RETRACT_MIN_AGENT_VERSION`, `ENDPOINT_CHAT_MIN_AGENT_VERSION` remain the `999.0.0` fail-closed placeholders, so every send/chat returns `agent_unsupported`; do not document the feature as available. The 0.124.0 agent carries the handlers, so a later release can lift the gates server-side (the verified bump is recorded in the sweep doc).
- **Fleet promote:** the fleet is still on 0.122.1 (the v0.123.0 promote never ran) — promote straight to 0.124.0 after this cut; two agent generations land at once.
- **SentinelOne (#9244):** manual S1 deploys whose version install args lack `{s1_site_token}` are now refused at dispatch (previously installed unregistered / enrolled every org into one site) — release-note line.
- **New web env (optional):** `PUBLIC_ABUSE_CONTACT`, `PUBLIC_SECURITY_CONTACT`, `PUBLIC_SECURITY_POLICY_URL` (#8873) — auth-page footer + `/.well-known/security.txt`; set them on EU/US.
- **`CALLER_VERIFICATION_ENABLED` now defaults to `true`** (compose `${…:-true}`); `CALLER_VERIFICATION_WORKSTATION_ENABLED` stays `false`.
- Step 0.3: agent fuzz GREEN at `7727a0bd39`; tenant-isolation PASS via local run 3×6/6 (CI red = #9252 second-tab `refresh_raced` logout, pre-existing); pentest quick set + chapter legs owed to a breeze-security session (`remediation/pre-tag/v0.124.md`).
- Non-superuser migration check OK at the freeze; 27/27 new migrations idempotent on re-apply.
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

### Caller verification is now enforced for Microsoft 365 identity actions

Password resets and account disables require fresh, single-use verification for the pinned Entra account, using the link tier: SMS and email links, callback attestation, and administrative disable. Verification is checked at release and immediately before direct Graph, Graph executor or Delegant dispatch. Administrative disable uses an interactive MFA step-up bound to the target and reason. "This is not me" opens an incident and fences undispatched actions.

Workstation verification is not part of this release: it ships dark behind `CALLER_VERIFICATION_WORKSTATION_ENABLED` (default `false`), and policies cannot require tier 3 until it is enabled. Establish Entra bindings and attest imported contact destinations. Existing unpinned intents must be recreated. Roll the OID-capable Graph actions executor before the API. `CALLER_VERIFICATION_ENABLED` now defaults to `true`; set and map it in the API service environment. Explicit false hides the workflow and refuses protected actions. A failed dispatch does not restore a consumed verification.

## Migrations

- `2026-12-30-200000-ai-model-registry-legacy-drop.sql` (#9130) — archive + drop of legacy AI model storage; irreversible without PITR on hosted (see Self-Hosting note).
- `2026-12-30-220000-action-intents-caller-target.sql` — adds `target_entra_tenant_id`, `target_entra_oid`, `target_connection_ref` (immutable after insert, all-or-none) and `dispatch_started_at` to `action_intents`. DDL only; no backfill.
