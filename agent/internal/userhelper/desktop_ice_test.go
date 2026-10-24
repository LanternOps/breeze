package userhelper

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
)

// #9182: the helper side of trickle ICE for helper-hosted desktop sessions.

func TestLocalICECandidateNoticeCarriesCandidateAndCompletion(t *testing.T) {
	mid := "0"
	idx := uint16(0)
	got := localICECandidateNotice("desk-1", "4", desktop.LocalICECandidate{
		Seq:       2,
		Candidate: &webrtc.ICECandidateInit{Candidate: "candidate:9 1 udp 16777215 198.51.100.7 3478 typ relay", SDPMid: &mid, SDPMLineIndex: &idx},
	})
	if got.SessionID != "desk-1" || got.StartGeneration != "4" || got.Seq != 2 || got.Complete ||
		got.Candidate == nil || got.Candidate.Candidate != "candidate:9 1 udp 16777215 198.51.100.7 3478 typ relay" ||
		got.Candidate.SDPMid == nil || *got.Candidate.SDPMid != "0" {
		t.Fatalf("candidate notice = %#v", got)
	}

	done := localICECandidateNotice("desk-1", "4", desktop.LocalICECandidate{Seq: 3, Complete: true})
	if !done.Complete || done.Candidate != nil || done.Seq != 3 {
		t.Fatalf("completion notice = %#v", done)
	}
}

func TestHelperAddRemoteICECandidateValidates(t *testing.T) {
	h := newHelperDesktopManager("")
	good := ipc.ICECandidate{Candidate: "candidate:1 1 udp 1 203.0.113.9 9 typ relay"}

	if err := h.addRemoteICECandidate(ipc.DesktopRemoteICECandidate{SessionID: "bad id!", Candidate: good}); err == nil {
		t.Fatal("an invalid session id must be refused")
	}
	if err := h.addRemoteICECandidate(ipc.DesktopRemoteICECandidate{SessionID: "desk-1", Candidate: ipc.ICECandidate{}}); err == nil {
		t.Fatal("an empty candidate must be refused")
	}
	if err := h.addRemoteICECandidate(ipc.DesktopRemoteICECandidate{SessionID: "desk-1", Candidate: good}); !errors.Is(err, desktop.ErrNoICESession) {
		t.Fatalf("a candidate for a session this helper does not host must be refused, got %v", err)
	}
}

func TestHelperBeginICETrickleValidates(t *testing.T) {
	h := newHelperDesktopManager("")
	if err := h.beginICETrickle(ipc.DesktopICETrickleBegin{SessionID: "bad id!"}); err == nil {
		t.Fatal("an invalid session id must be refused")
	}
	if err := h.beginICETrickle(ipc.DesktopICETrickleBegin{SessionID: "desk-1"}); err == nil {
		t.Fatal("beginning a session this helper does not host must report it")
	}
}

func TestWireDesktopICETrickleSendsLocalCandidatesToTheService(t *testing.T) {
	client, peer, cleanup := createClientPipe(t)
	defer cleanup()
	client.wireDesktopICETrickle()
	if client.desktopMgr.mgr.OnLocalICECandidate == nil {
		t.Fatal("the helper must register an emitter for late local candidates")
	}

	go client.desktopMgr.mgr.OnLocalICECandidate("desk-wire", "6", desktop.LocalICECandidate{Seq: 1, Complete: true})

	_ = peer.SetReadDeadline(time.Now().Add(2 * time.Second))
	env, err := peer.Recv()
	if err != nil {
		t.Fatalf("Recv: %v", err)
	}
	if env.Type != ipc.TypeDesktopLocalICECandidate {
		t.Fatalf("type = %q, want %q", env.Type, ipc.TypeDesktopLocalICECandidate)
	}
	var got ipc.DesktopLocalICECandidate
	if err := json.Unmarshal(env.Payload, &got); err != nil {
		t.Fatal(err)
	}
	if got.SessionID != "desk-wire" || got.StartGeneration != "6" || got.Seq != 1 || !got.Complete {
		t.Fatalf("notice = %#v", got)
	}
}
