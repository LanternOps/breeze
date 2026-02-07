package heartbeat

import (
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/executor"
	"github.com/breeze-rmm/agent/internal/remote/tools"
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
