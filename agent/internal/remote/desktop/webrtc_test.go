package desktop

import (
	"testing"
	"time"

	"github.com/pion/webrtc/v3"
)

func TestParseICEServers_Default(t *testing.T) {
	got := parseICEServers(nil)
	if len(got) != 1 {
		t.Fatalf("expected 1 default server, got %d", len(got))
	}
	if len(got[0].URLs) != 1 || got[0].URLs[0] != "stun:stun.l.google.com:19302" {
		t.Fatalf("unexpected default URLs: %#v", got[0].URLs)
	}
}

func TestParseICEServers_StringURLs(t *testing.T) {
	raw := []ICEServerConfig{{URLs: "stun:example.com:3478"}}
	got := parseICEServers(raw)
	if len(got) != 1 {
		t.Fatalf("expected 1 server, got %d", len(got))
	}
	if len(got[0].URLs) != 1 || got[0].URLs[0] != "stun:example.com:3478" {
		t.Fatalf("unexpected URLs: %#v", got[0].URLs)
	}
}

func TestParseICEServers_ListURLs(t *testing.T) {
	raw := []ICEServerConfig{{URLs: []string{"stun:a", "turn:b"}}}
	got := parseICEServers(raw)
	if len(got) != 1 {
		t.Fatalf("expected 1 server, got %d", len(got))
	}
	if len(got[0].URLs) != 2 || got[0].URLs[0] != "stun:a" || got[0].URLs[1] != "turn:b" {
		t.Fatalf("unexpected URLs: %#v", got[0].URLs)
	}
}

func TestParseICEServers_InterfaceURLs(t *testing.T) {
	raw := []ICEServerConfig{{URLs: []interface{}{"stun:a", 123, "stun:b"}}}
	got := parseICEServers(raw)
	if len(got) != 1 {
		t.Fatalf("expected 1 server, got %d", len(got))
	}
	if len(got[0].URLs) != 2 || got[0].URLs[0] != "stun:a" || got[0].URLs[1] != "stun:b" {
		t.Fatalf("unexpected URLs: %#v", got[0].URLs)
	}
}

func TestParseICEServers_Auth(t *testing.T) {
	raw := []ICEServerConfig{{
		URLs:       "turn:example.com:3478",
		Username:   "user",
		Credential: "pass",
	}}
	got := parseICEServers(raw)
	if len(got) != 1 {
		t.Fatalf("expected 1 server, got %d", len(got))
	}
	if got[0].Username != "user" || got[0].Credential != "pass" {
		t.Fatalf("unexpected auth: username=%q credential=%#v", got[0].Username, got[0].Credential)
	}
	if got[0].CredentialType != webrtc.ICECredentialTypePassword {
		t.Fatalf("unexpected credential type: %v", got[0].CredentialType)
	}
}

func TestExtractRemoteInboundVideoStats(t *testing.T) {
	report := webrtc.StatsReport{
		"audio": webrtc.RemoteInboundRTPStreamStats{
			ID:              "audio",
			Type:            webrtc.StatsTypeRemoteInboundRTP,
			Kind:            "audio",
			PacketsReceived: 100,
			RoundTripTime:   0.020,
			FractionLost:    0.01,
		},
		"video1": webrtc.RemoteInboundRTPStreamStats{
			ID:              "video1",
			Type:            webrtc.StatsTypeRemoteInboundRTP,
			Kind:            "video",
			PacketsReceived: 10,
			RoundTripTime:   0.100,
			FractionLost:    0.20,
		},
		"video2": webrtc.RemoteInboundRTPStreamStats{
			ID:              "video2",
			Type:            webrtc.StatsTypeRemoteInboundRTP,
			Kind:            "video",
			PacketsReceived: 20,
			RoundTripTime:   0.123,
			FractionLost:    0.05,
		},
	}

	rtt, loss, ok := extractRemoteInboundVideoStats(report)
	if !ok {
		t.Fatalf("expected ok=true")
	}
	if loss != 0.05 {
		t.Fatalf("expected loss=0.05, got %v", loss)
	}
	if rtt != 123*time.Millisecond {
		t.Fatalf("expected rtt=123ms, got %s", rtt)
	}
}
