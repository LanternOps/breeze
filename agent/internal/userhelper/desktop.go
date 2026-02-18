package userhelper

import (
	"encoding/json"
	"fmt"
	"sync"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
)

// helperDesktopManager manages remote desktop sessions within the user helper.
// It wraps desktop.SessionManager and handles IPC-driven lifecycle.
type helperDesktopManager struct {
	mgr *desktop.SessionManager
	mu  sync.Mutex
}

func newHelperDesktopManager() *helperDesktopManager {
	return &helperDesktopManager{
		mgr: desktop.NewSessionManager(),
	}
}

// startSession parses the IPC request, creates the WebRTC session, and returns
// the SDP answer.
func (h *helperDesktopManager) startSession(req *ipc.DesktopStartRequest) (*ipc.DesktopStartResponse, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	// Parse ICE servers from raw JSON
	var iceServers []desktop.ICEServerConfig
	if len(req.ICEServers) > 0 {
		if err := json.Unmarshal(req.ICEServers, &iceServers); err != nil {
			log.Warn("failed to parse ICE servers from IPC, using defaults", "error", err)
		}
	}

	answer, err := h.mgr.StartSession(req.SessionID, req.Offer, iceServers, req.DisplayIndex)
	if err != nil {
		return nil, fmt.Errorf("start desktop session: %w", err)
	}

	return &ipc.DesktopStartResponse{
		SessionID: req.SessionID,
		Answer:    answer,
	}, nil
}

// stopSession tears down the desktop session.
func (h *helperDesktopManager) stopSession(sessionID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.mgr.StopSession(sessionID)
}

// stopAll tears down all active sessions (for shutdown).
func (h *helperDesktopManager) stopAll() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.mgr.StopAllSessions()
}
