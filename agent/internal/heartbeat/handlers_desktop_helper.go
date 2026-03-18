package heartbeat

import (
	"encoding/json"
	"fmt"
	"runtime"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// spawnGuards holds a per-session mutex so that spawns into different Windows
// sessions can proceed in parallel. The sync.Map key is the target session ID
// string (or "" for auto-detect).
var spawnGuards sync.Map

// sessionSpawnMu returns a mutex for the given session key, creating one if needed.
func sessionSpawnMu(sessionKey string) *sync.Mutex {
	val, _ := spawnGuards.LoadOrStore(sessionKey, &sync.Mutex{})
	return val.(*sync.Mutex)
}

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
// If the helper crashes during the request, it automatically respawns and retries.
func (h *Heartbeat) startDesktopViaHelper(sessionID, offer string, iceServers []desktop.ICEServerConfig, displayIndex int, payload map[string]any) tools.CommandResult {
	// Read optional target Windows session ID from payload
	targetSession := ""
	if ts, ok := payload["targetSessionId"].(float64); ok {
		targetSession = fmt.Sprintf("%d", int(ts))
	}

	// Marshal ICE servers once (used across retries)
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

	// Retry up to 2 times: if the helper crashes during SendCommand, respawn
	// and retry immediately instead of failing back to the API (which adds
	// 20-30s of round-trip delay).
	const maxAttempts = 2
	for attempt := 0; attempt < maxAttempts; attempt++ {
		session := h.findOrSpawnHelper(targetSession)
		if session == nil {
			return tools.NewErrorResult(fmt.Errorf("no capable helper available after spawn attempt"), 0)
		}

		resp, err := session.SendCommand("desk-"+sessionID, ipc.TypeDesktopStart, req, 15*time.Second)
		if err != nil {
			log.Warn("IPC desktop start failed, will retry with new helper",
				"attempt", attempt+1,
				"error", err.Error(),
				"session", session.SessionID,
			)
			// Helper likely crashed — clear target so next attempt auto-detects
			targetSession = ""
			continue
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

	return tools.NewErrorResult(fmt.Errorf("desktop start failed after %d attempts (helper keeps crashing)", maxAttempts), 0)
}

// findOrSpawnHelper locates a capable helper session, spawning one if needed.
func (h *Heartbeat) findOrSpawnHelper(targetSession string) *sessionbroker.Session {
	session := h.sessionBroker.FindCapableSession("capture", targetSession)

	// Validate the helper's Windows session is still active.
	if session != nil && isWinSessionDisconnected(session.WinSessionID) {
		log.Warn("helper is in a disconnected Windows session, spawning new helper",
			"helperSession", session.SessionID,
			"winSession", session.WinSessionID)
		session = nil
		targetSession = ""
	}

	if session != nil {
		return session
	}

	// Serialize spawns per target session
	mu := sessionSpawnMu(targetSession)
	mu.Lock()
	defer mu.Unlock()

	// Re-check after lock
	session = h.sessionBroker.FindCapableSession("capture", targetSession)
	if session != nil && isWinSessionDisconnected(session.WinSessionID) {
		session = nil
		targetSession = ""
	}
	if session != nil {
		return session
	}

	if err := h.spawnHelperForDesktop(targetSession); err != nil {
		log.Warn("helper spawn failed", "error", err.Error())
		return nil
	}

	// Poll for the helper to connect (up to 10s)
	for i := 0; i < 100; i++ {
		time.Sleep(100 * time.Millisecond)
		session = h.sessionBroker.FindCapableSession("capture", targetSession)
		if session != nil && !isWinSessionDisconnected(session.WinSessionID) {
			return session
		}
	}

	log.Warn("helper spawned but did not connect within 10s")
	return nil
}

// spawnHelperForDesktop spawns a user helper in the target session.
// If targetSession is empty, it auto-detects the first active non-services session.
func (h *Heartbeat) spawnHelperForDesktop(targetSession string) error {
	if runtime.GOOS != "windows" {
		return fmt.Errorf(
			"no user-helper connected; ensure the LaunchAgent is loaded: " +
				"launchctl load /Library/LaunchAgents/com.breeze.agent-user.plist")
	}

	if targetSession == "" {
		// Prefer the physical console session (WTSGetActiveConsoleSessionId).
		// This avoids spawning into a disconnected RDP session.
		consoleID := sessionbroker.GetConsoleSessionID()

		detector := sessionbroker.NewSessionDetector()
		detected, err := detector.ListSessions()
		if err != nil {
			return fmt.Errorf("failed to list sessions: %w", err)
		}

		var consoleFallback, activeFallback, connectedFallback string
		for _, ds := range detected {
			if ds.Type == "services" {
				continue
			}
			// Console session is always preferred
			if ds.Session == consoleID && (ds.State == "active" || ds.State == "connected") {
				consoleFallback = ds.Session
			}
			if ds.State == "active" && activeFallback == "" {
				activeFallback = ds.Session
			}
			if ds.State == "connected" && connectedFallback == "" {
				connectedFallback = ds.Session
			}
		}

		// Priority: console > any active > any connected
		switch {
		case consoleFallback != "":
			targetSession = consoleFallback
		case activeFallback != "":
			targetSession = activeFallback
		case connectedFallback != "":
			targetSession = connectedFallback
		default:
			return fmt.Errorf("no active or connected non-services session found")
		}
	}

	var sessionNum uint32
	if _, err := fmt.Sscanf(targetSession, "%d", &sessionNum); err != nil {
		return fmt.Errorf("invalid session ID %q: %w", targetSession, err)
	}

	// Kill any stale helpers from previous sessions in this Windows session
	// to release DXGI Desktop Duplication locks before spawning a new one.
	h.sessionBroker.KillStaleHelpers(targetSession)

	return sessionbroker.SpawnHelperInSession(sessionNum)
}
