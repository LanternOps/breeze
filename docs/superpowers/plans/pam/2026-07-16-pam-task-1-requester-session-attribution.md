# PAM Requester Session Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attribute each intercepted UAC request to the interactive Windows session that owns the live `consent.exe`, then route the PAM dialog and denial handling through that session's SYSTEM helper instead of always targeting the physical console.

**Architecture:** The Windows ETW decoder enumerates recent trusted `consent.exe` processes, selects the newest one inside the existing 30-second dedupe window, resolves its process SessionId to the logged-on user, and stores both values on the local event. Pure candidate-selection and fallback logic lives in a platform-neutral file so it is race-testable off Windows; Win32 process and WTS calls remain in a Windows-only adapter. `RunPamFlow` passes the decimal resolved SessionId into the broker's existing exact-session PAM selection, while a zero SessionId preserves the existing console fallback.

**Tech Stack:** Go, Win32 Toolhelp/process/WTS APIs via `golang.org/x/sys/windows`, Breeze session broker, Go `testing` with `-race`.

## Global Constraints

- Trust only the real `%SystemRoot%\\System32\\consent.exe` image path; a same-name process elsewhere must never influence attribution.
- Only consider consent processes created within the existing 30-second ETW dedupe window; choose the newest qualifying process.
- Session `0` and `0xFFFFFFFF` are not interactive requester sessions.
- Resolve the user from the selected SessionId with `WTSQueryUserToken`; remove the global 60-second console-user cache because it crosses session identities.
- Preserve console attribution as the last-resort fallback when no trusted recent consent process and session user can be resolved.
- A request with no subject after consent-session and console fallback must be dropped with a debug log, never silently.
- `SubjectSessionID` is local-only (`json:"-"`); the corrected `SubjectUsername` continues to be the server-visible attribution.
- PAM helper selection must use the resolved SessionId exactly. The broker must retain its existing no-cross-session-fallback behavior for PAM.
- Do not import the unmerged Path B token-launch subsystem (`pamactuator/session_resolve.go` / `tokenlaunch_windows.go`) from the sibling branch. This branch's scope is requester attribution and exact helper routing.
- Do not add dependencies or alter the IPC protocol.

---

### Task 1: Resolve the requester from the live consent process

**Files:**
- Modify: `agent/internal/etwlua/etwlua.go`
- Create: `agent/internal/etwlua/requester_session.go`
- Create: `agent/internal/etwlua/requester_session_test.go`
- Create: `agent/internal/etwlua/requester_session_windows.go`
- Modify: `agent/internal/etwlua/etwlua_windows.go`

**Interfaces:**
- Produces: `Event.SubjectSessionID uint32` with `json:"-"`.
- Produces: `consentProcessCandidate`, `selectNewestConsentProcess`, and `resolveRequesterSessionWith` as platform-neutral attribution logic.
- Produces: `resolveRequesterSession() (username string, sessionID uint32, source string)` backed by trusted Toolhelp/WTS lookups on Windows.

- [ ] **Step 1: Write failing platform-neutral resolver tests**

  Add table-driven tests proving:

  - the newest recent trusted System32 `consent.exe` wins and its SessionId resolves the user;
  - matching is case-insensitive and accepts the Win32 `\\?\\` path prefix;
  - a newer same-name process outside System32 is ignored;
  - processes older than `dedupeWindow`, in Session 0, or with SessionId `0xFFFFFFFF` are ignored;
  - an unresolved consent candidate falls back to the console session user;
  - no consent candidate uses the console fallback;
  - no consent user and no console user returns an empty resolution.

  Also add an event JSON test that sets `SubjectSessionID` and asserts `subject_session_id` is absent from the marshaled payload.

- [ ] **Step 2: Verify RED**

  Run:

  ```bash
  cd agent
  go test -race ./internal/etwlua
  ```

  Expected: compile failures because `SubjectSessionID`, `consentProcessCandidate`, `selectNewestConsentProcess`, and `resolveRequesterSessionWith` do not exist.

- [ ] **Step 3: Implement the platform-neutral resolver**

  Add the local-only event field:

  ```go
  SubjectSessionID uint32 `json:"-"`
  ```

  Define a candidate with `PID`, `SessionID`, `ImagePath`, and `StartedAt`. Normalize Windows paths by trimming whitespace, accepting an optional `\\?\\` prefix, converting `/` to `\\`, trimming trailing separators, and comparing case-insensitively. `selectNewestConsentProcess` must enforce the trusted image path, valid interactive SessionId, non-zero creation time, and `0 <= now-StartedAt <= dedupeWindow` before choosing the latest candidate (highest PID as a deterministic exact-time tie-break).

  `resolveRequesterSessionWith` must resolve the selected candidate's SessionId to a user first, then try the console SessionId, returning source strings `consent_process`, `console_fallback`, or `unresolved`.

