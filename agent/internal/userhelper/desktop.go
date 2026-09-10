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

	// Sane upper bounds for caller-supplied lifetime limits. Values above the
	// cap are almost certainly a bug or hostile input.
	maxIdleTimeoutMinutes   = 1440 // 24h
	maxSessionDurationHours = 12   // hard cap; 0 and >12 both resolve to it
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

	// Build the agent-enforced policy via the single centralized decoder so the
	// nil→permissive clipboard logic and the <=0→unset timeout logic live in
	// exactly one place (shared base with the map-payload decoder). Bounds were
	// already enforced by validateDesktopStartRequest.
	policy := desktop.ResolveSessionPolicyFromIPC(*req)

	answer, err := h.mgr.StartSession(req.SessionID, req.Offer, iceServers, req.DisplayIndex, policy)
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
	// Clamp/reject lifetime bounds. Negative values must NOT silently decode to
	// "disabled" (fail-open) — reject them outright rather than letting the >0
	// guard in the policy decoder drop them.
	if req.IdleTimeoutMinutes < 0 {
		return fmt.Errorf("idleTimeoutMinutes must not be negative: %d", req.IdleTimeoutMinutes)
	}
	if req.IdleTimeoutMinutes > maxIdleTimeoutMinutes {
		return fmt.Errorf("idleTimeoutMinutes %d exceeds max %d", req.IdleTimeoutMinutes, maxIdleTimeoutMinutes)
	}
	if req.MaxSessionDurationHours < 0 {
		return fmt.Errorf("maxSessionDurationHours must not be negative: %d", req.MaxSessionDurationHours)
	}
	// An over-cap max duration is CLAMPED here rather than rejected. Rejecting
	// it would refuse the whole session over a stale policy value, and the
	// clamp is the same one both decoders apply (0 and >12h → 12h), so the
	// helper can never be pushed past the 12h ceiling either way.
	if req.MaxSessionDurationHours > maxSessionDurationHours {
		req.MaxSessionDurationHours = maxSessionDurationHours
	}
	// A start with no revocation lease is refused: the API is not in the
	// peer-to-peer data path, so without a lease this session could never be
	// ended by the control plane.
	if req.RevocationLease == nil {
		return desktop.ErrRevocationLeaseRequired
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

func (h *helperDesktopManager) setAtLoginWindow(atLoginWindow bool) {
	h.mgr.SetAtLoginWindow(atLoginWindow)
}
