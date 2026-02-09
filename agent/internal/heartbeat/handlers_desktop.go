package heartbeat

import (
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdFileTransfer] = handleFileTransfer
	handlerRegistry[tools.CmdCancelTransfer] = handleCancelTransfer
	handlerRegistry[tools.CmdStartDesktop] = handleStartDesktop
	handlerRegistry[tools.CmdStopDesktop] = handleStopDesktop
	handlerRegistry[tools.CmdDesktopStreamStart] = handleDesktopStreamStart
	handlerRegistry[tools.CmdDesktopStreamStop] = handleDesktopStreamStop
	handlerRegistry[tools.CmdDesktopInput] = handleDesktopInput
	handlerRegistry[tools.CmdDesktopConfig] = handleDesktopConfig
}

func handleFileTransfer(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	transferResult := h.fileTransferMgr.HandleTransfer(cmd.Payload)
	durationMs := time.Since(start).Milliseconds()

	status, _ := transferResult["status"].(string)
	if status != "completed" {
		errMsg, _ := transferResult["error"].(string)
		if errMsg == "" {
			errMsg = fmt.Sprintf("file transfer failed with status: %s", status)
		}
		return tools.CommandResult{
			Status:     "failed",
			Error:      errMsg,
			DurationMs: durationMs,
		}
	}
	return tools.NewSuccessResult(transferResult, durationMs)
}

func handleCancelTransfer(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	transferID, errResult := tools.RequirePayloadString(cmd.Payload, "transferId")
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}
	h.fileTransferMgr.CancelTransfer(transferID)
	return tools.NewSuccessResult(map[string]any{"cancelled": true}, time.Since(start).Milliseconds())
}

func handleStartDesktop(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	sessionID, _ := cmd.Payload["sessionId"].(string)
	offer, _ := cmd.Payload["offer"].(string)
	if sessionID == "" || offer == "" {
		return tools.CommandResult{
			Status:     "failed",
			Error:      "missing sessionId or offer",
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	// Parse optional ICE servers from payload
	var iceServers []desktop.ICEServerConfig
	if raw, ok := cmd.Payload["iceServers"].([]interface{}); ok {
		for _, item := range raw {
			if m, ok := item.(map[string]interface{}); ok {
				s := desktop.ICEServerConfig{
					URLs:       m["urls"],
					Username:   fmt.Sprintf("%v", m["username"]),
					Credential: fmt.Sprintf("%v", m["credential"]),
				}
				iceServers = append(iceServers, s)
			}
		}
	}

	answer, err := h.desktopMgr.StartSession(sessionID, offer, iceServers)
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(map[string]any{
		"sessionId": sessionID,
		"answer":    answer,
	}, time.Since(start).Milliseconds())
}

func handleStopDesktop(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	sessionID, errResult := tools.RequirePayloadString(cmd.Payload, "sessionId")
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}
	h.desktopMgr.StopSession(sessionID)
	return tools.NewSuccessResult(map[string]any{"stopped": true}, time.Since(start).Milliseconds())
}

func handleDesktopStreamStart(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	sessionID, errResult := tools.RequirePayloadString(cmd.Payload, "sessionId")
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}

	config := desktop.DefaultStreamConfig()
	if q, ok := cmd.Payload["quality"].(float64); ok && q >= 1 && q <= 100 {
		config.Quality = int(q)
	}
	if s, ok := cmd.Payload["scaleFactor"].(float64); ok && s > 0 && s <= 1.0 {
		config.ScaleFactor = s
	}
	if f, ok := cmd.Payload["maxFps"].(float64); ok && f >= 1 && f <= 30 {
		config.MaxFPS = int(f)
	}

	w, h2, err := h.wsDesktopMgr.StartSession(sessionID, config, func(sid string, data []byte) error {
		if h.wsClient != nil {
			return h.wsClient.SendDesktopFrame(sid, data)
		}
		return fmt.Errorf("ws client not available")
	})
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(map[string]any{
		"sessionId":    sessionID,
		"screenWidth":  w,
		"screenHeight": h2,
	}, time.Since(start).Milliseconds())
}

func handleDesktopStreamStop(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	sessionID, errResult := tools.RequirePayloadString(cmd.Payload, "sessionId")
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}
	h.wsDesktopMgr.StopSession(sessionID)
	return tools.NewSuccessResult(map[string]any{"stopped": true}, time.Since(start).Milliseconds())
}

func handleDesktopInput(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	sessionID, errResult := tools.RequirePayloadString(cmd.Payload, "sessionId")
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}

	e, ok := cmd.Payload["event"].(map[string]any)
	if !ok {
		return tools.CommandResult{
			Status:     "failed",
			Error:      "missing or invalid event payload",
			DurationMs: time.Since(start).Milliseconds(),
		}
	}
	event := desktop.InputEvent{}
	event.Type, _ = e["type"].(string)
	if event.Type == "" {
		return tools.CommandResult{
			Status:     "failed",
			Error:      "event type is required",
			DurationMs: time.Since(start).Milliseconds(),
		}
	}
	if x, ok := e["x"].(float64); ok {
		event.X = int(x)
	}
	if y, ok := e["y"].(float64); ok {
		event.Y = int(y)
	}
	event.Button, _ = e["button"].(string)
	event.Key, _ = e["key"].(string)
	if d, ok := e["delta"].(float64); ok {
		event.Delta = int(d)
	}
	if mods, ok := e["modifiers"].([]any); ok {
		for _, m := range mods {
			if ms, ok := m.(string); ok {
				event.Modifiers = append(event.Modifiers, ms)
			}
		}
	}
	if err := h.wsDesktopMgr.HandleInput(sessionID, event); err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(map[string]any{"ok": true}, time.Since(start).Milliseconds())
}

func handleDesktopConfig(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	sessionID, errResult := tools.RequirePayloadString(cmd.Payload, "sessionId")
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}

	config := desktop.StreamConfig{}
	hasField := false
	if q, ok := cmd.Payload["quality"].(float64); ok && q >= 1 && q <= 100 {
		config.Quality = int(q)
		hasField = true
	}
	if s, ok := cmd.Payload["scaleFactor"].(float64); ok && s > 0 && s <= 1.0 {
		config.ScaleFactor = s
		hasField = true
	}
	if f, ok := cmd.Payload["maxFps"].(float64); ok && f >= 1 && f <= 30 {
		config.MaxFPS = int(f)
		hasField = true
	}
	if !hasField {
		return tools.CommandResult{
			Status:     "failed",
			Error:      "no valid config fields provided (quality: 1-100, scaleFactor: 0-1, maxFps: 1-30)",
			DurationMs: time.Since(start).Milliseconds(),
		}
	}
	if err := h.wsDesktopMgr.UpdateConfig(sessionID, config); err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(map[string]any{"ok": true}, time.Since(start).Milliseconds())
}
