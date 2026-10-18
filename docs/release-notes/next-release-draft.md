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

## Self-Hosting / Upgrade Notes (fold into the release body)

- **Connection-health digest (#9011)** — on the first deploy that includes it, every admin/owner with an open connection incident receives a digest email at 08:00 partner-local time. Expected one-time burst, not a fault.
- **AI device file read policy (#8866 W01 + #9010 W02)** — both waves ship together; W02 asserts the partner id in the resolver (W01 alone fails open).
- **AI tool output retention (#9044)** — the first nightly run after deploy scrubs AI tool outputs older than 30 days for partners with no AI data policy row; affected chats lose resumable model context. Partners who want to keep history must set retention to blank ("keep forever") *before* upgrading.
- **Connection-health W04 (#9045)** — new webhook and Google Workspace health sources seed silently, then begin real notices for stale syncs and dead webhooks. The Google probe makes one Directory API call per Google-connected org every 6 h, impersonating the org admin.

## Features / API

### Caller verification is now enforced for Microsoft 365 identity actions

Password resets and account disables require fresh, single-use verification for the pinned Entra account, using the link tier: SMS and email links, callback attestation, and administrative disable. Verification is checked at release and immediately before direct Graph, Graph executor or Delegant dispatch. Administrative disable uses an interactive MFA step-up bound to the target and reason. "This is not me" opens an incident and fences undispatched actions.

Workstation verification is not part of this release: it ships dark behind `CALLER_VERIFICATION_WORKSTATION_ENABLED` (default `false`), and policies cannot require tier 3 until it is enabled. Establish Entra bindings and attest imported contact destinations. Existing unpinned intents must be recreated. Roll the OID-capable Graph actions executor before the API. `CALLER_VERIFICATION_ENABLED` now defaults to `true`; set and map it in the API service environment. Explicit false hides the workflow and refuses protected actions. A failed dispatch does not restore a consumed verification.

## Migrations

- `2026-12-30-220000-action-intents-caller-target.sql` — adds `target_entra_tenant_id`, `target_entra_oid`, `target_connection_ref` (immutable after insert, all-or-none) and `dispatch_started_at` to `action_intents`. DDL only; no backfill.
