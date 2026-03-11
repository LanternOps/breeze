package heartbeat

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// spawnGuard prevents concurrent helper spawns for the same target session.
var spawnGuard sync.Mutex

// isWinSessionDisconnected checks whether the given Windows session ID is
// disconnected (no active display). Helpers in disconnected sessions cannot
// capture the screen. Returns false on non-Windows or if the state can't be
// determined.
func isWinSessionDisconnected(winSessionID string) bool {
	if winSessionID == "" || winSessionID == "0" {
		return false
	}
	return sessionbroker.IsSessionDisconnected(winSessionID)
}

// startDesktopViaHelper routes a desktop start request through the IPC user helper.
func (h *Heartbeat) startDesktopViaHelper(sessionID, offer string, iceServers []desktop.ICEServerConfig, displayIndex int, payload map[string]any) tools.CommandResult {
	// Read optional target Windows session ID from payload
	targetSession := ""
	if ts, ok := payload["targetSessionId"].(float64); ok {
		targetSession = fmt.Sprintf("%d", int(ts))
	}

	session := h.sessionBroker.FindCapableSession("capture", targetSession)

	// Validate the helper's Windows session is still active. A helper in a
	// disconnected session (e.g. closed RDP) can't capture the display.
	if session != nil && isWinSessionDisconnected(session.WinSessionID) {
		log.Warn("helper is in a disconnected Windows session, spawning new helper",
			"helperSession", session.SessionID,
			"winSession", session.WinSessionID)
		session = nil
		// Don't re-spawn into the same disconnected session — let auto-detection
		// find an active one instead.
		targetSession = ""
	}

	if session == nil {
		// Serialize spawns to prevent duplicate helpers for the same session
		spawnGuard.Lock()
		// Re-check after acquiring lock — another goroutine may have spawned it
		session = h.sessionBroker.FindCapableSession("capture", targetSession)
		if session != nil && isWinSessionDisconnected(session.WinSessionID) {
			session = nil
			targetSession = ""
		}
		if session == nil {
			if err := h.spawnHelperForDesktop(targetSession); err != nil {
				spawnGuard.Unlock()
				return tools.NewErrorResult(fmt.Errorf("no capable helper session and spawn failed: %w", err), 0)
			}
			// Poll for the helper to connect (up to 5s, every 500ms)
			for i := 0; i < 10; i++ {
				time.Sleep(500 * time.Millisecond)
				session = h.sessionBroker.FindCapableSession("capture", targetSession)
				if session != nil && !isWinSessionDisconnected(session.WinSessionID) {
					break
				}
				session = nil
			}
		}
		spawnGuard.Unlock()
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
		// Prefer active sessions, fall back to connected (lock screen after reboot).
		var fallback string
		for _, ds := range detected {
			if ds.Type == "services" {
				continue
			}
			if ds.State == "active" {
				targetSession = ds.Session
				break
			}
			if ds.State == "connected" && fallback == "" {
				fallback = ds.Session
			}
		}
		if targetSession == "" {
			targetSession = fallback
		}
		if targetSession == "" {
			return fmt.Errorf("no active or connected non-services session found")
		}
	}

	var sessionNum uint32
	if _, err := fmt.Sscanf(targetSession, "%d", &sessionNum); err != nil {
		return fmt.Errorf("invalid session ID %q: %w", targetSession, err)
	}

	return sessionbroker.SpawnHelperInSession(sessionNum)
}
