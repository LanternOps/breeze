package tools

import (
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/terminal"
)

var terminalLog = logging.L("remote-terminal")

// OutputCallback is a function that receives terminal output
type OutputCallback func(sessionId string, data []byte)

const maxTerminalWriteBytes = 256 * 1024

const (
	defaultTerminalCols = 80
	defaultTerminalRows = 24
	minTerminalCols     = 20
	maxTerminalCols     = 500
	minTerminalRows     = 5
	maxTerminalRows     = 200
)

// StartTerminal starts a new terminal session
func StartTerminal(mgr *terminal.Manager, payload map[string]any, outputCallback OutputCallback) CommandResult {
	start := time.Now()

	sessionId := GetPayloadString(payload, "sessionId", "")
	if sessionId == "" {
		return NewErrorResult(fmt.Errorf("sessionId is required"), time.Since(start).Milliseconds())
	}

	cols, rows := normalizeTerminalSize(
		GetPayloadInt(payload, "cols", defaultTerminalCols),
		GetPayloadInt(payload, "rows", defaultTerminalRows),
	)
	shell := GetPayloadString(payload, "shell", "")

	// Create output handler that streams data back
	onOutput := func(data []byte) {
		if outputCallback != nil {
			outputCallback(sessionId, data)
		}
	}

	// Create close handler
	onClose := func(err error) {
		if err != nil {
			terminalLog.Warn("terminal session closed with error",
				"sessionId", sessionId, "error", err.Error())
		}
	}

	if err := mgr.StartSession(sessionId, cols, rows, shell, onOutput, onClose); err != nil {
		return NewErrorResult(err, time.Since(start).Milliseconds())
	}

	return NewSuccessResult(map[string]any{
		"sessionId": sessionId,
		"cols":      cols,
		"rows":      rows,
		"started":   true,
	}, time.Since(start).Milliseconds())
}

// WriteTerminal writes data to an existing terminal session
func WriteTerminal(mgr *terminal.Manager, payload map[string]any) CommandResult {
	start := time.Now()

	sessionId := GetPayloadString(payload, "sessionId", "")
	if sessionId == "" {
		return NewErrorResult(fmt.Errorf("sessionId is required"), time.Since(start).Milliseconds())
	}

	dataStr := GetPayloadString(payload, "data", "")
	if dataStr == "" {
		return NewErrorResult(fmt.Errorf("data is required"), time.Since(start).Milliseconds())
	}

	data := []byte(dataStr)
	if len(data) > maxTerminalWriteBytes {
		return NewErrorResult(fmt.Errorf("terminal input too large: %d bytes (max %d bytes)", len(data), maxTerminalWriteBytes), time.Since(start).Milliseconds())
	}
	if err := mgr.WriteToSession(sessionId, data); err != nil {
		return NewErrorResult(err, time.Since(start).Milliseconds())
	}

	return NewSuccessResult(map[string]any{
		"sessionId": sessionId,
		"written":   len(data),
	}, time.Since(start).Milliseconds())
}

// ResizeTerminal resizes an existing terminal session
func ResizeTerminal(mgr *terminal.Manager, payload map[string]any) CommandResult {
	start := time.Now()

	sessionId := GetPayloadString(payload, "sessionId", "")
	if sessionId == "" {
		return NewErrorResult(fmt.Errorf("sessionId is required"), time.Since(start).Milliseconds())
	}

	cols, rows := normalizeTerminalSize(
		GetPayloadInt(payload, "cols", defaultTerminalCols),
		GetPayloadInt(payload, "rows", defaultTerminalRows),
	)

	if err := mgr.ResizeSession(sessionId, cols, rows); err != nil {
		return NewErrorResult(err, time.Since(start).Milliseconds())
	}

	return NewSuccessResult(map[string]any{
		"sessionId": sessionId,
		"cols":      cols,
		"rows":      rows,
		"resized":   true,
	}, time.Since(start).Milliseconds())
}

// StopTerminal stops and removes a terminal session
func StopTerminal(mgr *terminal.Manager, payload map[string]any) CommandResult {
	start := time.Now()

	sessionId := GetPayloadString(payload, "sessionId", "")
	if sessionId == "" {
		return NewErrorResult(fmt.Errorf("sessionId is required"), time.Since(start).Milliseconds())
	}

	if err := mgr.StopSession(sessionId); err != nil {
		return NewErrorResult(err, time.Since(start).Milliseconds())
	}

	return NewSuccessResult(map[string]any{
		"sessionId": sessionId,
		"stopped":   true,
	}, time.Since(start).Milliseconds())
}

func normalizeTerminalSize(cols, rows int) (uint16, uint16) {
	return clampTerminalDimension(cols, minTerminalCols, maxTerminalCols),
		clampTerminalDimension(rows, minTerminalRows, maxTerminalRows)
}

// clampTerminalDimension clamps a payload-supplied dimension into [lo, hi]
// before narrowing to uint16. The guards test the incoming value directly and
// each branch returns — reassigning and converting after the merge hides the
// bound checks from CodeQL's go/incorrect-integer-conversion analysis, which
// flagged the previous clamp-then-convert shape.
func clampTerminalDimension(v, lo, hi int) uint16 {
	if v < lo {
		return uint16(lo)
	}
	if v > hi {
		return uint16(hi)
	}
	return uint16(v)
}
