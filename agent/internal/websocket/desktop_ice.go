package websocket

import (
	"encoding/json"
	"fmt"
)

// DesktopICETrickleCapability is advertised by servers that accept
// `desktop_ice_candidate` frames (#9182). Agents send none to a server
// without it: an older server rejects unknown frame types with an error.
const DesktopICETrickleCapability = "desktop_ice_trickle"

// maxDesktopICECandidateBytes bounds one candidate line. Real lines are
// ~100–200 bytes; anything near this is not a candidate.
const maxDesktopICECandidateBytes = 1024

// DesktopICECandidate is an RTCIceCandidateInit on the wire, the same shape
// in both directions.
type DesktopICECandidate struct {
	Candidate        string  `json:"candidate"`
	SDPMid           *string `json:"sdpMid,omitempty"`
	SDPMLineIndex    *uint16 `json:"sdpMLineIndex,omitempty"`
	UsernameFragment *string `json:"usernameFragment,omitempty"`
}

// DesktopICECandidateMessage is a viewer candidate the server relayed for a
// desktop session this agent hosts.
type DesktopICECandidateMessage struct {
	SessionID       string
	StartGeneration string
	Candidate       DesktopICECandidate
}

// SendDesktopICECandidate trickles one of the agent's local candidates for a
// desktop session to the server; a nil candidate is the end-of-gathering
// marker. seq orders a session's entries (see desktop.LocalICECandidate).
//
// Fire-and-forget like command_progress: never blocks (drops when the send
// channel is full) and sends nothing to a server that did not advertise
// DesktopICETrickleCapability. A lost candidate degrades the session to the
// candidates in the answer, which is what every session had before trickle.
func (c *Client) SendDesktopICECandidate(sessionID, startGeneration string, seq int, cand *DesktopICECandidate) error {
	if !c.HasServerCapability(DesktopICETrickleCapability) {
		return ErrServerLacksCapability
	}
	frame := map[string]any{
		"type":            "desktop_ice_candidate",
		"sessionId":       sessionID,
		"startGeneration": startGeneration,
		"seq":             seq,
	}
	if cand == nil {
		frame["complete"] = true
	} else {
		frame["candidate"] = cand
	}
	data, err := json.Marshal(frame)
	if err != nil {
		return fmt.Errorf("failed to marshal desktop_ice_candidate: %w", err)
	}
	select {
	case c.sendChan <- data:
		return nil
	case <-c.done:
		return fmt.Errorf("client is stopped")
	default:
		return fmt.Errorf("send channel full, dropping desktop_ice_candidate")
	}
}

// handleDesktopICECandidateMessage decodes a relayed viewer candidate and
// hands it to OnDesktopICECandidate. Malformed frames are dropped with a log.
func (c *Client) handleDesktopICECandidateMessage(raw []byte) {
	var frame struct {
		SessionID       string               `json:"sessionId"`
		StartGeneration string               `json:"startGeneration"`
		Candidate       *DesktopICECandidate `json:"candidate"`
	}
	if err := json.Unmarshal(raw, &frame); err != nil || frame.SessionID == "" ||
		frame.Candidate == nil || frame.Candidate.Candidate == "" ||
		len(frame.Candidate.Candidate) > maxDesktopICECandidateBytes {
		log.Warn("dropping malformed desktop_ice_candidate frame")
		return
	}
	if c.OnDesktopICECandidate == nil {
		return
	}
	c.OnDesktopICECandidate(DesktopICECandidateMessage{
		SessionID:       frame.SessionID,
		StartGeneration: frame.StartGeneration,
		Candidate:       *frame.Candidate,
	})
}
