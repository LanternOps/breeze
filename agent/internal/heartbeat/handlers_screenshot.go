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
	if h.isService && h.sessionBroker != nil {
		return h.executeToolViaHelper(tools.CmdTakeScreenshot, cmd.Payload, start)
	}

	return tools.TakeScreenshot(cmd.Payload)
}

// executeToolViaHelper sends a screenshot/computer_action command to the user
// helper process via IPC and returns the result. The helper runs in the user
// session and has access to the display and input APIs.
func (h *Heartbeat) executeToolViaHelper(cmdType string, payload map[string]any, start time.Time) tools.CommandResult {
	session := h.sessionBroker.FindCapableSession("capture", "")
	if session == nil {
		// Try spawning a helper
		spawnGuard.Lock()
		session = h.sessionBroker.FindCapableSession("capture", "")
		if session == nil {
			if err := h.spawnHelperForDesktop(""); err != nil {
				spawnGuard.Unlock()
				return tools.NewErrorResult(
					fmt.Errorf("no user helper available for %s (spawn failed: %w)", cmdType, err),
					time.Since(start).Milliseconds(),
				)
			}
			for i := 0; i < 10; i++ {
				time.Sleep(500 * time.Millisecond)
				session = h.sessionBroker.FindCapableSession("capture", "")
				if session != nil {
					break
				}
			}
		}
		spawnGuard.Unlock()
		if session == nil {
			return tools.NewErrorResult(
				fmt.Errorf("helper spawned but did not connect within 5s for %s", cmdType),
				time.Since(start).Milliseconds(),
			)
		}
	}

	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return tools.NewErrorResult(
			fmt.Errorf("failed to marshal %s payload: %w", cmdType, err),
			time.Since(start).Milliseconds(),
		)
	}

	ipcCmd := ipc.IPCCommand{
		CommandID: fmt.Sprintf("%s-%d", cmdType, time.Now().UnixNano()),
		Type:      cmdType,
		Payload:   payloadJSON,
	}

	resp, err := session.SendCommand(ipcCmd.CommandID, ipc.TypeCommand, ipcCmd, 30*time.Second)
	if err != nil {
		return tools.NewErrorResult(
			fmt.Errorf("IPC %s failed: %w", cmdType, err),
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
	// Extract the stdout from the inner result so the API gets the same format.
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
