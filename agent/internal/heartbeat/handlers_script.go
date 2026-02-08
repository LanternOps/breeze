package heartbeat

import (
	"encoding/json"
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
		if session := h.sessionBroker.SessionForUser(script.RunAs); session != nil {
			return h.executeViaUserHelper(session, cmd, script.Timeout)
		}
		log.Debug("no user helper for runAs user, falling back to sudo", "runAs", script.RunAs)
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

func handleScriptCancel(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	executionID, errResult := tools.RequirePayloadString(cmd.Payload, "executionId")
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}
	if err := h.executor.Cancel(executionID); err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(map[string]any{
		"executionId": executionID,
		"cancelled":   true,
	}, time.Since(start).Milliseconds())
}

func handleScriptListRunning(h *Heartbeat, _ Command) tools.CommandResult {
	start := time.Now()
	running := h.executor.ListRunning()
	return tools.NewSuccessResult(map[string]any{
		"running": running,
		"count":   len(running),
	}, time.Since(start).Milliseconds())
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

	payloadBytes, err := json.Marshal(cmd.Payload)
	if err != nil {
		return tools.NewErrorResult(
			fmt.Errorf("marshal command payload: %w", err),
			time.Since(start).Milliseconds(),
		)
	}

	ipcCmd := ipc.IPCCommand{
		CommandID: cmd.ID,
		Type:      cmd.Type,
		Payload:   payloadBytes,
	}

	timeout := time.Duration(timeoutSeconds)*time.Second + 5*time.Second
	resp, err := session.SendCommand(cmd.ID, ipc.TypeCommand, ipcCmd, timeout)
	if err != nil {
		return tools.NewErrorResult(
			fmt.Errorf("user helper command: %w", err),
			time.Since(start).Milliseconds(),
		)
	}

	var result ipc.IPCCommandResult
	if err := json.Unmarshal(resp.Payload, &result); err != nil {
		return tools.NewErrorResult(
			fmt.Errorf("unmarshal user helper result: %w", err),
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
		if err := json.Unmarshal(result.Result, &nested); err == nil {
			if stdout, ok := nested["stdout"].(string); ok {
				cmdResult.Stdout = stdout
			}
			if stderr, ok := nested["stderr"].(string); ok {
				cmdResult.Stderr = stderr
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
