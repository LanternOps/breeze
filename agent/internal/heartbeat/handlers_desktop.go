package heartbeat

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
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
	handlerRegistry[tools.CmdListSessions] = handleListSessions
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
				username, _ := m["username"].(string)
				credential, _ := m["credential"].(string)
				s := desktop.ICEServerConfig{
					URLs:       m["urls"],
					Username:   username,
					Credential: credential,
				}
				iceServers = append(iceServers, s)
			}
		}
	}

	// Parse optional display index (multi-monitor selection)
	displayIndex := 0
	if di, ok := cmd.Payload["displayIndex"].(float64); ok && di >= 0 {
		displayIndex = int(di)
	}

	// Route through IPC helper when running as a Windows service
	if h.isService && h.sessionBroker != nil {
		result := h.startDesktopViaHelper(sessionID, offer, iceServers, displayIndex, cmd.Payload)
		result.DurationMs = time.Since(start).Milliseconds()
		return result
	}

	// Direct mode (console or non-Windows)
	answer, err := h.desktopMgr.StartSession(sessionID, offer, iceServers, displayIndex)
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(map[string]any{
		"sessionId": sessionID,
		"answer":    answer,
	}, time.Since(start).Milliseconds())
}

// startDesktopViaHelper routes a desktop start request through the IPC user helper.
func (h *Heartbeat) startDesktopViaHelper(sessionID, offer string, iceServers []desktop.ICEServerConfig, displayIndex int, payload map[string]any) tools.CommandResult {
	// Read optional target Windows session ID from payload
	targetSession := ""
	if ts, ok := payload["targetSessionId"].(float64); ok {
		targetSession = fmt.Sprintf("%d", int(ts))
	}

	session := h.sessionBroker.FindCapableSession("capture", targetSession)
	if session == nil {
		// No helper connected yet — try to spawn one
		if err := h.spawnHelperForDesktop(targetSession); err != nil {
			return tools.NewErrorResult(fmt.Errorf("no capable helper session and spawn failed: %w", err), 0)
		}
		// Poll for the helper to connect (up to 5s, every 500ms)
		for i := 0; i < 10; i++ {
			time.Sleep(500 * time.Millisecond)
			session = h.sessionBroker.FindCapableSession("capture", targetSession)
			if session != nil {
				break
			}
		}
		if session == nil {
			return tools.NewErrorResult(fmt.Errorf("helper spawned but did not connect within 5s"), 0)
		}
	}

	// Marshal ICE servers to json.RawMessage
	var iceRaw json.RawMessage
	if len(iceServers) > 0 {
		data, err := json.Marshal(iceServers)
		if err != nil {
			return tools.NewErrorResult(fmt.Errorf("failed to marshal ICE servers: %w", err), 0)
		}
		iceRaw = data
	}

	req := ipc.DesktopStartRequest{
		SessionID:    sessionID,
		Offer:        offer,
		ICEServers:   iceRaw,
		DisplayIndex: displayIndex,
	}

	resp, err := session.SendCommand("desk-"+sessionID, ipc.TypeDesktopStart, req, 30*time.Second)
	if err != nil {
		return tools.NewErrorResult(fmt.Errorf("IPC desktop start failed: %w", err), 0)
	}
	if resp.Error != "" {
		return tools.CommandResult{
			Status: "failed",
			Error:  resp.Error,
		}
	}

	var dResp ipc.DesktopStartResponse
	if err := json.Unmarshal(resp.Payload, &dResp); err != nil {
		return tools.NewErrorResult(fmt.Errorf("failed to unmarshal desktop start response: %w", err), 0)
	}

	return tools.NewSuccessResult(map[string]any{
		"sessionId": sessionID,
		"answer":    dResp.Answer,
	}, 0)
}

// spawnHelperForDesktop spawns a user helper in the target session.
// If targetSession is empty, it auto-detects the first active non-services session.
func (h *Heartbeat) spawnHelperForDesktop(targetSession string) error {
	if targetSession == "" {
		detector := sessionbroker.NewSessionDetector()
		detected, err := detector.ListSessions()
		if err != nil {
			return fmt.Errorf("failed to list sessions: %w", err)
		}
		for _, ds := range detected {
			if ds.Type != "services" && (ds.State == "active" || ds.State == "online") {
				targetSession = ds.Session
				break
			}
		}
		if targetSession == "" {
			return fmt.Errorf("no active non-services session found")
		}
	}

	var sessionNum uint32
	if _, err := fmt.Sscanf(targetSession, "%d", &sessionNum); err != nil {
		return fmt.Errorf("invalid session ID %q: %w", targetSession, err)
	}

	return sessionbroker.SpawnHelperInSession(sessionNum)
}

func handleStopDesktop(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	sessionID, errResult := tools.RequirePayloadString(cmd.Payload, "sessionId")
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}

	// Route through IPC helper when running as a Windows service
	if h.isService && h.sessionBroker != nil {
		session := h.sessionBroker.FindCapableSession("capture", "")
		if session != nil {
			req := ipc.DesktopStopRequest{SessionID: sessionID}
			_, err := session.SendCommand("desk-stop-"+sessionID, ipc.TypeDesktopStop, req, 10*time.Second)
			if err != nil {
				return tools.NewErrorResult(fmt.Errorf("IPC desktop stop failed: %w", err), time.Since(start).Milliseconds())
			}
			return tools.NewSuccessResult(map[string]any{"stopped": true}, time.Since(start).Milliseconds())
		}
		// Fall through to direct stop if no helper found
	}

	h.desktopMgr.StopSession(sessionID)
	return tools.NewSuccessResult(map[string]any{"stopped": true}, time.Since(start).Milliseconds())
}

func handleListSessions(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	detector := sessionbroker.NewSessionDetector()
	detected, err := detector.ListSessions()
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	// Merge with broker state to show which sessions have connected helpers
	var helperSessions []sessionbroker.SessionInfo
	if h.sessionBroker != nil {
		helperSessions = h.sessionBroker.AllSessions()
	}

	helperByWinSession := make(map[string]bool)
	for _, hs := range helperSessions {
		if hs.WinSessionID != "" {
			helperByWinSession[hs.WinSessionID] = true
		}
	}

	items := make([]ipc.SessionInfoItem, 0, len(detected))
	for _, ds := range detected {
		var sessionNum uint32
		fmt.Sscanf(ds.Session, "%d", &sessionNum)
		items = append(items, ipc.SessionInfoItem{
			SessionID:       sessionNum,
			Username:        ds.Username,
			State:           ds.State,
			Type:            ds.Type,
			HelperConnected: helperByWinSession[ds.Session],
		})
	}

	return tools.NewSuccessResult(map[string]any{
		"sessions": items,
	}, time.Since(start).Milliseconds())
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
