package heartbeat

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdTakeScreenshot] = handleTakeScreenshot
}

func handleTakeScreenshot(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	// Service mode (Session 0): route through IPC to user helper which has a display
	if (h.isService || h.isHeadless) && h.sessionBroker != nil {
		return h.executeToolViaHelper(tools.CmdTakeScreenshot, cmd.Payload, start)
	}

	// Direct mode: reuse active WebRTC session's capturer if available to avoid
	// conflicting with the shared global capture state (DXGI/ScreenCaptureKit).
	return tools.TakeScreenshotWithCapture(cmd.Payload, h.desktopCaptureFn())
}

// executeToolViaHelper sends a screenshot/computer_action command to the user
// helper process via IPC and returns the result. If the helper crashes, it
// automatically respawns and retries once.
func (h *Heartbeat) executeToolViaHelper(cmdType string, payload map[string]any, start time.Time) tools.CommandResult {
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return tools.NewErrorResult(
			fmt.Errorf("failed to marshal %s payload: %w", cmdType, err),
			time.Since(start).Milliseconds(),
		)
	}

	const maxAttempts = 2
	for attempt := 0; attempt < maxAttempts; attempt++ {
		session := h.findOrSpawnHelper("")
		if session == nil {
			return tools.NewErrorResult(
				fmt.Errorf("no user helper available for %s after spawn attempt", cmdType),
				time.Since(start).Milliseconds(),
			)
		}

		ipcCmd := ipc.IPCCommand{
			CommandID: fmt.Sprintf("%s-%d", cmdType, time.Now().UnixNano()),
			Type:      cmdType,
			Payload:   payloadJSON,
		}

		resp, err := session.SendCommand(ipcCmd.CommandID, ipc.TypeCommand, ipcCmd, 15*time.Second)
		if err != nil {
			if attempt < maxAttempts-1 {
				log.Warn("IPC tool command failed, retrying with new helper",
					"cmdType", cmdType, "attempt", attempt+1, "error", err.Error())
				continue
			}
			return tools.NewErrorResult(
				fmt.Errorf("IPC %s failed after %d attempts: %w", cmdType, maxAttempts, err),
				time.Since(start).Milliseconds(),
			)
		}

		if resp.Error != "" {
			return tools.CommandResult{
				Status:     "failed",
				Error:      resp.Error,
				DurationMs: time.Since(start).Milliseconds(),
			}
		}

		// Parse the IPCCommandResult from the response
		var ipcResult ipc.IPCCommandResult
		if err := json.Unmarshal(resp.Payload, &ipcResult); err != nil {
			return tools.NewErrorResult(
				fmt.Errorf("failed to unmarshal %s IPC response: %w", cmdType, err),
				time.Since(start).Milliseconds(),
			)
		}

		if ipcResult.Status != "completed" {
			return tools.CommandResult{
				Status:     ipcResult.Status,
				Error:      ipcResult.Error,
				DurationMs: time.Since(start).Milliseconds(),
			}
		}

		// The Result field contains the marshaled tools.CommandResult.
		var innerResult tools.CommandResult
		if err := json.Unmarshal(ipcResult.Result, &innerResult); err != nil {
			return tools.NewErrorResult(
				fmt.Errorf("failed to parse inner %s result: %w", cmdType, err),
				time.Since(start).Milliseconds(),
			)
		}

		innerResult.DurationMs = time.Since(start).Milliseconds()
		return innerResult
	}

	// Unreachable — loop always returns
	return tools.NewErrorResult(fmt.Errorf("IPC %s: unexpected exit", cmdType), time.Since(start).Milliseconds())
}
