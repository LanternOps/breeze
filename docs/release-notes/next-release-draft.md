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

### Remote desktop consent: VNC refused, consent-capable agent required, audit actions renamed

- **VNC is refused on devices that require consent.** When a device's resolved
  remote access policy has the session prompt set to *Require consent*, creating
  a VNC tunnel (`POST /tunnels` with `type: 'vnc'`), falling back from the
  desktop viewer to VNC (`POST /vnc-viewer/downgrade-to-vnc`), and minting a
  ticket or connect code for an existing VNC tunnel (`POST /tunnels/:id/ws-ticket`,
  `POST /tunnels/:id/connect-code`, `POST /vnc-exchange/:code`) now return
  `409 { code: 'CONSENT_REQUIRED_TRANSPORT_UNAVAILABLE' }`. The VNC tunnel
  WebSocket is refused at connect time too, and an open VNC relay is closed
  (close code 4003) at its next live re-check once the device's policy
  changes to *Require consent*. VNC cannot show the consent prompt;
  technicians use the remote desktop viewer instead. Notify and off modes are
  unchanged.
- **Consent-mode desktop starts need a consent-capable agent.** Both WebRTC
  offer routes (`POST /remote/sessions/:id/offer` and
  `POST /desktop-ws/:id/viewer/offer`) now refuse a consent-mode start with
  `409 { code: 'CONSENT_UPGRADE_REQUIRED' }` before anything is sent to the
  device when its agent does not report consent prompt protocol version 1 —
  the same check the WebSocket fallback already made. Update agents on devices
  under a consent policy before upgrading the server. Notify/off starts are not
  affected.
- **An unreadable prompt policy now refuses the start.** If the device's remote
  access prompt settings cannot be read (lookup error, unresolvable device, a
  remote_access policy whose settings row is missing although the policy carries
  prompt settings, or an unknown stored value), desktop starts and VNC return
  `503 { code: 'REMOTE_PROMPT_POLICY_UNAVAILABLE' }` instead of falling back to
  the notify defaults. Devices with no remote access policy still default to
  notify. A remote_access policy saved without any prompt settings still uses
  the defaults. Fix: re-save the device's remote access policy.
- **Consent audit actions renamed** (a start the device refused is no longer
  recorded as `session_consent_bypassed`). Update any saved audit filters,
  SIEM rules or exports that match on these strings:

  | Outcome (agent `consent_denied` reason) | Before | After |
  |---|---|---|
  | User declined (`user`) | `session_consent_denied` | `session_consent_denied` (unchanged) |
  | Prompt not answered, start refused (`timeout`) | `session_consent_denied` | `session_consent_blocked_unanswered` |
  | Prompt could not be shown/answered, start refused (`helper_absent`, `no_user`, other) | `session_consent_bypassed` | `session_consent_blocked_unavailable` |
  | Started without an answer under *Proceed* | `session_consent_bypassed` | `session_consent_bypassed` (unchanged) |

  Rows written before the upgrade keep their old action names.
- The policy editor's help text for *If no one can respond* now lists every
  case it covers: no one signed in, the consent prompt can't be shown, or the
  signed-in user doesn't answer within 30 seconds.
