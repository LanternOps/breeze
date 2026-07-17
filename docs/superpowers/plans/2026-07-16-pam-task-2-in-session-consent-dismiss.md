# PAM In-Session Consent Dismissal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear a denied UAC prompt from the interactive Windows session that owns it instead of attempting dismissal from the Session 0 agent service.

**Architecture:** Add a typed `pam_dismiss_consent` IPC request/result on the existing authenticated SYSTEM-helper channel. The broker validates `HelperRoleSystem` plus `ScopePam`, sends an absolute input deadline that expires before its response timeout, and the target-session helper passes that deadline to `pamactuator.Dismiss`. `RunPamFlow` reuses the exact helper session selected for the PAM dialog. The service keeps `pamActuateMu` locked across the synchronous IPC round trip so approve and deny input cannot overlap. If the round trip becomes uncertain, the broker retains response correlation and the heartbeat remains fail-closed until the helper's late response proves dismissal is quiescent.

**Tech Stack:** Go, Breeze agent IPC envelopes, Windows session-bound SYSTEM helper, `pamactuator`, Go `testing` with `-race`.

## Global Constraints

- Never fall back to `pamactuator.Dismiss` in the Session 0 service; it cannot reach the target session's input desktop.
- PAM dismissal is authorized only for a helper with `HelperRoleSystem` and `ScopePam`.
- Reuse the exact selected PAM helper session after a dialog result; hard policy denials resolve the console-bound PAM helper first.
- Preserve fail-closed behavior: missing helper, transport failure, malformed response, or helper error must never actuate elevation.
- Preserve result semantics: `no_consent_window` is benign/already closed; other non-success reasons warn that the prompt may remain live.
- Keep `pamActuateMu` held for the synchronous helper round trip. If completion becomes uncertain, reject later PAM actuation and repeated dismissal without credential promotion or input until the authenticated late response proves quiescence.
- Bound the target-session input window before the broker timeout: reserve response grace in the broker-generated absolute deadline, reject missing or expired deadlines in the helper, check cancellation immediately before sending Escape, and keep later input fail-closed until a late completion is proven.
- Do not add dependencies or alter the IPC protocol version.

---

### Task 1: Typed IPC and broker round trip

**Files:**
- Modify: `agent/internal/ipc/message.go`
- Modify: `agent/internal/ipc/message_test.go`
- Modify: `agent/internal/sessionbroker/session.go`
- Create: `agent/internal/sessionbroker/pam_dismiss_test.go`
- Modify: `agent/internal/sessionbroker/broker.go`

**Interfaces:**
- Produces: `ipc.TypePamDismissConsent`, `ipc.TypePamDismissConsentResult`, `ipc.PamDismissConsentRequest`, and `ipc.PamDismissConsentResult`.
- Produces: `(*sessionbroker.Broker).DismissPamConsent(session *Session, id string, timeout time.Duration) (ipc.PamDismissConsentResult, error)`.

- [ ] **Step 1: Write failing IPC and broker tests**

  Add exact constant and JSON round-trip assertions for:

  ```go
  const TypePamDismissConsent = "pam_dismiss_consent"
  const TypePamDismissConsentResult = "pam_dismiss_consent_result"

  type PamDismissConsentRequest struct {
      DeadlineUnixMs int64 `json:"deadlineUnixMs"`
  }
  type PamDismissConsentResult struct {
      Success       bool   `json:"success"`
      Reason        string `json:"reason"`
      DetailMessage string `json:"detailMessage,omitempty"`
  }
  ```

  Add broker cases for a successful same-ID/type round trip, wrong helper role, missing PAM scope, error envelope, malformed result JSON, wrong response type, and timeout.

- [ ] **Step 2: Verify RED**

  Run:

  ```bash
  cd agent
  go test -race ./internal/ipc ./internal/sessionbroker
  ```

  Expected: compile/test failure because the new IPC types and `DismissPamConsent` do not exist.

- [ ] **Step 3: Implement the minimal IPC contract**

  Add the types above. Extend `expectedResponseType` so `TypePamDismissConsent` requires `TypePamDismissConsentResult`.

  Implement `DismissPamConsent` with the same SYSTEM-role/PAM-scope checks as `RequestPamApproval`, then:

  ```go
  resp, quiesced, err := session.sendCommandWithQuiescence(
      id,
      ipc.TypePamDismissConsent,
      ipc.PamDismissConsentRequest{DeadlineUnixMs: deadline.UnixMilli()},
      timeout,
  )
  ```

  Treat envelope errors and JSON failures as Go errors. Return a decoded non-success result without converting it to a transport error. On a timeout or uncertain transport failure after dispatch, retain the pending response correlation and return a `PamDismissUncertainError` whose `Quiesced` channel closes only when the valid late helper response arrives.

- [ ] **Step 4: Verify GREEN**

  Run the Task 1 command and require both packages to pass under `-race`.

---

### Task 2: Target-session SYSTEM-helper handler

**Files:**
- Modify: `agent/internal/userhelper/client.go`
- Create: `agent/internal/userhelper/pam_dismiss_test.go`

**Interfaces:**
- Consumes: Task 1's typed request/result messages.
- Produces: `(*Client).handlePamDismissConsent(env *ipc.Envelope)`.

