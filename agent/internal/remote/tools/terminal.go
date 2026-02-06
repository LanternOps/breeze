package tools

import (
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/terminal"
)

// OutputCallback is a function that receives terminal output
type OutputCallback func(sessionId string, data []byte)

// StartTerminal starts a new terminal session
func StartTerminal(mgr *terminal.Manager, payload map[string]any, outputCallback OutputCallback) CommandResult {
	start := time.Now()

	sessionId := GetPayloadString(payload, "sessionId", "")
	if sessionId == "" {
		return NewErrorResult(fmt.Errorf("sessionId is required"), time.Since(start).Milliseconds())
	}

	cols := uint16(GetPayloadInt(payload, "cols", 80))
	rows := uint16(GetPayloadInt(payload, "rows", 24))
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
			fmt.Printf("Terminal session %s closed with error: %v\n", sessionId, err)
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

	cols := uint16(GetPayloadInt(payload, "cols", 80))
	rows := uint16(GetPayloadInt(payload, "rows", 24))

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
