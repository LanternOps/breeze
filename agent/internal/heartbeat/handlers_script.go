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
	"github.com/breeze-rmm/agent/internal/privilege"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

func init() {
	handlerRegistry[tools.CmdScript] = handleScript
	handlerRegistry[tools.CmdRunScript] = handleScript
	handlerRegistry[tools.CmdScriptCancel] = handleScriptCancel
	handlerRegistry[tools.CmdScriptListRunning] = handleScriptListRunning
}

// handleScript is a thin wrapper that owns two invariants for EVERY exit path
// of script execution — including early failures, the user-helper path, and
// panicking-free error returns:
//
//  1. a malformed `secretEnv` fails the command before any script runs, and
//  2. the delivered secret values are stripped from stdout, stderr AND error.
//
// `Error` in particular was copied raw out of the executor and out of the
// helper IPC result, so a credential echoed into an error message reached the
// server unredacted. BOTH error passes live here — the pattern-based
// SanitizeOutput as well as the exact-value redactor — rather than at the eight
// executor sites that assign result.Error, so a new failure path cannot
// silently opt out. Mirrors the server's own chokepoint invariant
// (redactAgentResultErrorFields as the first statement of processCommandResult,
// apps/api/src/routes/agentWs.ts).
func handleScript(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	secretEnv, err := executor.ParseSecretEnv(cmd.Payload[executor.SecretEnvPayloadKey])
	if err != nil {
		// Fail closed: never run a script whose secret map we could not
		// validate. ParseSecretEnv error text names keys, never values — but
		// the key is server-supplied text, so it gets the same sanitizer as
		// every other Error below.
		return tools.CommandResult{
			Status: "failed",
			// Synthetic exit code: no process ran (see tools.CommandResult.ExitCode).
			ExitCode:   1,
			Error:      executor.SanitizeOutput(fmt.Sprintf("refusing to execute script: %v", err)),
			DurationMs: time.Since(start).Milliseconds(),
		}
	}
	res := handleScriptInner(h, cmd, secretEnv)
	// Unconditional, and centralized here rather than at the result-build
	// sites: the two tools.NewErrorResult returns (the executor error below and
	// the helper IPC send failure in executeViaUserHelper — the latter is a
	// live path) never had a sanitizer at all, which is precisely the "a new
	// failure path silently opts out" failure this wrapper exists to prevent.
	// Stdout/Stderr stay sanitized at their build sites; only Error moved.
	res.Error = executor.SanitizeOutput(res.Error)
	if len(secretEnv) == 0 {
		return res
	}
	redact := executor.BuildSecretRedactor(secretEnv.Values())
	res.Stdout = redact(res.Stdout)
	res.Stderr = redact(res.Stderr)
	res.Error = redact(res.Error)
	// #2698: delivered secretEnv values ride the script's real process
	// environment, so a script can echo one into a customFieldWrites marker
	// value — and that value is extracted from stdout BEFORE SanitizeOutput
	// even runs (that ordering is the entire point of Wave 3), so it is not
	// caught by the pattern-based sanitizer either. Unlike Stdout/Stderr/
	// Error, res.Result is never persisted as free-text log output — it is
	// written into a device's custom fields, a location any org user with
	// device-read access can see. Redact it with the same exact-value
	// redactor so a delivered secret cannot be exfiltrated through a custom
	// field. (secretEnv never reaches the user-helper path at all — see the
	// #3409 refusal above — so this exclusively covers the local-executor
	// build site, which is exactly where the risk is.)
	redactCustomFieldValues(res.Result, redact)
	return res
}

// redactCustomFieldValues strips delivered-secret values out of a
// customFieldWrites envelope's string field values, in place. Non-string
// values (numbers, booleans) cannot contain an exact-value secret match, and
// the server rejects non-scalar custom field values outright
// (validateValue.ts), so only string values need scrubbing.
func redactCustomFieldValues(result any, redact func(string) string) {
	envelope, ok := result.(map[string]any)
	if !ok {
		return
	}
	writes, ok := envelope["customFieldWrites"].(map[string]any)
	if !ok {
		return
	}
	fields, ok := writes["fields"].(map[string]any)
	if !ok {
		return
	}
	for k, v := range fields {
		if s, ok := v.(string); ok {
			fields[k] = redact(s)
		}
	}
}