- [ ] **Step 1: Write failing handler tests**

  Add an injectable package-level actuator factory defaulting to `pamactuator.New`. Test that:

  - SYSTEM + PAM scope invokes `Dismiss` exactly once and replies with the same envelope ID and `TypePamDismissConsentResult`.
  - A non-success actuator result preserves `Success`, `Reason`, and `DetailMessage`.
  - Wrong role or missing scope sends an error response and never invokes the actuator.
  - An actuator panic is contained by the existing `safeGo` boundary and returns promptly rather than crashing the helper.

- [ ] **Step 2: Verify RED**

  Run:

  ```bash
  cd agent
  go test -race ./internal/userhelper
  ```

  Expected: compile/test failure because the handler and dispatch case do not exist.

- [ ] **Step 3: Implement the minimal handler**

  Add a `commandLoop` case for `ipc.TypePamDismissConsent`. The handler independently checks:

  ```go
  if c.role != ipc.HelperRoleSystem || !c.hasScope(ipc.ScopePam) {
      // SendError with the request ID and TypePamDismissConsentResult.
      return
  }
  ```

  Reject a missing or expired `DeadlineUnixMs`, derive a context with that absolute deadline, and call `pamactuator.New().Dismiss(ctx)` through the test seam. Copy its fields into `ipc.PamDismissConsentResult` and send the typed response. The Windows actuator checks cancellation immediately before sending Escape and reports the stable `dismiss_cancelled` reason when the deadline closes.

- [ ] **Step 4: Verify GREEN**

  Run the Task 2 command and require the package to pass under `-race`.

---

### Task 3: Route every PAM denial through the selected helper session

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go`
- Modify: `agent/internal/heartbeat/pam_flow.go`
- Modify: `agent/internal/heartbeat/pam_flow_test.go`

**Interfaces:**
- Consumes: `(*Broker).DismissPamConsent` from Task 1.
- Produces: a `pamDismissConsent` test seam matching the broker signature.

- [ ] **Step 1: Rewrite denial tests before production code**

  Replace service-local fake-actuator dismissal expectations with a broker-dismiss fake. Assert:

  - hard policy deny resolves a PAM helper and sends dismissal to it without showing the dialog;
  - user deny and dialog-round-trip error dismiss through the exact `*Session` used for the dialog;
  - missing broker or matching helper makes no dismissal attempt and never invokes the Session 0 actuator;
  - `no_consent_window`, real actuator failures, and IPC errors do not panic;
  - `pamActuateMu` serializes `actuateElevation` against the full synchronous dismiss callback;
  - uncertain dismissal completion rejects later actuation before credential promotion and skips overlapping dismissals until the helper's correlated response proves quiescence.

- [ ] **Step 2: Verify RED**

  Run:

  ```bash
  cd agent
  go test -race ./internal/heartbeat
  ```

  Expected: compile/assertion failure because `RunPamFlow` still dismisses locally.

- [ ] **Step 3: Implement same-session denial routing**

  Add the injectable broker-dismiss field to `Heartbeat`. Resolve the PAM session before processing hard deny. Change `denyConsent` to accept the selected session, hold `pamActuateMu`, call the injectable function or `sessionBroker.DismissPamConsent`, and retain the existing log classification. Track uncertain completion under the same mutex: later actuation returns `dismissal_uncertain` before promotion/input, repeated denials are skipped, and the state clears only after the helper's correlated response closes the quiescence channel.

  Use a broker timeout slightly above the actuator's internal eight-second ceiling:

  ```go
  const pamDismissTimeout = 10 * time.Second
  ```

  Remove the service-local `newActuator().Dismiss(ctx)` path entirely. Continue to use the service actuator for approved actuation only.

- [ ] **Step 4: Verify GREEN**

  Run the Task 3 command and require the package to pass under `-race`.

---

### Task 4: Cross-package verification

**Files:**
- Test only; no production changes unless verification exposes a defect.

- [ ] **Step 1: Run focused race tests**

  ```bash
  cd agent
  go test -race ./internal/ipc ./internal/sessionbroker ./internal/userhelper ./internal/heartbeat
  ```

- [ ] **Step 2: Run the full agent race suite**

  ```bash
  cd agent
  go test -race ./...
  ```

- [ ] **Step 3: Cross-compile affected Windows packages**

  ```bash
  cd agent
  GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go test -c -o /tmp/breeze-userhelper.test.exe ./internal/userhelper
  GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go test -c -o /tmp/breeze-sessionbroker.test.exe ./internal/sessionbroker
  GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go test -c -o /tmp/breeze-heartbeat.test.exe ./internal/heartbeat
  ```

- [ ] **Step 4: Run formatting, vet, and diff checks**

  ```bash
  cd agent
  gofmt -w internal/ipc/message.go internal/ipc/message_test.go internal/sessionbroker/session.go internal/sessionbroker/broker.go internal/sessionbroker/pam_dismiss_test.go internal/userhelper/client.go internal/userhelper/pam_dismiss_test.go internal/heartbeat/heartbeat.go internal/heartbeat/pam_flow.go internal/heartbeat/pam_flow_test.go
  go vet ./internal/ipc ./internal/sessionbroker ./internal/userhelper ./internal/heartbeat
  cd ..
  git diff --check
  ```

- [ ] **Step 5: Request one independent code review**

  Review the complete task diff against the Global Constraints, fix every Critical or Important finding, and rerun the covering tests for any fix.
