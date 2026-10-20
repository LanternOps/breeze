package heartbeat

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"github.com/pion/webrtc/v4"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
	"github.com/breeze-rmm/agent/internal/websocket"
)

// Trickle ICE for WebRTC desktop sessions (#9182).
//
// Outbound: a session's local candidates gathered after its answer leave the
// desktop SessionManager (this process, or a helper over IPC) and go to the
// API as `desktop_ice_candidate` frames; the viewer polls them from there.
// Inbound: viewer candidates the API relays arrive as id-less
// `desktop_ice_candidate` frames and are applied to the session wherever it
// is hosted.

// forwardLocalICECandidate is the SessionManager's OnLocalICECandidate for
// sessions hosted in this process.
func (h *Heartbeat) forwardLocalICECandidate(sessionID, startGeneration string, c desktop.LocalICECandidate) {
	var cand *websocket.DesktopICECandidate
	if !c.Complete {
		if c.Candidate == nil {
			return
		}
		cand = &websocket.DesktopICECandidate{
			Candidate:        c.Candidate.Candidate,
			SDPMid:           c.Candidate.SDPMid,
			SDPMLineIndex:    c.Candidate.SDPMLineIndex,
			UsernameFragment: c.Candidate.UsernameFragment,
		}
	}
	h.sendDesktopICE(sessionID, startGeneration, c.Seq, cand)
}

func (h *Heartbeat) sendDesktopICE(sessionID, startGeneration string, seq int, cand *websocket.DesktopICECandidate) {
	send := h.desktopICESender
	if send == nil {
		return
	}
	if startGeneration == "" {
		// The API binds every entry to a start generation and refuses frames
		// without one; only a server too old to send generations (and so too
		// old to advertise trickle) produces this.
		log.Debug("not trickling a desktop ICE candidate for a start without a generation", "sessionId", sessionID)
		return
	}
	if err := send(sessionID, startGeneration, seq, cand); err != nil {
		if errors.Is(err, websocket.ErrServerLacksCapability) {
			// An older API: the session keeps the candidates in its answer,
			// exactly as before trickle existed.
			log.Debug("server does not accept trickled ICE candidates", "sessionId", sessionID)
			return
		}
		log.Warn("failed to trickle a desktop ICE candidate", "sessionId", sessionID, "seq", seq, "error", err.Error())
	}
}

// handleHelperLocalICECandidate relays a helper-hosted session's trickle
// entry to the API. Handled inline on the broker's receive loop so a
// helper's entries leave in the order it sent them; the send itself never
// blocks.
func (h *Heartbeat) handleHelperLocalICECandidate(session *sessionbroker.Session, env *ipc.Envelope) {
	var notice ipc.DesktopLocalICECandidate
	if err := json.Unmarshal(env.Payload, &notice); err != nil {
		log.Warn("invalid desktop ICE candidate payload", "error", err.Error())
		return
	}
	if !desktopSessionIDPattern.MatchString(notice.SessionID) {
		log.Warn("dropping desktop ICE candidate with invalid session ID",
			"sessionId", notice.SessionID, "helperSession", session.SessionID)
		return
	}
	// Only the helper hosting the session may speak for it. The owner is
	// recorded before the service sends desktop_ice_trickle_begin, so a
	// well-behaved helper never trickles ahead of this.
	if owner := h.desktopOwnerSession(notice.SessionID); owner == nil || owner.SessionID != session.SessionID {
		log.Warn("dropping desktop ICE candidate for non-owned session",
			"sessionId", notice.SessionID, "helperSession", session.SessionID)
		return
	}
	var cand *websocket.DesktopICECandidate
	if !notice.Complete {
		if notice.Candidate == nil {
			return
		}
		if err := notice.Candidate.Validate(); err != nil {
			log.Warn("dropping invalid desktop ICE candidate from helper",
				"sessionId", notice.SessionID, "error", err.Error())
			return
		}
		cand = &websocket.DesktopICECandidate{
			Candidate:        notice.Candidate.Candidate,
			SDPMid:           notice.Candidate.SDPMid,
			SDPMLineIndex:    notice.Candidate.SDPMLineIndex,
			UsernameFragment: notice.Candidate.UsernameFragment,
		}
	}
	h.sendDesktopICE(notice.SessionID, notice.StartGeneration, notice.Seq, cand)
}

