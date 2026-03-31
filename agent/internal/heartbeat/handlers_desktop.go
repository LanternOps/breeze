package heartbeat

import (
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

const (
	maxDesktopDisplayIndex  = 16
	maxDesktopCoordinateAbs = 100000
	maxDesktopScrollDelta   = 120
	maxDesktopKeyBytes      = 64
	maxDesktopModifierBytes = 16
	maxDesktopModifiers     = 8
)

var desktopInputTypes = map[string]struct{}{
	"mouse_move":   {},
	"mouse_click":  {},
	"mouse_down":   {},
	"mouse_up":     {},
	"mouse_scroll": {},
	"key_press":    {},
	"key_down":     {},
	"key_up":       {},
}

var desktopMouseButtons = map[string]struct{}{
	"":       {},
	"left":   {},
	"right":  {},
	"middle": {},
}

var desktopInputModifiers = map[string]string{
	"alt":     "alt",
	"cmd":     "meta",
	"control": "ctrl",
	"ctrl":    "ctrl",
	"meta":    "meta",
	"shift":   "shift",
	"super":   "meta",
	"win":     "meta",
}

// handleSASFromHelper is called when the user helper requests a Secure
// Attention Sequence. The service process (this process) is SCM-registered
// and is the most reliable path for SendSAS(FALSE). The helper can also
// attempt InvokeSAS() as a fallback (see session_control.go), but SendSAS
// may be ignored by Windows if the caller is not SCM-registered.
func (h *Heartbeat) handleSASFromHelper(session *sessionbroker.Session, env *ipc.Envelope) {
	log.Info("SAS request from user helper",
		"identity", session.IdentityKey,
		"winSession", session.WinSessionID,
	)

	sasErr := desktop.InvokeSAS()
	resp := ipc.SASResponse{OK: sasErr == nil}
	if sasErr != nil {
		resp.Error = sasErr.Error()
		log.Warn("SAS invocation failed", "error", sasErr.Error())
	} else {
		log.Info("SAS invoked successfully from service context")
	}

	if err := session.SendNotify(env.ID, ipc.TypeSASResponse, resp); err != nil {
		log.Warn("failed to send SAS response to helper", "error", err.Error())
	}
}

// serviceUnavailable returns a failed CommandResult for commands that cannot
// operate from Session 0 (Windows service mode).
func serviceUnavailable(command string, start time.Time) tools.CommandResult {
	return tools.CommandResult{
		Status:     "failed",
		Error:      command + " unavailable in headless/service mode; use WebRTC instead",
		DurationMs: time.Since(start).Milliseconds(),
	}
}

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
	log.Info("start_desktop command received",
		"commandId", cmd.ID,
		"sessionId", sessionID,
		"hasOffer", offer != "",
		"isService", h.isService,
		"isHeadless", h.isHeadless,
		"hasBroker", h.sessionBroker != nil,
	)
	if sessionID == "" || offer == "" {
		return tools.CommandResult{
			Status:     "failed",
			Error:      "missing sessionId or offer",
			DurationMs: time.Since(start).Milliseconds(),
		}
	}
	if err := validateDesktopSessionID(sessionID); err != nil {
		return tools.CommandResult{
			Status:     "failed",
			Error:      err.Error(),
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
	if di, ok := cmd.Payload["displayIndex"].(float64); ok {
		if di < 0 || di > maxDesktopDisplayIndex || math.Trunc(di) != di {
			return tools.CommandResult{
				Status:     "failed",
				Error:      fmt.Sprintf("displayIndex must be an integer between 0 and %d", maxDesktopDisplayIndex),
				DurationMs: time.Since(start).Milliseconds(),
			}
		}
		displayIndex = int(di)
	}

	// Route through IPC helper when running headless (no display access).
	// ScreenCaptureKit requires a GUI session (Aqua) — root daemons on macOS
	// cannot capture the screen directly even with TCC permission.
	if (h.isService || h.isHeadless) && h.sessionBroker != nil {
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

func handleStopDesktop(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	sessionID, errResult := requireValidatedDesktopSessionID(cmd.Payload)
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}

	// Service/headless mode: relay stop to user helper
	if (h.isService || h.isHeadless) && h.sessionBroker != nil {
		session := h.desktopOwnerSession(sessionID)
		if session == nil {
			return tools.CommandResult{
				Status:     "failed",
				Error:      "desktop session owner unavailable; cannot safely stop session",
				DurationMs: time.Since(start).Milliseconds(),
			}
		}
		req := ipc.DesktopStopRequest{SessionID: sessionID}
		_, err := session.SendCommand("desk-stop-"+sessionID, ipc.TypeDesktopStop, req, 10*time.Second)
		if err != nil {
			return tools.NewErrorResult(fmt.Errorf("IPC desktop_stop: %w", err), time.Since(start).Milliseconds())
		}
		h.forgetDesktopOwner(sessionID)
	} else {
		h.desktopMgr.StopSession(sessionID)
	}

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
		sessionNum, err := sessionbroker.ParseWindowsSessionIDForHeartbeat(ds.Session)
		if err != nil {
			continue
		}
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

	// WS-based desktop streaming cannot work from headless mode (no display).
	// The viewer should use WebRTC (start_desktop) when connecting to a headless agent.
	if h.isService || h.isHeadless {
		return serviceUnavailable("desktop_stream_start", start)
	}

	sessionID, errResult := requireValidatedDesktopSessionID(cmd.Payload)
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
	displayIndex := 0
	if di, ok := cmd.Payload["displayIndex"].(float64); ok {
		if di < 0 || di > maxDesktopDisplayIndex || math.Trunc(di) != di {
			return tools.CommandResult{
				Status:     "failed",
				Error:      fmt.Sprintf("displayIndex must be an integer between 0 and %d", maxDesktopDisplayIndex),
				DurationMs: time.Since(start).Milliseconds(),
			}
		}
		displayIndex = int(di)
	}

	startSession := h.wsDesktopStart
	if startSession == nil {
		startSession = h.wsDesktopMgr.StartSession
	}
	w, h2, err := startSession(sessionID, displayIndex, config, func(sid string, data []byte) error {
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
	if h.isService || h.isHeadless {
		// No WS stream running in headless mode — return success as a no-op.
		return tools.NewSuccessResult(map[string]any{"stopped": true}, time.Since(start).Milliseconds())
	}
	sessionID, errResult := requireValidatedDesktopSessionID(cmd.Payload)
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}
	h.wsDesktopMgr.StopSession(sessionID)
	return tools.NewSuccessResult(map[string]any{"stopped": true}, time.Since(start).Milliseconds())
}

func handleDesktopInput(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	// Input injection cannot work from headless mode (no display context).
	// WebRTC sessions handle input via the data channel in the user helper.
	if h.isService || h.isHeadless {
		return serviceUnavailable("desktop_input", start)
	}

	sessionID, errResult := requireValidatedDesktopSessionID(cmd.Payload)
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
	event, err := normalizeDesktopInputEvent(e)
	if err != nil {
		return tools.CommandResult{
			Status:     "failed",
			Error:      err.Error(),
			DurationMs: time.Since(start).Milliseconds(),
		}
	}
	if err := h.wsDesktopMgr.HandleInput(sessionID, event); err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(map[string]any{"ok": true}, time.Since(start).Milliseconds())
}

func handleDesktopConfig(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	if h.isService || h.isHeadless {
		return serviceUnavailable("desktop_config", start)
	}
	sessionID, errResult := requireValidatedDesktopSessionID(cmd.Payload)
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

func requireValidatedDesktopSessionID(payload map[string]any) (string, *tools.CommandResult) {
	sessionID, errResult := tools.RequirePayloadString(payload, "sessionId")
	if errResult != nil {
		return "", errResult
	}
	if err := validateDesktopSessionID(sessionID); err != nil {
		return "", &tools.CommandResult{
			Status: "failed",
			Error:  err.Error(),
		}
	}
	return sessionID, nil
}

func validateDesktopSessionID(sessionID string) error {
	if !desktopSessionIDPattern.MatchString(sessionID) {
		return fmt.Errorf("invalid sessionId")
	}
	return nil
}

func normalizeDesktopInputEvent(raw map[string]any) (desktop.InputEvent, error) {
	var event desktop.InputEvent

	eventType, ok := raw["type"].(string)
	if !ok || strings.TrimSpace(eventType) == "" {
		return event, fmt.Errorf("event type is required")
	}
	event.Type = strings.ToLower(strings.TrimSpace(eventType))
	if _, ok := desktopInputTypes[event.Type]; !ok {
		return event, fmt.Errorf("invalid event type")
	}

	x, err := readDesktopCoordinate(raw["x"])
	if err != nil {
		return event, fmt.Errorf("invalid x coordinate")
	}
	y, err := readDesktopCoordinate(raw["y"])
	if err != nil {
		return event, fmt.Errorf("invalid y coordinate")
	}
	event.X = x
	event.Y = y

	button, err := normalizeDesktopButton(raw["button"])
	if err != nil {
		return event, err
	}
	event.Button = button

	key, err := normalizeDesktopKey(raw["key"])
	if err != nil {
		return event, err
	}
	event.Key = key

	delta, err := normalizeDesktopScrollDelta(raw["delta"])
	if err != nil {
		return event, err
	}
	event.Delta = delta

	modifiers, err := normalizeDesktopModifiers(raw["modifiers"])
	if err != nil {
		return event, err
	}
	event.Modifiers = modifiers

	switch event.Type {
	case "mouse_click", "mouse_down", "mouse_up":
		if event.Button == "" {
			event.Button = "left"
		}
	case "key_press", "key_down", "key_up":
		if event.Key == "" {
			return event, fmt.Errorf("key is required for keyboard events")
		}
	case "mouse_scroll":
		if event.Delta == 0 {
			return event, fmt.Errorf("delta is required for mouse_scroll")
		}
	}

	return event, nil
}

func readDesktopCoordinate(value any) (int, error) {
	if value == nil {
		return 0, nil
	}
	number, ok := value.(float64)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) || math.Trunc(number) != number || math.Abs(number) > maxDesktopCoordinateAbs {
		return 0, fmt.Errorf("invalid coordinate")
	}
	return int(number), nil
}

func normalizeDesktopButton(value any) (string, error) {
	if value == nil {
		return "", nil
	}
	button, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("invalid mouse button")
	}
	if button == "" {
		return "", nil
	}
	button = strings.ToLower(strings.TrimSpace(button))
	if _, ok := desktopMouseButtons[button]; !ok {
		return "", fmt.Errorf("invalid mouse button")
	}
	return button, nil
}

func normalizeDesktopKey(value any) (string, error) {
	if value == nil {
		return "", nil
	}
	key, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("invalid key")
	}
	if key == "" {
		return "", nil
	}
	key = strings.TrimSpace(key)
	if key == "" || len(key) > maxDesktopKeyBytes {
		return "", fmt.Errorf("invalid key")
	}
	return key, nil
}

func normalizeDesktopScrollDelta(value any) (int, error) {
	if value == nil {
		return 0, nil
	}
	delta, ok := value.(float64)
	if !ok || math.IsNaN(delta) || math.IsInf(delta, 0) || math.Trunc(delta) != delta || math.Abs(delta) > maxDesktopScrollDelta {
		return 0, fmt.Errorf("invalid scroll delta")
	}
	return int(delta), nil
}

func normalizeDesktopModifiers(value any) ([]string, error) {
	if value == nil {
		return nil, nil
	}
	rawModifiers, ok := value.([]any)
	if !ok {
		return nil, fmt.Errorf("invalid modifiers")
	}
	if len(rawModifiers) > maxDesktopModifiers {
		return nil, fmt.Errorf("too many modifiers")
	}

	normalized := make([]string, 0, len(rawModifiers))
	seen := make(map[string]struct{}, len(rawModifiers))
	for _, rawModifier := range rawModifiers {
		modifier, ok := rawModifier.(string)
		if !ok {
			return nil, fmt.Errorf("invalid modifier")
		}
		modifier = strings.ToLower(strings.TrimSpace(modifier))
		if modifier == "" || len(modifier) > maxDesktopModifierBytes {
			return nil, fmt.Errorf("invalid modifier")
		}
		canonical, ok := desktopInputModifiers[modifier]
		if !ok {
			return nil, fmt.Errorf("invalid modifier")
		}
		if _, ok := seen[canonical]; ok {
			continue
		}
		seen[canonical] = struct{}{}
		normalized = append(normalized, canonical)
	}
	return normalized, nil
}
