package websocket

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
)

// #9182: trickle ICE between the agent and the viewer rides the agent socket.

func strPtr(s string) *string { return &s }
func u16Ptr(v uint16) *uint16 { return &v }

func TestSendDesktopICECandidate_SendsFrameWhenServerAdvertisesCapability(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)
	c.setServerCapabilities(map[string]bool{DesktopICETrickleCapability: true})

	cand := &DesktopICECandidate{Candidate: "candidate:9 1 udp 16777215 198.51.100.7 3478 typ relay", SDPMid: strPtr("0"), SDPMLineIndex: u16Ptr(0)}
	if err := c.SendDesktopICECandidate("sess-1", "42", 3, cand); err != nil {
		t.Fatalf("SendDesktopICECandidate error: %v", err)
	}
	select {
	case data := <-c.sendChan:
		var parsed map[string]any
		if err := json.Unmarshal(data, &parsed); err != nil {
			t.Fatal(err)
		}
		want := map[string]any{
			"type":            "desktop_ice_candidate",
			"sessionId":       "sess-1",
			"startGeneration": "42",
			"seq":             float64(3),
			"candidate": map[string]any{
				"candidate":     "candidate:9 1 udp 16777215 198.51.100.7 3478 typ relay",
				"sdpMid":        "0",
				"sdpMLineIndex": float64(0),
			},
		}
		if !reflect.DeepEqual(parsed, want) {
			t.Fatalf("frame = %v, want %v", parsed, want)
		}
	default:
		t.Fatal("expected a frame in sendChan")
	}
}

func TestSendDesktopICECandidate_CompletionMarker(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)
	c.setServerCapabilities(map[string]bool{DesktopICETrickleCapability: true})

	if err := c.SendDesktopICECandidate("sess-1", "42", 4, nil); err != nil {
		t.Fatal(err)
	}
	data := <-c.sendChan
	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed["complete"] != true || parsed["candidate"] != nil || parsed["seq"] != float64(4) {
		t.Fatalf("completion frame = %v", parsed)
	}
}

// An older API answers an unknown frame type with an INVALID_MESSAGE error.
func TestSendDesktopICECandidate_SilentWithoutCapability(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)
	c.setServerCapabilities(map[string]bool{CommandProgressCapability: true})

	err := c.SendDesktopICECandidate("sess-1", "42", 0, &DesktopICECandidate{Candidate: "candidate:x"})
	if !errors.Is(err, ErrServerLacksCapability) {
		t.Fatalf("err = %v, want ErrServerLacksCapability", err)
	}
	select {
	case data := <-c.sendChan:
		t.Fatalf("expected no frame, got %s", data)
	default:
	}
}

func TestSendDesktopICECandidate_ChannelFullDropsInsteadOfBlocking(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)
	c.setServerCapabilities(map[string]bool{DesktopICETrickleCapability: true})
	for i := 0; i < cap(c.sendChan); i++ {
		c.sendChan <- []byte("filler")
	}
	if err := c.SendDesktopICECandidate("sess-1", "42", 0, &DesktopICECandidate{Candidate: "candidate:x"}); err == nil {
		t.Fatal("a full send channel must drop with an error, not block")
	}
}

func TestHandleDesktopICECandidateMessage_DeliversViewerCandidate(t *testing.T) {
	var got DesktopICECandidateMessage
	calls := 0
	c := &Client{OnDesktopICECandidate: func(m DesktopICECandidateMessage) { calls++; got = m }}

	raw, _ := json.Marshal(map[string]any{
		"type":            "desktop_ice_candidate",
		"sessionId":       "sess-1",
		"startGeneration": "9007199254740993",
		"candidate": map[string]any{
			"candidate":        "candidate:1 1 udp 1 203.0.113.9 9 typ relay",
			"sdpMid":           "0",
			"sdpMLineIndex":    0,
			"usernameFragment": "abcd",
		},
	})
	c.handleDesktopICECandidateMessage(raw)

	if calls != 1 {
		t.Fatalf("hook called %d times", calls)
	}
	if got.SessionID != "sess-1" || got.StartGeneration != "9007199254740993" {
		t.Fatalf("unexpected message: %#v", got)
	}
	if got.Candidate.Candidate != "candidate:1 1 udp 1 203.0.113.9 9 typ relay" ||
		got.Candidate.SDPMid == nil || *got.Candidate.SDPMid != "0" ||
		got.Candidate.SDPMLineIndex == nil || *got.Candidate.SDPMLineIndex != 0 ||
		got.Candidate.UsernameFragment == nil || *got.Candidate.UsernameFragment != "abcd" {
		t.Fatalf("candidate not carried: %#v", got.Candidate)
	}
}

func TestHandleDesktopICECandidateMessage_DropsMalformed(t *testing.T) {
	calls := 0
	c := &Client{OnDesktopICECandidate: func(DesktopICECandidateMessage) { calls++ }}
	for _, raw := range []string{
		`{"type":"desktop_ice_candidate"}`,
		`{"type":"desktop_ice_candidate","sessionId":"s","candidate":{"candidate":""}}`,
		`{"type":"desktop_ice_candidate","sessionId":"s","candidate":"nope"}`,
	} {
		c.handleDesktopICECandidateMessage([]byte(raw))
	}
	if calls != 0 {
		t.Fatalf("malformed frames must be dropped, hook called %d times", calls)
	}
}