// onRemoteDesktopICECandidate is the WebSocket client's OnDesktopICECandidate.
// It runs on the read pump, so the work (possibly an IPC write) is handed off.
func (h *Heartbeat) onRemoteDesktopICECandidate(msg websocket.DesktopICECandidateMessage) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Error("panic applying relayed desktop ICE candidate", "error", fmt.Sprint(r))
			}
		}()
		h.applyRemoteDesktopICECandidate(msg)
	}()
}

func (h *Heartbeat) applyRemoteDesktopICECandidate(msg websocket.DesktopICECandidateMessage) {
	if !desktopSessionIDPattern.MatchString(msg.SessionID) {
		log.Warn("dropping relayed desktop ICE candidate with invalid session ID", "sessionId", msg.SessionID)
		return
	}
	cand := ipc.ICECandidate{
		Candidate:        msg.Candidate.Candidate,
		SDPMid:           msg.Candidate.SDPMid,
		SDPMLineIndex:    msg.Candidate.SDPMLineIndex,
		UsernameFragment: msg.Candidate.UsernameFragment,
	}
	if err := cand.Validate(); err != nil {
		log.Warn("dropping invalid relayed desktop ICE candidate", "sessionId", msg.SessionID, "error", err.Error())
		return
	}
	if owner := h.desktopOwnerSession(msg.SessionID); owner != nil {
		relay := ipc.DesktopRemoteICECandidate{
			SessionID:       msg.SessionID,
			StartGeneration: msg.StartGeneration,
			Candidate:       cand,
		}
		if err := owner.SendNotify("desk-ice-remote-"+msg.SessionID, ipc.TypeDesktopRemoteICECandidate, relay); err != nil {
			log.Warn("failed to relay viewer ICE candidate to the owning helper",
				"sessionId", msg.SessionID, "error", err.Error())
		}
		return
	}
	if h.desktopMgr == nil {
		return
	}
	if err := h.desktopMgr.AddRemoteICECandidate(msg.SessionID, msg.StartGeneration, webrtc.ICECandidateInit{
		Candidate:        cand.Candidate,
		SDPMid:           cand.SDPMid,
		SDPMLineIndex:    cand.SDPMLineIndex,
		UsernameFragment: cand.UsernameFragment,
	}); err != nil {
		// Unknown/superseded sessions are routine (a candidate racing a stop
		// or a reconnect); pion rejecting a candidate is worth a warning.
		if errors.Is(err, desktop.ErrNoICESession) || errors.Is(err, desktop.ErrStaleICEGeneration) {
			log.Debug("dropping relayed desktop ICE candidate", "sessionId", msg.SessionID, "reason", err.Error())
			return
		}
		log.Warn("failed to apply relayed desktop ICE candidate", "sessionId", msg.SessionID, "error", err.Error())
	}
}

// beginDirectICETrickle starts trickling for a session this process hosts,
// once its answer is on its way to the API.
func (h *Heartbeat) beginDirectICETrickle(sessionID string, fence desktopStartFenceInput) {
	if h.desktopMgr == nil {
		return
	}
	if !h.desktopMgr.BeginICETrickle(sessionID, formatFenceGeneration(fence)) {
		// The session was torn down between its answer and here, or the
		// emitter is not wired. Either way its late candidates stay local.
		log.Warn("ICE trickle not started for a direct desktop session; late candidates will not reach the viewer",
			"sessionId", sessionID)
	}
}

// beginHelperICETrickle tells the helper hosting sessionID to start sending
// its late candidates. Sent only after rememberDesktopOwner, so the owner
// check in handleHelperLocalICECandidate admits every entry it then sends.
func (h *Heartbeat) beginHelperICETrickle(session *sessionbroker.Session, sessionID, startGeneration string) {
	if session == nil {
		return
	}
	begin := ipc.DesktopICETrickleBegin{SessionID: sessionID, StartGeneration: startGeneration}
	if err := session.SendNotify("desk-ice-begin-"+sessionID, ipc.TypeDesktopICETrickleBegin, begin); err != nil {
		log.Warn("failed to start ICE trickle on the helper; the session keeps the candidates in its answer",
			"sessionId", sessionID, "error", err.Error())
	}
}

func formatFenceGeneration(fence desktopStartFenceInput) string {
	if !fence.HasGeneration {
		return ""
	}
	return strconv.FormatInt(fence.Generation, 10)
}
