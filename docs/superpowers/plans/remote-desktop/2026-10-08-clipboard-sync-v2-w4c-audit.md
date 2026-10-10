
# W4c — Clipboard summary to central audit (#8261)

**Goal:** each remote-desktop session that moved clipboard data, or had a transfer blocked by policy,
leaves exactly one `audit_logs` row: `resourceType remote_session`, action
`session_clipboard_summary`. The row holds direction × type → count and bytes, plus the blocked
count. Never any content. This closes `TODO(#1012)` for clipboard.

**Contract decision — a separate message, not an extension of `desk-disconnect`:**
- `desktopCommandResultSchema.result` is `.strict()`. An API that predates this change drops any
  result carrying an unknown key as malformed. Adding `clipboard` to `desk-disconnect` would
  therefore lose the disconnect itself (the session would stay `active`) on every self-hosted API
  older than its agents.
- The summary rides its own `command_result` instead:
  `commandId: "desk-clipsum-<sessionId>"`, `status: "completed"`, and
  `result: {sessionId, event: "clipboard_summary", clipboard: {transfers:[{direction,type,count,bytes}], blocked}}`.
- An older API drops it with one warning and has no session impact. A new API writes the row.

**Flow:**
1. `Session.doCleanup` runs exactly once (`cleanupOnce`). When the session's `ClipboardSync` has a
   non-empty `Summary()`, it calls `onClipboardSummary(sessionID, ipc.ClipboardSummary)`. That hook
   is copied from `SessionManager.OnClipboardSummary` at session creation, like `sasHandler`.
2. **Direct mode** (`heartbeat.go`, next to `OnSessionStopped`): calls
   `h.sendDesktopClipboardSummary`, which sends `desk-clipsum-<id>`.
3. **Helper mode** (`userhelper/client.go`): IPC `TypeDesktopClipboardSummary`
   (`"desktop_clipboard_summary"`) carrying `DesktopClipboardSummaryNotice{SessionID, Clipboard}`.
   - The broker allowlists it in both switches, with `desktop` scope.
   - The service validates the session-id pattern and that the helper owns the session, **or owned it
     within the last 2 minutes**. `forgetDesktopOwner` runs on stop and peer-disconnect before the
     summary can arrive, so the service keeps a short-lived record of recently ended owners.
   - The service then sends `desk-clipsum-<id>`.
4. **API** (`agentWs.ts` desk fast path):
   - **Schema:** `event` gains `clipboard_summary`. `result.clipboard` is `.strict()`:
     - `transfers` has at most 6 entries;
     - `direction` is in {`host_to_viewer`, `viewer_to_host`};
     - `type` is in {`text`, `rtf`, `image`};
     - counts and bytes are bounded non-negative integers.
   - **Handler:** calls `recordDesktopClipboardSummary` (`services/desktopClipboardAudit.ts`, which
     takes injectable deps). That function:
     - resolves the session by id **and** the authenticated agent's `deviceId`, and does nothing if
       there is no match;
     - dedupes on an existing audit row for the session and action, because outbox resends can
       repeat the message;
     - writes through `logSessionAudit(..., 'agent')` with `sessionOwnerId`, `deviceId`, and
       `reportedBy:'authenticated_agent'`.

**Tests:**
- **Agent:**
  - `doCleanup` emits once, and not when the summary is empty;
  - payload bounding and sanitising;
  - recently-ended owner TTL;
  - broker allowlist for the new type.
- **API:**
  - schema accept and reject cases;
  - `recordDesktopClipboardSummary`: writes one row, rejects a device mismatch, dedupes, and skips
    an empty summary;
  - `agentWs` wiring: calls the service with the parsed summary, and ignores a session-id
    mismatch.

## W4c review amendments (2026-10-08, independent Opus review: 0 critical / 0 high)

- **M1:** the agent saturates the summary counters to the API's bounds (count and blocked at 1e6,
  bytes at 1e12). An over-limit value made the strict schema reject the whole summary, so a
  technician could erase their own session's audit row by spamming blocked frames. Test:
  `TestDesktopClipboardSummaryPayloadClampsToAPIBounds`.
- **L1:** ended-owner tombstones are swept whenever a new one is stored, cleared when the session is
  re-owned, and consumed by the one accepted report. Tests: `TestForgetDesktopOwnerSweeps…`,
  `TestRememberDesktopOwnerClearsTombstone`, and the handler test.
- **L2:** `forgetDesktopOwner` stores the tombstone before removing the owner (`CompareAndDelete`).
- **L3:** the API's existence check and insert run in one system transaction under
  `pg_advisory_xact_lock(hashtextextended('clipboard-summary:'||sessionId, 0))`. Concurrent copies
  of one report can no longer write two rows.
- **Test gap closed:** `TestHandleUserHelperMessageForwardsClipboardSummary` drives the IPC handler
  end to end. It covers the owner, a recently ended owner, another helper, a malformed id, and a
  second report.

Still open: an integration test against real Postgres for `writeAuditOnce`. That needs the test
stack, so it's listed as an owed item on the PR.