- [ ] **Step 4: Implement the Windows adapter and ETW wiring**

  In `requester_session_windows.go`:

  - obtain the trusted path with `windows.GetSystemWindowsDirectory()` plus `System32\\consent.exe`;
  - enumerate processes with `CreateToolhelp32Snapshot` / `Process32First` / `Process32Next`;
  - shortlist `consent.exe` by basename, then open each with `PROCESS_QUERY_LIMITED_INFORMATION`;
  - read the full image path with `QueryFullProcessImageName`, creation time with `GetProcessTimes`, and SessionId with `ProcessIdToSessionId`;
  - resolve a session user with `WTSQueryUserToken`, `GetTokenUser`, and `LookupAccount`.

  In `decodeConsentRequest`, call `resolveRequesterSession`, set both `SubjectUsername` and `SubjectSessionID`, and emit debug logs for an unparseable payload and for a final empty-subject drop. Remove `consentUserCache`, `resolveConsentUser`, and `lookupConsoleUser` so identities are never cached across sessions.

- [ ] **Step 5: Verify GREEN and Windows compilation**

  Run:

  ```bash
  cd agent
  go test -race ./internal/etwlua
  GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go test -c -o /tmp/breeze-etwlua.test.exe ./internal/etwlua
  ```

  Expected: host race tests pass and the Windows test binary compiles.

---

### Task 2: Route PAM through the resolved requester session

**Files:**
- Modify: `agent/internal/heartbeat/pam_flow.go`
- Modify: `agent/internal/heartbeat/pam_flow_test.go`

**Interfaces:**
- Consumes: `etwlua.Event.SubjectSessionID` from Task 1.
- Preserves: `Heartbeat.pamFindSession(capability, targetWinSession string)` and broker exact-session selection.

- [ ] **Step 1: Rewrite the PAM flow test before production code**

  Update the table seam to record `targetWinSession`. Add/adjust cases proving:

  - a valid non-zero `SubjectSessionID` other than `0xFFFFFFFF` is passed to `pamFindSession` as an unsigned base-10 string for approve, pending, and hard-deny paths;
  - the exact selected session is still reused by dialog and dismissal;
  - a zero or `0xFFFFFFFF` `SubjectSessionID` passes `""`, retaining console fallback for unresolved, old, fake, and non-Windows events;
  - when no helper exists in the exact target session, no dialog, dismissal, credential promotion, or input actuation occurs.

- [ ] **Step 2: Verify RED**

  Run:

  ```bash
  cd agent
  go test -race ./internal/heartbeat
  ```

  Expected: assertion failure because `RunPamFlow` still passes an empty target for a non-zero requester session.

- [ ] **Step 3: Implement exact-session targeting**

  Build `targetWinSession` as `""` for zero or `0xFFFFFFFF` and `strconv.FormatUint(uint64(ev.SubjectSessionID), 10)` otherwise, then call:

  ```go
  session := find(ipc.ScopePam, targetWinSession)
  ```

  Update comments and structured logs to distinguish requester-session targeting from console fallback. Do not change broker fallback rules or the task-2 same-session dialog/dismiss reuse.

- [ ] **Step 4: Verify GREEN**

  Run:

  ```bash
  cd agent
  go test -race ./internal/heartbeat ./internal/sessionbroker
  ```

  Expected: both packages pass under the race detector.

---

### Task 3: Cross-package verification

**Files:**
- Test only; no production changes unless verification exposes a defect.

- [ ] **Step 1: Run focused race tests**

  ```bash
  cd agent
  go test -race ./internal/etwlua ./internal/heartbeat ./internal/sessionbroker ./internal/userhelper ./internal/pamactuator
  ```

- [ ] **Step 2: Run the full agent race suite**

  ```bash
  cd agent
  go test -race ./...
  ```

- [ ] **Step 3: Cross-compile affected Windows packages**

  ```bash
  cd agent
  GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go test -c -o /tmp/breeze-etwlua.test.exe ./internal/etwlua
  GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go test -c -o /tmp/breeze-heartbeat.test.exe ./internal/heartbeat
  GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go test -c -o /tmp/breeze-sessionbroker.test.exe ./internal/sessionbroker
  ```

- [ ] **Step 4: Run formatting, vet, and diff checks**

  ```bash
  cd agent
  gofmt -w internal/etwlua/etwlua.go internal/etwlua/etwlua_windows.go internal/etwlua/requester_session.go internal/etwlua/requester_session_windows.go internal/etwlua/requester_session_test.go internal/heartbeat/pam_flow.go internal/heartbeat/pam_flow_test.go
  go vet ./internal/etwlua ./internal/heartbeat ./internal/sessionbroker
  cd ..
  git diff --check
  ```

- [ ] **Step 5: Complete independent review**

  Review each implementation task for spec compliance and code quality, then review the complete branch against the Global Constraints. Fix every Critical or Important finding and rerun the covering tests.
