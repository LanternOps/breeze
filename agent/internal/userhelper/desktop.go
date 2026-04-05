package userhelper

import (
	"encoding/json"
	"fmt"
	"image"
	"regexp"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
)

const (
	maxDesktopDisplayIndex = 16
	maxDesktopOfferBytes   = 256 * 1024
	maxDesktopICEBytes     = 64 * 1024
)

var helperDesktopSessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

// helperDesktopManager manages remote desktop sessions within the user helper.
// It wraps desktop.SessionManager and handles IPC-driven lifecycle.
type helperDesktopManager struct {
	mgr *desktop.SessionManager
}

func newHelperDesktopManager(desktopContext string) *helperDesktopManager {
	mgr := desktop.NewSessionManager()
	cfg := mgr.CaptureConfig()
	if desktopContext != "" {
		cfg.DesktopContext = desktopContext
	}
	mgr.SetCaptureConfig(cfg)
	return &helperDesktopManager{mgr: mgr}
}

// startSession parses the IPC request, creates the WebRTC session, and returns
// the SDP answer.
func (h *helperDesktopManager) startSession(req *ipc.DesktopStartRequest) (*ipc.DesktopStartResponse, error) {
	// Parse ICE servers from raw JSON
	var iceServers []desktop.ICEServerConfig
	if len(req.ICEServers) > 0 {
		if err := json.Unmarshal(req.ICEServers, &iceServers); err != nil {
			log.Warn("failed to parse ICE servers from IPC, using defaults", "error", err)
		}
	}

	if req.GPUVendor != "" {
		h.mgr.SetGPUVendor(req.GPUVendor)
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

func validateDesktopStartRequest(req *ipc.DesktopStartRequest) error {
	if req == nil {
		return fmt.Errorf("desktop start request is required")
	}
	if !helperDesktopSessionIDPattern.MatchString(req.SessionID) {
		return fmt.Errorf("invalid sessionId")
	}
	if req.Offer == "" {
		return fmt.Errorf("offer is required")
	}
	if len(req.Offer) > maxDesktopOfferBytes {
		return fmt.Errorf("offer too large")
	}
	if len(req.ICEServers) > maxDesktopICEBytes {
		return fmt.Errorf("iceServers too large")
	}
	if req.DisplayIndex < 0 || req.DisplayIndex > maxDesktopDisplayIndex {
		return fmt.Errorf("displayIndex out of range")
	}
	return nil
}

func validateDesktopStopRequest(req *ipc.DesktopStopRequest) error {
	if req == nil {
		return fmt.Errorf("desktop stop request is required")
	}
	if !helperDesktopSessionIDPattern.MatchString(req.SessionID) {
		return fmt.Errorf("invalid sessionId")
	}
	return nil
}

// stopSession tears down the desktop session.
func (h *helperDesktopManager) stopSession(sessionID string) {
	h.mgr.StopSession(sessionID)
}

// captureScreenshot captures a single frame from the active WebRTC session's
// capturer. Returns desktop.ErrNoActiveSession if no session is streaming.
func (h *helperDesktopManager) captureScreenshot(displayIndex int) (*image.RGBA, int, int, error) {
	return h.mgr.CaptureScreenshot(displayIndex)
}

// stopAll tears down all active sessions (for shutdown).
func (h *helperDesktopManager) stopAll() {
	h.mgr.StopAllSessions()
}

func (h *helperDesktopManager) hasActiveSessions() bool {
	return h.mgr.HasActiveSessions()
}
