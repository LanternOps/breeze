# PAM Task — Attribute an elevation to the session that actually raised it

## Context & authorization

Breeze RMM's **Privileged Access Management (PAM)** feature governs and audits
Windows UAC elevations on managed endpoints. To evaluate policy and to place the
elevated application back in front of the right administrator, Breeze must know
**which logged-on session raised the prompt**. On multi-user Windows hosts
(Terminal Server / RDS, or any server reached over RDP) several administrators may
be signed in at once. This task makes the attribution correct for those hosts. It
is administrative/defensive functionality authorized by the managing MSP.

## Problem

Detection currently attributes every intercepted UAC prompt to the **physical
console** session's user:

- `decodeConsentRequest` — `agent/internal/etwlua/etwlua_windows.go:162`
- `resolveConsentUser` → `lookupConsoleUser` — `:209` / `:223`, which calls
  `WTSGetActiveConsoleSessionId()` (`:224`).

Consequences (hardware-validated 2026-07-16, Finding 1):

- If the physical console has **no** logged-on user (the normal case on an
  RDP-only server), `WTSQueryUserToken` fails, the subject resolves to `""`, and
  the event is dropped **silently** (`decodeConsentRequest` returns `ok=false`
  with no log). PAM never engages.
- If the console *is* signed in but the prompt was raised in a different (RDP)
  session, the request is misattributed and the elevated app would land in the
  wrong session.

## Goal / acceptance criteria

- A UAC prompt raised in interactive session *N* is attributed to session *N*'s
  user, regardless of which session is the physical console.
- The elevated application launched by the actuator lands in session *N* (the
  requester's session).
- On the empty-console case, detection still succeeds (attributes to the real
  requester) instead of silently dropping.
- Console attribution remains the fallback when no better signal is available.
- Add a debug log on any drop so "no subject" is never silent again.

## Recommended approach (pragmatic, lower-risk): resolve from the live `consent.exe`

The `consent.exe` process runs **in the requester's session**, and it is alive at
the moment the 15028 event fires (that is exactly when it launches). So at decode
time:

1. Enumerate running `consent.exe` processes; take the newest (or the one started
   within the dedupe window).
2. Read its `SessionId` (`ProcessIdToSessionId`, or the Toolhelp/`WTSEnumerate`
   session for the pid).
3. `WTSQueryUserToken(sessionId)` → token → account name = the subject user.
4. Carry `sessionId` forward as the resolved target session for the actuator.

This avoids reverse-engineering the ETW payload and is robust across Windows
builds.

## Alternative (proper, more work): parse SubjectSessionID from the 15028 payload

The Microsoft-Windows-LUA 15028 UserData begins with a header (request id, session
token, string-offset table) — `parseConsentPayload`
(`agent/internal/etwlua/etwlua_windows.go`, ~`:150+`) currently skips the header
and only scans the trailing UTF-16 strings. The header carries the requesting
session id. Extracting it requires validating the header layout against live
captures on each supported Windows build. Prefer the `consent.exe` approach unless
that proves unreliable.

## Files to touch

- `agent/internal/etwlua/etwlua_windows.go` — resolver change (`resolveConsentUser`
  / `lookupConsoleUser` → session-aware resolution); populate a new
  `SubjectSessionID` on the event.
- `agent/internal/etwlua/etwlua.go` — add `SubjectSessionID uint32` to the `Event`
  struct (cross-platform; zero on non-Windows/fake subscriber). Add a debug log on
  the empty-subject drop.
- `agent/internal/pamactuator/session_resolve.go` — add a
  `source = "subject_session"` branch that prefers the event's resolved session id,
  ahead of `username_lookup` and `console_fallback` (`:32`).
- `agent/internal/pamactuator/tokenlaunch_windows.go` — ensure the resolved
  session id is threaded into `CreateProcessAsUser`'s target session.
- Plumbing: wherever the `Request`/`pamTarget` is built from the event
  (`grep -rn 'pamTarget\|Request{' agent/internal/`) — carry `SubjectSessionID`
  through so the local `RunPamFlow` path has it. (The remote actuate path can keep
  console-fallback until a server payload field exists — out of scope here.)

## Implementation steps

1. Add `SubjectSessionID uint32` to `etwlua.Event`.
2. In `decodeConsentRequest`: resolve subject via the `consent.exe`-session lookup
   above; set both `SubjectUsername` and `SubjectSessionID`. Fall back to
   `WTSGetActiveConsoleSessionId` only if the consent-session lookup yields
   nothing. Emit `log.Debug` (not silent) when even the fallback is empty.
3. In `session_resolve.go`, prefer `SubjectSessionID` when non-zero
   (`source="subject_session"`), then existing branches.
4. Thread `SubjectSessionID` from the event → `Request` → actuator so
   `CreateProcessAsUser` targets it.
5. Keep console attribution as the last-resort fallback for single-session hosts.

## Testing / verification

- Two administrators signed in (console + one RDP session). Each raises a
  policy-approved UAC elevation; assert each request is attributed to the
  respective user and the elevated app lands in that user's session.
- RDP-only host (empty console): assert detection now fires and attributes to the
  RDP user instead of dropping.
- Single-session host: unchanged (fallback path).

## Out of scope

- Server-side requesting-user resolution for the *remote* actuate path (needs a
  new payload field on `elevation_requests` / the `actuate_elevation` command).
- The dialog/dismiss desktop work (Tasks 2 and 3).

## Risks / notes

- Multiple concurrent `consent.exe` instances (parallel prompts) — disambiguate by
  start time within the dedupe window and, where possible, cross-check the target
  path.
- `WTSQueryUserToken` requires SYSTEM (the agent already runs as LocalSystem).
