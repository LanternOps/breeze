package heartbeat

import (
	"encoding/json"
	"errors"
	"fmt"
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
			Status:     "failed",
			Error:      "script content is empty",
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	// Phase 3: If runAs is specified and a user helper is connected, forward via IPC
	if script.RunAs != "" && h.sessionBroker != nil {
		if session := resolveRunAsSession(h.sessionBroker, script.RunAs); session != nil {
			return h.executeViaUserHelper(session, cmd, script.Timeout)
		}
		if !strings.EqualFold(script.RunAs, "system") && !strings.EqualFold(script.RunAs, "elevated") {
			log.Debug("no user helper for runAs value, falling back to local executor", "runAs", script.RunAs)
		}
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
	// (runs as the logged-in user) over a SYSTEM helper.
	if strings.EqualFold(target, "user") {
		return broker.PreferredSessionWithScope("run_as_user")
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
			Status:     "failed",
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

	timeout := time.Duration(timeoutSeconds)*time.Second + 5*time.Second
	resp, err := session.SendCommand(cmd.ID, ipc.TypeCommand, ipcCmd, timeout)
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
