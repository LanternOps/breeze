# Quick Support: One-Time Code Ad-Hoc Remote Sessions — Design

**Date:** 2026-07-06
**Status:** Approved (brainstorm with Todd)
**Related:** installer bootstrap tokens (`2026-04-19-a-installer-bootstrap-tokens.sql`, #2161), remote session consent (`2026-06-19-remote-session-consent-notification-design.md`), remote desktop stack (`agent/internal/remote/desktop/`)

## Problem

Techs need to remote into machines that do **not** run a permanently enrolled Breeze agent — a customer's home PC, a prospect's laptop, a machine not yet onboarded. Today the only options are enrolling the device for real or bolting on a third-party tool via the Remote Access provider launcher. Competitors (NinjaOne Quick Access, ScreenConnect ad-hoc support) make this a one-time-code flow.

## Decision summary

- **Flow direction:** tech generates the code in Breeze and sends it to the end user (not user-generated IDs).
- **Architecture:** **ephemeral enrollment** — the support client is the existing Go agent in a `--support` mode that enrolls a short-lived device row, so the entire existing remote-desktop stack (remote_sessions, WebRTC broker, TURN, consent, Tauri viewer, audit) is reused unchanged. Rejected alternative: a purpose-built agentless client with a parallel signaling path — 2-3× the new code, and the required temp-service/UAC capability drags in most of the agent anyway.
- **Elevation:** ScreenConnect-style — user-mode by default, optional one-UAC-prompt temporary service install for full control.
- **Platforms v1:** Windows and macOS.
- **Tenancy:** one hidden **Quick Support org per partner** (lazily created), plus an optional informational attribution to a real customer org.

## User flows

### Technician

1. Clicks **Quick Support** (Remote page / topbar) → dialog with optional attribution (customer org picker + freetext label, e.g. "Contoso — CFO laptop"). Nothing else required.
2. Gets a short one-time code (e.g. `KTM-4H7-P2X`), a copyable link (`https://<region>.2breeze.app/quick/<code>`), and a live status panel.
3. Sends link/code to the end user (phone, email, chat).
4. Status panel: *waiting → client downloaded → connected*. **Connect** starts a normal remote desktop session in the existing Tauri viewer.
5. May disconnect/reconnect multiple times within the session window. **End session** tears everything down.

### End user

1. Opens the link → minimal public landing page: "Your technician wants to help — Download for Windows / Mac", with plain-language copy about what runs and that it removes itself.
2. Runs the download. Code rides in the download filename where possible (MSI-filename pattern; mind the bracket-collision gotcha from #1956); manual code entry is the fallback.
3. Client shows a small status window: "Connected — waiting for technician", with an always-visible **Stop sharing** button. Running the code-bearing client **is** the consent act; the window is the ongoing indicator.
4. Optionally approves one UAC prompt (Windows) / admin prompt (macOS) for elevated control.
5. On session end (tech ends it, user clicks Stop, or TTL reaper fires) the client removes its temporary service and deletes itself.

## Session lifecycle

```
pending ──redeem──▶ claimed ──enroll+WS──▶ ready ◀──disconnect── active
   │ 15-min code TTL                          │        ──connect──▶
   ▼                                          ▼
expired                                    ended (reason: tech | end_user | expired | error)
```

Hard cap `hard_expires_at` (default 8h; partner-configurable later) guarantees no session outlives the day.

## Data model

### `support_sessions` (new table — Shape 1 direct-org RLS)

| Column | Notes |
|---|---|
| `id` uuid PK | |
| `org_id` NOT NULL FK organizations | the partner's hidden Quick Support org |
| `created_by_user_id` FK users | |
| `code_hash` | SHA-256; plaintext shown once at creation, never stored |
| `code_expires_at` | default now + 15 min |
| `failed_attempts` int | per-code lockout counter |
| `status` | `pending / claimed / ready / active / ended / expired` |
| `hard_expires_at` | default now + 8h |
| `device_id` nullable FK devices | set when ephemeral enrollment completes |
| `attributed_org_id` nullable FK organizations | reporting only, no tenancy effect |
| `attribution_label` text nullable | freetext, e.g. "Contoso — CFO laptop" |
| `claimed_at`, `claimed_from_ip`, `ended_at`, `ended_reason`, `created_at` | |

RLS: `breeze_has_org_access(org_id)` select/insert/update/delete policies in the **same migration** that creates the table. Shape 1 is auto-discovered by `rls-coverage.integration.test.ts` — no allowlist entry.

### `organizations.kind` (new column)

`'customer'` (default) | `'quick_support'`. One hidden org per partner, lazily created on first session, with one default site (enrollment keys require `site_id`).

**Exclusion sweep (highest-risk item):** every org enumeration must exclude `kind = 'quick_support'` — org list endpoints/UI, billing & device-count queries, reports, AI tools, alert scopes, anywhere else surfaced by a repo-wide sweep. The implementation plan carries this as an explicit checklist with its own tests (at minimum: device-count/billing query test).

### `devices.is_ephemeral` (new column)

Boolean default false. Ephemeral devices: excluded from partner `maxDevices` license counts; never targeted by policies/automations/patching (belt-and-suspenders — the hidden org has none). Purged by the reaper after session end.

## API surface

### Authenticated (tech) — mounted under existing `/remote` guards: auth + `remote:access` + `requireMfa()`

- `POST /support-sessions` — create; generates code, lazily provisions hidden org + site, audits `support_session_created`.
- `GET /support-sessions`, `GET /support-sessions/:id` — list / live status (status panel polls).
- `POST /support-sessions/:id/end` — pushes `support_end` command over the agent WS, revokes device tokens, marks ended, audits.
- **Connecting reuses `POST /remote/sessions` unchanged** — the ephemeral device is a real device row, so offer/answer/ICE/consent/viewer paths need zero changes.

### Public, unauthenticated (the code is the auth — mirrors `installer.ts` bootstrap redemption)

- `GET /quick/:code` — download landing page (web app route).
- `GET /support/download/:platform` — serves the client via existing `binarySource` machinery, code embedded in filename.
- `POST /support/redeem` — rate-limited (per-IP like `/agents/enroll` + per-code attempt lockout). Atomically flips `pending → claimed`; returns a **single-use child enrollment key** scoped to the hidden org (exact installer-bootstrap pattern). Client then calls the normal `POST /agents/enroll`.

**Enrollment chain guards:** support-derived child keys are flagged so (a) devices born from them are `is_ephemeral = true`, in the hidden org only, and linked back to the support session (`device_id` set; status → `ready` when the agent WS connects); (b) regular enrollment keys can never set the ephemeral flag; (c) support keys can never create persistent devices.

## Support client (Go agent `--support` mode)

One new top-level mode in the existing agent binary — no separate codebase. Skips persistent config, redeems the code, enrolls ephemerally, runs the agent loop with everything disabled except remote desktop + heartbeat, and shows a small status window with **Stop sharing**.

### Elevation tiers (Windows)

- **Tier 1 (default):** runs as the logged-in user, no install. Capture + input in-process in the user's session. UAC prompts / secure desktop are not visible to the tech.
  - *Open verification item:* the capture stack currently runs via the SYSTEM desktop helper; the in-process user-session path must be confirmed or added.
- **Tier 2 (elevated):** at launch, or when the tech requests it mid-session, the client triggers one UAC prompt; on approval it installs itself as a **temporary Windows service** (session-scoped service name) and relaunches under it — full existing agent semantics including the SYSTEM desktop helper, so UAC and the secure desktop are controllable. Service removed at teardown.

### macOS

Ships as a signed + notarized **`.app` wrapper** — TCC attributes Screen Recording/Accessibility permissions to the responsible bundle, so a bare CLI binary is not viable. Status window includes a guided-permissions screen. Uses the agent's existing macOS capture path. Tier 2 = one admin-password prompt installing a temporary LaunchDaemon. Distinct workstream; the largest platform-specific effort.

## Cleanup — three independent layers

1. **Cooperative:** `support_end` command (or Stop button / process exit) → agent stops + deletes its temp service, wipes files, exits. Windows self-delete uses the standard detached delayed-delete trampoline.
2. **Server reaper (BullMQ):** at `hard_expires_at`, or after prolonged agent-offline, force-end the session, revoke device tokens (agent WS drops, cannot reconnect), purge ephemeral device rows a few hours after end. Audit logs survive (no FK to devices).
3. **Client dead-man switch:** support-mode agent self-cleans and exits if it cannot reach the API for N minutes or learns its session ended — nothing lingers even if the server disappears.

## Security

- **Code:** ≥40 bits entropy, human-typeable alphabet (no ambiguous chars), hashed at rest, single-use, 15-min TTL, per-IP rate limiting + per-code failed-attempt lockout.
- **Access:** creating sessions requires `remote:access` + MFA. Session ownership rules follow existing remote_sessions semantics.
- **Containment:** ephemeral tokens revoked at end; hard 8h cap regardless of tech action; support keys ⇄ persistent keys are mutually exclusive (see enrollment chain guards).
- **Consent:** running the code-bearing client is the consent act; the status window is the persistent indicator; per-session desktop connects still flow through the existing consent-prompt config (default for support sessions: notify/off — the user already consented).
- **Audit:** new `support_session_created / claimed / connected / ended / expired` actions via `logSessionAudit`, plus all existing `session_*` actions from the reused remote path.

## Web UI

- Quick Support button + create dialog (attribution org picker + label).
- Live status panel polling `GET /support-sessions/:id`; Connect button fires the existing viewer deep-link flow.
- Support sessions list (active + recent) with connect/end actions.
- All mutation handlers wrapped in `runAction` per repo standard.
- Public landing page for `/quick/<code>`.

## Testing

- **API route tests** (Vitest + Drizzle mocks): create/redeem/end happy paths + guards (expired code, lockout, wrong status transitions, RBAC/MFA, cross-tenant).
- **RLS integration tests:** new table auto-discovered by coverage test; forge cross-tenant redeem/enroll as `breeze_app` — must fail.
- **Integration test:** the full redeem → child-key → ephemeral-enroll chain against real Postgres, proving flags and linkage.
- **Go tests:** table-driven tests for `--support` mode argument handling, lifecycle state machine, self-clean/dead-man logic.
- **Validator tests:** new Zod schemas in `packages/shared`.
- **Exclusion sweep tests:** device-count/billing queries proven to ignore `quick_support` orgs and ephemeral devices.

## Phasing

1. **Phase 1:** Windows, Tiers 1+2, end-to-end (schema, API, web UI, agent support mode, cleanup layers).
2. **Phase 2:** macOS `.app` packaging, notarization, TCC guided flow, LaunchDaemon tier.
3. **Phase 3:** niceties — mid-session elevation request UX polish, partner-configurable TTLs, session history reporting by attributed org.

## Out of scope (v1)

- User-generated codes / anonymous session queue (TeamViewer-style).
- Temporary time-boxed access to already-enrolled devices (the session/code model doesn't preclude it later).
- Linux end-user client.
- Terminal / file-transfer tools in support sessions (desktop only; the ephemeral device technically supports them — explicitly disabled in v1 to keep the consent story simple).
