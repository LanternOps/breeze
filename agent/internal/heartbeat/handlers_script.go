package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/executor"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

func init() {
	handlerRegistry[tools.CmdScript] = handleScript
	handlerRegistry[tools.CmdRunScript] = handleScript
	handlerRegistry[tools.CmdScriptCancel] = handleScriptCancel
	handlerRegistry[tools.CmdScriptListRunning] = handleScriptListRunning
}

func handleScript(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	script := executor.ScriptExecution{
		ID:         cmd.ID,
		ScriptID:   tools.GetPayloadString(cmd.Payload, "scriptId", ""),
		ScriptType: tools.GetPayloadString(cmd.Payload, "language", "bash"),
		Script:     tools.GetPayloadString(cmd.Payload, "content", ""),
		Timeout:    tools.GetPayloadInt(cmd.Payload, "timeoutSeconds", 300),
		RunAs:      tools.GetPayloadString(cmd.Payload, "runAs", ""),
	}
	script.RunAs = strings.TrimSpace(script.RunAs)
	if params, ok := cmd.Payload["parameters"].(map[string]any); ok {
		script.Parameters = make(map[string]string, len(params))
		for k, v := range params {
			if s, ok := v.(string); ok {
				script.Parameters[k] = s
			}
		}
	}
	if script.Script == "" {
		return tools.CommandResult{
			Status: "failed",
			// Synthetic exit code: no process ran (see tools.CommandResult.ExitCode).
			ExitCode:   1,
			Error:      "script content is empty",
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	targetSessionID := -1
	if ts, ok := cmd.Payload["targetSessionId"].(float64); ok && ts >= 0 && ts <= 65535 {
		targetSessionID = int(ts)
	}

	// Explicit session targeting (RDS phase 1): route to exactly that
	// session's user-role helper. Only meaningful for user-context runs — the
	// API rejects targetSessionId with runAs!=user (Task 8).
	//
	// No runtime.GOOS gate here: h.helperLifecycle (the on-demand/RDS lease
	// manager) IS Windows+service-gated in production (heartbeat.go), so the
	// on-demand branch inside executeScriptInSession is safe to leave
	// platform-agnostic and stays exercisable in cross-platform unit tests
	// via the fake lifecycle. h.sessionBroker is NOT Windows-gated — it is
	// also constructed for macOS/Linux daemons (UserHelperEnabled ||
	// IsService || IsHeadless) — so executeScriptInSession's *always-on*
	// branch (FindUserSession) carries its own Windows check instead: on
	// Unix, Session.WinSessionID is actually the UID/identity key, and
	// matching a numeric targetSessionId against it would risk silently
	// hitting an unrelated user's helper.
	if targetSessionID >= 0 && h.sessionBroker != nil && strings.EqualFold(script.RunAs, "user") {
		return h.executeScriptInSession(cmd, script, uint32(targetSessionID), start)
	}

	// Phase 3: If runAs is specified and a user helper is connected, forward via IPC
	if script.RunAs != "" && h.sessionBroker != nil {
		if session := resolveRunAsSession(h.sessionBroker, script.RunAs); session != nil {
			return h.executeViaUserHelper(session, cmd, script.Timeout)
		}
	}
	if strings.EqualFold(script.RunAs, "user") {
		// No eligible user helper for a user-context run. The local executor
		// would reject this anyway (executor.configureRunAs), but only after a
		// misleading "downgraded to SYSTEM" warning; on multi-user / RDS hosts
		// the real cause is the console-session delivery binding (#1009).
		// Fail fast, before any process spawn, with the actual reason.
		msg := "runAs=user requires a connected user helper session; no eligible session found (script was not executed)"
		if h.lifecycleMode() == "on-demand" {
			// On an RDS host at rest there are no helpers to find — the
			// caller must target a session. Name the candidates so the tech
			// can retry without a round trip.
			msg = "runAs=user on an RD Session Host requires targetSessionId; eligible sessions: " + eligibleSessionsSummary()
		}
		return tools.CommandResult{
			Status: "failed",
			// Synthetic exit code: no process ran (see tools.CommandResult.ExitCode).
			ExitCode:   1,
			Error:      msg,
			DurationMs: time.Since(start).Milliseconds(),
		}
	}
	if script.RunAs != "" && h.sessionBroker != nil &&
		!strings.EqualFold(script.RunAs, "system") && !strings.EqualFold(script.RunAs, "elevated") {
		// Explicit-username delivery didn't resolve to a helper; the local
		// executor may still honour it (sudo on unix), so this path remains a
		// fallthrough — but record it accurately.
		log.Warn("runAs username did not resolve to a helper session; attempting local executor fallback",
			"runAs", script.RunAs, "commandId", cmd.ID)
	}

	scriptResult, execErr := h.executor.Execute(script)
	if execErr != nil && scriptResult == nil {
		return tools.NewErrorResult(execErr, time.Since(start).Milliseconds())
	}

	status := "completed"
	if scriptResult.ExitCode != 0 {
		status = "failed"
	}
	if scriptResult.Error != "" && strings.Contains(scriptResult.Error, "timed out") {
		status = "timeout"
	}
	return tools.CommandResult{
		Status:     status,
		ExitCode:   scriptResult.ExitCode,
		Stdout:     executor.SanitizeOutput(scriptResult.Stdout),
		Stderr:     executor.SanitizeOutput(scriptResult.Stderr),
		Error:      scriptResult.Error,
		DurationMs: time.Since(start).Milliseconds(),
	}
}

func resolveRunAsSession(broker *sessionbroker.Broker, runAs string) *sessionbroker.Session {
	target := strings.TrimSpace(runAs)
	if target == "" || strings.EqualFold(target, "system") || strings.EqualFold(target, "elevated") {
		return nil
	}

	// runAs=user means "current interactive user". Prefer a user-role helper
	// (runs as the logged-in user) over a SYSTEM helper. On Windows the
	// candidate is constrained to the active console session so a co-logged-in
	// user's helper can't intercept the script (#1009).
	if strings.EqualFold(target, "user") {
		return broker.PreferredRunAsUserSession()
	}

	// Legacy path: explicit usernames still resolve directly.
	return broker.SessionForUser(target)
}

func handleScriptCancel(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	executionID, errResult := tools.RequirePayloadString(cmd.Payload, "executionId")
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}

	if err := h.executor.Cancel(executionID); err != nil {
		if h.sessionBroker == nil {
			return tools.NewErrorResult(err, time.Since(start).Milliseconds())
		}

		var helperErr error
		for _, session := range h.runAsHelperSessions() {
			resp, sendErr := h.sendCommandToUserHelper(session, cmd, 10)
			if sendErr != nil {
				helperErr = sendErr
				continue
			}
			if resp.Status == "completed" {
				return tools.NewSuccessResult(map[string]any{
					"executionId": executionID,
					"cancelled":   true,
				}, time.Since(start).Milliseconds())
			}
			if resp.Error != "" {
				helperErr = errors.New(resp.Error)
			}
		}

		if helperErr != nil {
			return tools.NewErrorResult(helperErr, time.Since(start).Milliseconds())
		}
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(map[string]any{
		"executionId": executionID,
		"cancelled":   true,
	}, time.Since(start).Milliseconds())
}

func handleScriptListRunning(h *Heartbeat, _ Command) tools.CommandResult {
	start := time.Now()
	running := append([]string(nil), h.executor.ListRunning()...)
	seen := make(map[string]struct{}, len(running))
	for _, id := range running {
		seen[id] = struct{}{}
	}

	var helperErrors int
	for _, session := range h.runAsHelperSessions() {
		resp, err := h.sendCommandToUserHelper(session, Command{
			ID:      fmt.Sprintf("list-running-%d", time.Now().UnixNano()),
			Type:    tools.CmdScriptListRunning,
			Payload: map[string]any{},
		}, 10)
		if err != nil {
			helperErrors++
			log.Warn("failed to list running user-helper scripts", "sessionId", session.SessionID, "error", err.Error())
			continue
		}

		helperRunning, decodeErr := decodeHelperRunningScripts(resp)
		if decodeErr != nil {
			helperErrors++
			log.Warn("failed to decode user-helper running scripts", "sessionId", session.SessionID, "error", decodeErr.Error())
			continue
		}
		for _, id := range helperRunning {
			if _, ok := seen[id]; ok {
				continue
			}
			seen[id] = struct{}{}
			running = append(running, id)
		}
	}

	result := map[string]any{
		"running": running,
		"count":   len(running),
	}
	if helperErrors > 0 {
		result["helperErrors"] = helperErrors
	}
	return tools.NewSuccessResult(result, time.Since(start).Milliseconds())
}

func (h *Heartbeat) runAsHelperSessions() []*sessionbroker.Session {
	if h.sessionBroker == nil {
		return nil
	}
	return h.sessionBroker.SessionsWithScope("run_as_user")
}

// executeViaUserHelper forwards a script command to a user helper via IPC
// and translates the response back to a tools.CommandResult.
func (h *Heartbeat) executeViaUserHelper(session *sessionbroker.Session, cmd Command, timeoutSeconds int) tools.CommandResult {
	start := time.Now()

	if !session.HasScope("run_as_user") {
		return tools.CommandResult{
			Status: "failed",
			// Synthetic exit code: no process ran (see tools.CommandResult.ExitCode).
			ExitCode:   1,
			Error:      "user helper does not have run_as_user scope",
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	result, err := h.sendCommandToUserHelper(session, cmd, timeoutSeconds)
	if err != nil {
		return tools.NewErrorResult(
			fmt.Errorf("user helper command: %w", err),
			time.Since(start).Milliseconds(),
		)
	}

	// Translate IPC result to tools.CommandResult
	cmdResult := tools.CommandResult{
		Status:     result.Status,
		Error:      result.Error,
		DurationMs: time.Since(start).Milliseconds(),
	}

	// Parse the nested result for stdout/stderr/exitCode
	if result.Result != nil {
		var nested map[string]any
		if err := json.Unmarshal(result.Result, &nested); err != nil {
			log.Warn("failed to unmarshal nested result from user helper", "commandId", cmd.ID, "error", err.Error())
		} else {
			if stdout, ok := nested["stdout"].(string); ok {
				cmdResult.Stdout = executor.SanitizeOutput(stdout)
			}
			if stderr, ok := nested["stderr"].(string); ok {
				cmdResult.Stderr = executor.SanitizeOutput(stderr)
			}
			if exitCode, ok := nested["exitCode"].(float64); ok {
				cmdResult.ExitCode = int(exitCode)
			}
		}
	}

	log.Info("script executed via user helper",
		"commandId", cmd.ID,
		"uid", session.UID,
		"username", session.Username,
		"status", result.Status,
	)

	return cmdResult
}

func (h *Heartbeat) sendCommandToUserHelper(session *sessionbroker.Session, cmd Command, timeoutSeconds int) (*ipc.IPCCommandResult, error) {
	payloadBytes, err := json.Marshal(cmd.Payload)
	if err != nil {
		return nil, fmt.Errorf("marshal command payload: %w", err)
	}

	ipcCmd := ipc.IPCCommand{
		CommandID: cmd.ID,
		Type:      cmd.Type,
		Payload:   payloadBytes,
	}

	resp, err := session.SendCommand(cmd.ID, ipc.TypeCommand, ipcCmd, helperCommandTimeout(timeoutSeconds))
	if err != nil {
		return nil, err
	}
	if resp == nil {
		return nil, fmt.Errorf("user helper session closed during command")
	}

	var result ipc.IPCCommandResult
	if err := json.Unmarshal(resp.Payload, &result); err != nil {
		return nil, fmt.Errorf("unmarshal user helper result: %w", err)
	}
	return &result, nil
}

// helperCommandTimeout converts a server-supplied timeoutSeconds into the IPC
// wait deadline, clamped to the same bounds the local script executor applies
// (executor.DefaultTimeout / executor.MaxTimeout). Without the clamp a huge
// timeoutSeconds in the command payload parks a worker-pool goroutine (and the
// command's payload) near-indefinitely on the IPC wait (issue #2387). The +5s
// grace lets the helper's own timeout fire first so its result wins — this
// assumes the helper clamps identically (it routes run_script through
// executor.Execute, which applies the same bounds; its execute_command path
// does not clamp, so a new payload-timeout command routed here would need its
// own cap).
func helperCommandTimeout(timeoutSeconds int) time.Duration {
	if timeoutSeconds <= 0 {
		timeoutSeconds = executor.DefaultTimeout
	}
	if timeoutSeconds > executor.MaxTimeout {
		log.Warn("clamping user-helper command timeout to executor maximum",
			"requestedSeconds", timeoutSeconds, "effectiveSeconds", executor.MaxTimeout)
		timeoutSeconds = executor.MaxTimeout
	}
	return time.Duration(timeoutSeconds)*time.Second + 5*time.Second
}

// executeScriptInSession delivers a user-context script to exactly the given
// Windows session's user-role helper. In on-demand mode the helper is
// lease-spawned and the wait failure is typed; in always-on mode the helper
// must already be connected.
func (h *Heartbeat) executeScriptInSession(cmd Command, script executor.ScriptExecution, winID uint32, start time.Time) tools.CommandResult {
	fail := func(msg string) tools.CommandResult {
		return tools.CommandResult{
			Status: "failed",
			// Synthetic exit code: no process ran (see tools.CommandResult.ExitCode).
			ExitCode:   1,
			Error:      msg,
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	// Session 0 parses fine and a lease on it can even be acquired, but it is
	// never an interactive session (Session 0 isolation) — a helper will
	// never spawn into it, so waiting would burn the full 95s helper budget
	// only to report a misleading "helper did not become ready in time"
	// instead of the real reason. Reject before any lease/wait, mirroring
	// resolveDesktopTargetWinID (handlers_desktop_lease.go, Task 6).
	if winID == 0 {
		return fail("invalid targetSessionId 0: session 0 is never an interactive session")
	}

	// h.helperLifecycle is written once under h.mu at startup (heartbeat.go)
	// and read from concurrent command-handler goroutines thereafter — go
	// through the lock-guarded accessor (handlers_desktop_lease.go), not the
	// raw field, to match every other lifecycle read in this package.
	if lc := h.lifecycleController(); lc != nil && lc.Mode() == "on-demand" {
		ttl := time.Duration(script.Timeout)*time.Second + time.Minute
		if ttl < 5*time.Minute {
			ttl = 5 * time.Minute
		}
		if ttl > 30*time.Minute {
			ttl = 30 * time.Minute
		}
		if err := lc.AcquireLease(winID, ipc.HelperRoleUser, cmd.ID, ttl); err != nil {
			if errors.Is(err, sessionbroker.ErrLeaseSessionNotFound) {
				return fail(fmt.Sprintf("target session %d no longer exists; eligible sessions: %s", winID, eligibleSessionsSummary()))
			}
			return fail(fmt.Sprintf("failed to reserve helper for session %d: %v", winID, err))
		}
		defer lc.ReleaseLease(winID, ipc.HelperRoleUser, cmd.ID)

		waitCtx, cancel := context.WithTimeout(context.Background(), helperReadyBudget)
		res := lc.WaitForHelperReady(waitCtx, sessionbroker.HelperKey{WindowsSessionID: winID, Role: ipc.HelperRoleUser})
		cancel()
		if res.Status != sessionbroker.HelperWaitReady {
			return fail(fmt.Sprintf("cannot run in session %d: %s", winID, helperWaitFailureMessage(res)))
		}
		return h.executeViaUserHelper(res.Session, cmd, script.Timeout)
	}

	// Always-on (workstation multi-user, or RDS forced always-on): the helper
	// for the target session must already be connected.
	//
	// Windows-only: FindUserSession matches on Session.WinSessionID, which on
	// Unix is actually the UID/identity key, not a Windows session number
	// (see FindUserSession's doc comment, broker.go). A numeric
	// targetSessionId from a client that only knows about WTS sessions could
	// collide with a real Unix UID and silently attach to the wrong user's
	// helper — refuse instead of risking that.
	if runtime.GOOS != "windows" {
		return fail(fmt.Sprintf("session targeting is not supported on this platform; no user helper eligible for session %d", winID))
	}
	session := h.sessionBroker.FindUserSession(strconv.FormatUint(uint64(winID), 10))
	if session == nil {
		return fail(fmt.Sprintf("no user helper connected in session %d; eligible sessions: %s", winID, eligibleSessionsSummary()))
	}
	return h.executeViaUserHelper(session, cmd, script.Timeout)
}

// eligibleSessionsSummary enumerates targetable interactive sessions for
// error messages: "id:username(state), ...".
func eligibleSessionsSummary() string {
	detector := sessionbroker.NewSessionDetector()
	detected, err := detector.ListSessions()
	if err != nil {
		return "unknown"
	}
	var parts []string
	for _, ds := range detected {
		if ds.Type == "services" || ds.Username == "" {
			continue
		}
		parts = append(parts, fmt.Sprintf("%s:%s(%s)", ds.Session, ds.Username, ds.State))
	}
	if len(parts) == 0 {
		return "none"
	}
	return strings.Join(parts, ", ")
}

func decodeHelperRunningScripts(result *ipc.IPCCommandResult) ([]string, error) {
	if result == nil {
		return nil, fmt.Errorf("missing helper result")
	}
	if result.Error != "" {
		return nil, errors.New(result.Error)
	}
	if len(result.Result) == 0 {
		return nil, nil
	}

	var payload struct {
		Running []string `json:"running"`
	}
	if err := json.Unmarshal(result.Result, &payload); err != nil {
		return nil, err
	}
	return payload.Running, nil
}