// handleScriptInner is the original handler body. Every return it makes flows
// back through handleScript's redaction — do not call it (or the helper paths
// it owns: executeViaUserHelper, executeScriptInSession) from anywhere else.
func handleScriptInner(h *Heartbeat, cmd Command, secretEnv executor.SecretEnv) tools.CommandResult {
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
	// Shared with userhelper.Client.executeScript, which rebuilds this same
	// struct on the far side of the runAs=user IPC hop — see #4882, where only
	// this site decoded parameters and every user-context script ran without
	// them.
	script.Parameters = executor.ParametersFromPayload(cmd.Payload["parameters"])
	// Validated by handleScript's ParseSecretEnv. Deliberately set AFTER the
	// parameters block: secrets ride the process environment (buildEnvironment)
	// and must never reach SubstituteParameters or validateScript, which would
	// write them into the temp script file on the customer's disk.
	script.SecretEnv = secretEnv
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

	// #3409 PR4b: secrets are delivered as process environment to the LOCAL
	// executor only. The user-helper path forwards the raw payload over IPC and
	// the helper never reads parameters or env (userhelper/client.go
	// executeScript), so a user-context run would execute with the credential
	// UNSET — anonymous access, an auth fallback, a lockout, or a destructive
	// operation against the wrong target. Refuse instead. Lifting this needs a
	// separately-versioned user-helper binary rollout (HelperVersion), which is
	// deliberately out of scope for v1.
	//
	// Placed immediately after targetSessionID is derived so it precedes BOTH
	// helper branches — the session-targeted one below and the
	// resolveRunAsSession one after it.
	if len(script.SecretEnv) > 0 && !runAsSupportsSecrets(script.RunAs, targetSessionID) {
		return tools.CommandResult{
			Status: "failed",
			// Synthetic exit code: no process ran (see tools.CommandResult.ExitCode).
			ExitCode: 1,
			Error: "script uses secret variables, which require system-context execution; " +
				"this script is configured to run as a user and was not executed",
			DurationMs: time.Since(start).Milliseconds(),
		}
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

	// #2698: pull markers out of RAW stdout, BEFORE SanitizeOutput. The
	// sanitizer rewrites `token=`/`secret=`-shaped substrings, which corrupts a
	// marker's JSON past recovery — the server's stdout-scanning fallback
	// (Wave 1) can only see post-sanitizer text, which is exactly the gap this
	// closes. The marker lines are stripped so the operator's saved output is
	// the script's real output.
	customFields, cleanedStdout := executor.ExtractCustomFields(scriptResult.Stdout)
	if strings.Contains(cleanedStdout, executor.CustomFieldMarker) {
		// A marker-prefixed line survived extraction: it was rejected by one of
		// ExtractCustomFields' caps (line count / key count / payload size) or
		// failed to parse as JSON. The line itself stays visible in the
		// persisted stdout by design, but nothing else surfaces the rejection —
		// log so it's diagnosable without reverse-engineering the caps.
		log.Warn("script printed a custom-field marker that was not applied (parse failure or cap exceeded)",
			"commandId", cmd.ID)
	}

	result := tools.CommandResult{
		Status:   status,
		ExitCode: scriptResult.ExitCode,
		Stdout:   executor.SanitizeOutput(cleanedStdout),
		Stderr:   executor.SanitizeOutput(scriptResult.Stderr),
		// Error is deliberately raw here: handleScript sanitizes it for every
		// exit path, including the NewErrorResult return above that never
		// reached this build site. The timeout classification a few lines up
		// also needs the unmodified text.
		Error:      scriptResult.Error,
		DurationMs: time.Since(start).Milliseconds(),
	}
	if len(customFields) > 0 {
		result.Result = map[string]any{
			"customFieldWrites": map[string]any{
				"schemaVersion": 1,
				"fields":        customFields,
			},
		}
	}
	return result
}

// isRunningElevated is an indirection over privilege.IsRunningAsRoot so the
// elevated-path gate below can be tested deterministically on both root and
// non-root hosts; CI runners differ.
var isRunningElevated = privilege.IsRunningAsRoot

// runAsSupportsSecrets reports whether an execution with this runAs setting
// will reach the LOCAL executor *with its environment intact* — the only way
// BREEZE_VAR_* actually arrives.
//
// "" and system always do. An explicit username is refused even though it
// currently falls through to local execution on an unresolved lookup — that
// fall-through is a best-effort downgrade, and downgrading a secret-bearing run
// is exactly what must not happen silently.
//
// `elevated` is admitted ONLY when the agent is already elevated, mirroring
// executor.configureRunAs's own short-circuit. On a non-root Unix agent
// configureRunAs re-execs the command through `sudo -n` with no -E /
// --preserve-env, and sudo's default env_reset discards the BREEZE_VAR_*
// entries built into cmd.Env — the script would run with the credential UNSET,
// the same silent-wrong-run the helper IPC path is blocked for, reached by a
// different mechanism. (-E is not the fix: it would change behavior for every
// existing script and sudoers can refuse it outright.)
func runAsSupportsSecrets(runAs string, targetSessionID int) bool {
	if targetSessionID >= 0 {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(runAs)) {
	case "", "system":
		return true
	case "elevated":
		return isRunningElevated()
	default:
		return false
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

const (
	// scriptCancelHelperTimeoutSeconds is the per-helper IPC budget for a
	// script_cancel. helperCommandTimeout adds 5s, and the result MUST exceed
	// the 30s maximum grace (executor.MaxGraceSeconds, spec OD2-B): the old
	// value of 10 gave a 15s wait, so a 30s cancel timed the IPC out while the
	// helper was still escalating and the agent reported a failure for a kill
	// that was about to succeed.
	scriptCancelHelperTimeoutSeconds = 40

	// defaultCancelGraceSeconds matches the server's default when a request
	// omits graceSeconds. executor.Cancel clamps to 0..MaxGraceSeconds.
	defaultCancelGraceSeconds = 5
)

// handleScriptCancel stops a running script and reports what actually happened.
//
// All three outcomes (terminated / not_found / kill_failed) come back as a
// SUCCESS result carrying {executionId, outcome, cancelled}: the server closes
// the execution's cancel_state differently for each, and an error string cannot
// carry that distinction — the previous implementation returned
// tools.NewErrorResult for "no such execution" AND for a genuinely failed kill.
// Only a genuinely malformed payload is still an error result.
//
// `cancelled` is true only for `terminated`. It feeds the server's honesty
// contract: script_executions.status may become 'cancelled' only on proof.
func handleScriptCancel(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	executionID, errResult := tools.RequirePayloadString(cmd.Payload, "executionId")
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}
	grace := cancelGraceSeconds(cmd.Payload)

	// Name the responsible command BEFORE asking, so the script's own result
	// can carry cancelledByCommandId even if it wins the race with our ack.
	h.executor.SetCancelCommandID(executionID, cmd.ID)
	outcome, err := h.executor.Cancel(executionID, grace)
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	// A runAs=user script runs inside a user helper's OWN executor, so our
	// not_found says nothing about it. Every other outcome is already decided
	// locally — fanning out then would risk a second kill of an unrelated id.
	if outcome == executor.CancelNotFound {
		outcome = h.cancelViaUserHelpers(cmd, executionID, outcome)
	}

	log.Info("script cancel resolved",
		"commandId", cmd.ID, "executionId", executionID,
		"outcome", string(outcome), "graceSeconds", grace)

	return tools.NewSuccessResult(map[string]any{
		"executionId": executionID,
		"outcome":     string(outcome),
		"cancelled":   outcome == executor.CancelTerminated,
	}, time.Since(start).Milliseconds())
}

// cancelGraceSeconds reads the requested graceful-shutdown window from the
// command payload. JSON decoding gives float64; the string arm tolerates a
// stringified value. executor.Cancel clamps whatever comes back.
func cancelGraceSeconds(payload map[string]any) int {
	raw, ok := payload["graceSeconds"]
	if !ok {
		return defaultCancelGraceSeconds
	}
	switch v := raw.(type) {
	case float64:
		return int(v)
	case int:
		return v
	case string:
		if parsed, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			return parsed
		}
	}
	return defaultCancelGraceSeconds
}

// cancelViaUserHelpers fans a cancel out to every run_as_user helper and folds
// their answers into one outcome.
//
// not_found is returned ONLY when every helper also reports not_found — an
// unreachable or erroring helper may still own the process, and the server
// treats not_found as "revert, nothing proven" rather than "kill failed".
// Ranking is terminated > kill_failed > not_found: an execution lives in at
// most one helper, so a single `terminated` is proof.
func (h *Heartbeat) cancelViaUserHelpers(cmd Command, executionID string, local executor.CancelOutcome) executor.CancelOutcome {
	sessions := h.runAsHelperSessions()
	if len(sessions) == 0 {
		return local
	}

	outcome := local
	for _, session := range sessions {
		resp, sendErr := h.sendCommandToUserHelper(session, cmd, scriptCancelHelperTimeoutSeconds)
		if sendErr != nil {
			log.Warn("user-helper script cancel failed",
				"sessionId", session.SessionID, "executionId", executionID, "error", sendErr.Error())
			outcome = strongerCancelOutcome(outcome, executor.CancelKillFailed)
			continue
		}
		outcome = strongerCancelOutcome(outcome, decodeHelperCancelOutcome(session.SessionID, resp))
	}
	return outcome
}

// decodeHelperCancelOutcome reads a helper's structured outcome. Anything it
// cannot positively read as one of the three known outcomes grades as
// kill_failed: a helper that answered something we do not understand may well
// still be running the script, and claiming not_found there would let the
// server revert the execution as if nothing had been running.
func decodeHelperCancelOutcome(sessionID string, resp *ipc.IPCCommandResult) executor.CancelOutcome {
	if resp == nil || resp.Status != "completed" {
		return executor.CancelKillFailed
	}
	var nested struct {
		Outcome string `json:"outcome"`
	}
	if len(resp.Result) == 0 || json.Unmarshal(resp.Result, &nested) != nil {
		log.Warn("user helper returned an undecodable script cancel result", "sessionId", sessionID)
		return executor.CancelKillFailed
	}
	switch executor.CancelOutcome(nested.Outcome) {
	case executor.CancelTerminated:
		return executor.CancelTerminated
	case executor.CancelNotFound:
		return executor.CancelNotFound
	case executor.CancelKillFailed:
		return executor.CancelKillFailed
	}
	// A pre-#3525 helper reports {cancelled:true} with no outcome. It acked the
	// instant it asked, which proves nothing, so it does not earn `terminated`.
	log.Warn("user helper returned no script cancel outcome; grading as kill_failed",
		"sessionId", sessionID, "outcome", nested.Outcome)
	return executor.CancelKillFailed
}

func strongerCancelOutcome(current, next executor.CancelOutcome) executor.CancelOutcome {
	if cancelOutcomeRank(next) > cancelOutcomeRank(current) {
		return next
	}
	return current
}

func cancelOutcomeRank(outcome executor.CancelOutcome) int {
	switch outcome {
	case executor.CancelTerminated:
		return 2
	case executor.CancelKillFailed:
		return 1
	default:
		return 0
	}
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

	// Translate IPC result to tools.CommandResult. Error is copied raw and
	// sanitized once, centrally, in handleScript — the send-failure return
	// above never passes through here, so sanitizing at this site would have
	// left that path uncovered.
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
				// #2698: the marker was ALREADY extracted from raw stdout, and
				// stripped, inside the user-helper process itself (userhelper/
				// client.go executeScript) — before that process's own
				// SanitizeOutput call. Re-extracting here would run on stdout
				// that has already been through SanitizeOutput once (over the
				// IPC round trip), which would corrupt any marker whose JSON
				// contains a token/secret/password-shaped key exactly like the
				// local-executor path is designed to avoid. So this site only
				// re-sanitizes (idempotent — the helper already sanitized this
				// text) and does not call ExtractCustomFields again.
				cmdResult.Stdout = executor.SanitizeOutput(stdout)
			}
			if stderr, ok := nested["stderr"].(string); ok {
				cmdResult.Stderr = executor.SanitizeOutput(stderr)
			}
			if exitCode, ok := nested["exitCode"].(float64); ok {
				cmdResult.ExitCode = int(exitCode)
			}
			if writes, ok := nested["customFieldWrites"]; ok && writes != nil {
				cmdResult.Result = map[string]any{"customFieldWrites": writes}
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
