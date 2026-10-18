package heartbeat

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/websocket"
	"github.com/pion/webrtc/v4"
)

// #9182: trickle ICE plumbing between the desktop session (in this process or
// a helper), the agent WebSocket and the API.

type sentICE struct {
	sessionID, generation string
	seq                   int
	cand                  *websocket.DesktopICECandidate
}

func recordingICESender(ch chan sentICE) func(string, string, int, *websocket.DesktopICECandidate) error {
	return func(sessionID, generation string, seq int, cand *websocket.DesktopICECandidate) error {
		ch <- sentICE{sessionID, generation, seq, cand}
		return nil
	}
}

func TestDirectSessionLateCandidateIsSentToTheControlPlane(t *testing.T) {
	sent := make(chan sentICE, 2)
	h := &Heartbeat{desktopICESender: recordingICESender(sent)}

	mid := "0"
	idx := uint16(0)
	h.forwardLocalICECandidate("desk-1", "12", desktop.LocalICECandidate{
		Seq:       0,
		Candidate: &webrtc.ICECandidateInit{Candidate: "candidate:9 1 udp 16777215 198.51.100.7 3478 typ relay", SDPMid: &mid, SDPMLineIndex: &idx},
	})
	h.forwardLocalICECandidate("desk-1", "12", desktop.LocalICECandidate{Seq: 1, Complete: true})

	first := <-sent
	if first.sessionID != "desk-1" || first.generation != "12" || first.seq != 0 || first.cand == nil ||
		first.cand.Candidate != "candidate:9 1 udp 16777215 198.51.100.7 3478 typ relay" ||
		first.cand.SDPMid == nil || *first.cand.SDPMid != "0" {
		t.Fatalf("relay candidate not forwarded intact: %#v", first)
	}
	second := <-sent
	if second.seq != 1 || second.cand != nil {
		t.Fatalf("completion must be sent as a nil candidate, got %#v", second)
	}
}

func TestHelperLocalICECandidateIsForwardedToTheControlPlane(t *testing.T) {
	session, _ := newLeaseBridgeHelper(t, "helper-ice")
	sent := make(chan sentICE, 1)
	h := &Heartbeat{
		sessionBroker:    newTestBrokerWithSessions(t, session),
		isHeadless:       true,
		desktopMgr:       desktop.NewSessionManager(),
		desktopICESender: recordingICESender(sent),
	}
	h.rememberDesktopOwner("desk-ice", session.SessionID)

	payload, _ := json.Marshal(ipc.DesktopLocalICECandidate{
		SessionID:       "desk-ice",
		StartGeneration: "5",
		Seq:             2,
		Candidate:       &ipc.ICECandidate{Candidate: "candidate:9 1 udp 16777215 198.51.100.7 3478 typ relay"},
	})
	h.handleUserHelperMessage(session, &ipc.Envelope{ID: "ice-1", Type: ipc.TypeDesktopLocalICECandidate, Payload: payload})

	select {
	case got := <-sent:
		if got.sessionID != "desk-ice" || got.generation != "5" || got.seq != 2 || got.cand == nil {
			t.Fatalf("unexpected forward: %#v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("the helper's late candidate never reached the control plane")
	}
}

func TestHelperLocalICECandidateFromANonOwnerIsDropped(t *testing.T) {
	owner, _ := newLeaseBridgeHelper(t, "helper-ice-owner")
	stranger, _ := newLeaseBridgeHelper(t, "helper-ice-stranger")
	sent := make(chan sentICE, 1)
	h := &Heartbeat{
		sessionBroker:    newTestBrokerWithSessions(t, owner, stranger),
		isHeadless:       true,
		desktopMgr:       desktop.NewSessionManager(),
		desktopICESender: recordingICESender(sent),
	}
	h.rememberDesktopOwner("desk-ice-owned", owner.SessionID)

	payload, _ := json.Marshal(ipc.DesktopLocalICECandidate{
		SessionID: "desk-ice-owned",
		Candidate: &ipc.ICECandidate{Candidate: "candidate:x"},
	})
	h.handleUserHelperMessage(stranger, &ipc.Envelope{ID: "ice-2", Type: ipc.TypeDesktopLocalICECandidate, Payload: payload})

	select {
	case got := <-sent:
		t.Fatalf("a non-owning helper injected a candidate: %#v", got)
	case <-time.After(200 * time.Millisecond):
	}
}

func TestHelperLocalICECandidateOversizedIsDropped(t *testing.T) {
	session, _ := newLeaseBridgeHelper(t, "helper-ice-big")
	sent := make(chan sentICE, 1)
	h := &Heartbeat{
		sessionBroker:    newTestBrokerWithSessions(t, session),
		isHeadless:       true,
		desktopMgr:       desktop.NewSessionManager(),
		desktopICESender: recordingICESender(sent),
	}
	h.rememberDesktopOwner("desk-ice-big", session.SessionID)
	big := make([]byte, ipc.MaxICECandidateBytes+1)
	for i := range big {
		big[i] = 'a'
	}
	payload, _ := json.Marshal(ipc.DesktopLocalICECandidate{SessionID: "desk-ice-big", Candidate: &ipc.ICECandidate{Candidate: string(big)}})
	h.handleUserHelperMessage(session, &ipc.Envelope{ID: "ice-3", Type: ipc.TypeDesktopLocalICECandidate, Payload: payload})

	select {
	case got := <-sent:
		t.Fatalf("an oversized candidate was forwarded: %#v", got)
	case <-time.After(200 * time.Millisecond):
	}
}

func TestRelayedViewerICECandidateReachesTheOwningHelper(t *testing.T) {
	session, received := newLeaseBridgeHelper(t, "helper-remote-ice")
	h := &Heartbeat{
		sessionBroker: newTestBrokerWithSessions(t, session),
		isHeadless:    true,
		desktopMgr:    desktop.NewSessionManager(),
	}
	h.rememberDesktopOwner("desk-remote-ice", session.SessionID)

	frag := "ufrag1"
	h.onRemoteDesktopICECandidate(websocket.DesktopICECandidateMessage{
		SessionID:       "desk-remote-ice",
		StartGeneration: "8",
		Candidate:       websocket.DesktopICECandidate{Candidate: "candidate:1 1 udp 1 203.0.113.9 9 typ relay", UsernameFragment: &frag},
	})

	env := awaitEnvelope(t, received, ipc.TypeDesktopRemoteICECandidate)
	var got ipc.DesktopRemoteICECandidate
	if err := json.Unmarshal(env.Payload, &got); err != nil {
		t.Fatal(err)
	}
	if got.SessionID != "desk-remote-ice" || got.StartGeneration != "8" ||
		got.Candidate.Candidate != "candidate:1 1 udp 1 203.0.113.9 9 typ relay" ||
		got.Candidate.UsernameFragment == nil || *got.Candidate.UsernameFragment != "ufrag1" {
		t.Fatalf("viewer candidate not relayed intact: %#v", got)
	}
}

func TestBeginHelperICETrickleTellsTheOwningHelper(t *testing.T) {
	session, received := newLeaseBridgeHelper(t, "helper-begin")
	h := &Heartbeat{sessionBroker: newTestBrokerWithSessions(t, session)}

	h.beginHelperICETrickle(session, "desk-begin", "3")

	env := awaitEnvelope(t, received, ipc.TypeDesktopICETrickleBegin)
	var got ipc.DesktopICETrickleBegin
	if err := json.Unmarshal(env.Payload, &got); err != nil {
		t.Fatal(err)
	}
	if got.SessionID != "desk-begin" || got.StartGeneration != "3" {
		t.Fatalf("unexpected begin: %#v", got)
	}
}
