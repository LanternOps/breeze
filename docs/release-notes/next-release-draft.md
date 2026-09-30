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

### Remote desktop: start fence required by default; WebSocket fallback matches WebRTC

- **`REMOTE_DESKTOP_FENCE_REQUIRED` defaults to `true`** (code, both
  `.env.example` files, both compose files). Remote desktop starts only on
  agents that report the session start fence — **v0.114.0 and later**. On an
  older agent the technician sees "Remote desktop needs an agent update on this
  device (session revocation lease and start fence support)…" (`503
  agent_upgrade_required`; WebSocket error `AGENT_UPGRADE_REQUIRED`) and no
  session starts; Terminal and Files are unaffected. Self-hosters pinning agents
  below v0.114.0: move the pin, or set `REMOTE_DESKTOP_FENCE_REQUIRED=false`
  temporarily. A `.env` that still has `REMOTE_DESKTOP_FENCE_REQUIRED=false`
  from an older `.env.example` keeps the fence off — remove the line. An
  unrecognized value now refuses boot. Hosted already runs with it on.
- **WebSocket (JPEG) desktop fallback:** the start is now a handshake — the
  session stays `connecting` and the viewer sees nothing until the agent reports
  the stream started (after the consent prompt, where one applies); a consent
  denial finalizes the session as `denied` with the reason and a
  `session_consent_*` audit row, like WebRTC. New viewer error codes on this
  transport: `CONSENT_DENIED`, `AGENT_START_FAILED`, `START_TIMEOUT`,
  `START_REFUSED`, `SESSION_ENDED`. **End** and server-side teardown stop the
  relay immediately instead of at its next 30-second check. The fallback no
  longer refuses every start under a notify (the default) or consent policy
  with `CONSENT_UPGRADE_REQUIRED`: it now reads the agent's consent prompt
  support from the device record, as the WebRTC routes do.
- **Agent (needs the agent release):** the WebSocket fallback honours the start
  fence and the session lease, refuses an Allow that arrives after the session
  was stopped, shows the notify notice and on-screen indicator, and `stop_desktop`
  also stops it. Agents v0.114.0–v0.119.x keep working on this transport with
  the server-side handshake above. Updated agents advertise this with a new
  heartbeat capability, `securityCapabilities.desktopWsFenceProtocolVersion: 1`;
  the server accepts it but does not record or require it yet.

- **Remote desktop consent prompts now report whether they were shown and
  answered (consent prompt protocol 2).** Only affects devices whose remote
  access policy uses the **consent** prompt mode.
  - **Upgrade order:** update the server before (or together with) agents. A
    server from before this release does not recognise protocol 2 and refuses
    consent- and notify-mode desktop starts on updated agents with "update the
    agent".
  - **Behaviour change on updated agents:** when someone is signed in to the
    session being viewed but the consent prompt cannot be shown to them (Breeze
    Assist not running or not responding, the native dialog failing), the
    session is now always refused, whatever "If no one can respond" is set to.
    That setting still applies when nobody is signed in, and when a prompt the
    user could see went unanswered.
  - An unanswered prompt only counts as "unanswered" when the prompt confirmed
    it was on screen and the session was active and unlocked. Only Windows
    reports the lock state reliably, so on macOS and Linux an unanswered prompt
    is refused.
  - **Breeze Assist:** update Assist along with the agent. An older Assist still
    works for Allow / Deny, but its unanswered prompts are now refused (it cannot
    say whether the prompt was shown).
  - The audit log records the new detail on consent events (`consentOutcome`,
    `consentOccupancy`, `consentProtocol`), and two new reasons:
    `no_user_session` (nobody signed in) and `helper_unreachable` (signed-in user
    could not be asked).
