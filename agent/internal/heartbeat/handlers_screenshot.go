package heartbeat

import (
	"encoding/json"
	"fmt"
	"runtime"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdTakeScreenshot] = handleTakeScreenshot
}

func handleTakeScreenshot(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	// Service mode (Session 0): route through IPC to user helper which has a display.
	// Linux is excluded: no IPC helper on Linux in Phase 1, so take the direct
	// path (TakeScreenshotWithCapture, whose capturer resolves the X display).
	if (h.isService || h.isHeadless) && h.sessionBroker != nil && runtime.GOOS != "linux" {
		return h.executeToolViaHelper(tools.CmdTakeScreenshot, cmd.Payload, start)
	}

	// Direct mode: reuse active WebRTC session's capturer if available to avoid
	// conflicting with the shared global capture state (DXGI/ScreenCaptureKit).
	return tools.TakeScreenshotWithCapture(cmd.Payload, h.desktopCaptureFn())
}

// minHelperAttemptTimeout is the floor for a single IPC attempt. It keeps a
// nearly-exhausted budget from producing an instant, meaningless failure — the
// helper still gets a real chance to answer — while staying well under any
// server-side budget worth threading through.
const minHelperAttemptTimeout = 5 * time.Second

// defaultHelperToolTimeoutSeconds is used when the server sends no
// timeoutSeconds — an older API, or a caller that never set one. It preserves
// the previous ~30s total ceiling (15s x 2 attempts) rather than inheriting the
// script executor's 300s default, which would turn a silent omission into a
// five-minute parked goroutine for what is usually a screenshot.
const defaultHelperToolTimeoutSeconds = 25

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

	// #3112: the IPC wait used to be a hardcoded 15s per attempt, so the whole
	// helper round-trip was capped near 30s no matter what budget the caller was
	// willing to wait for — the API could raise its own timeout to 120s and the
	// tool would still die down here. Derive the deadline from the server-supplied
	// timeoutSeconds instead, exactly as the script path does, reusing
	// helperCommandTimeout so the executor's clamping (#2387) applies and a huge
	// payload value cannot park a worker goroutine.
	//
	// The budget is for the whole operation, not per attempt: the deadline is
	// computed once and each attempt gets what is left, so a retry cannot double
	// the caller's wait. An attempt is only started if there is still meaningful
	// time for it.
	overallTimeout := helperCommandTimeout(tools.GetPayloadInt(payload, "timeoutSeconds", defaultHelperToolTimeoutSeconds))
	deadline := start.Add(overallTimeout)

	const maxAttempts = 2
	for attempt := 0; attempt < maxAttempts; attempt++ {
		remaining := time.Until(deadline)
		if remaining < minHelperAttemptTimeout {
			if attempt == 0 {
				// Budget was already spent before the first attempt; give it the
				// floor rather than failing without ever trying the helper.
				remaining = minHelperAttemptTimeout
			} else {
				log.Warn("IPC tool command budget exhausted, not retrying",
					"cmdType", cmdType, "attempt", attempt+1)
				break
			}
		}
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

		resp, err := session.SendCommand(ipcCmd.CommandID, ipc.TypeCommand, ipcCmd, remaining)
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

	// Reachable when the retry was skipped because the caller's budget ran out
	// (see the deadline check at the top of the loop).
	return tools.NewErrorResult(
		fmt.Errorf("IPC %s: budget of %s exhausted after %d attempt(s)", cmdType, overallTimeout, maxAttempts),
		time.Since(start).Milliseconds(),
	)
}
