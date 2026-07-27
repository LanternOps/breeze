package heartbeat

import (
	"encoding/json"
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/desktop"
)

func TestHandleDesktopStreamStopReturnsExactDurableProof(t *testing.T) {
	const (
		sessionID      = "11111111-1111-4111-8111-111111111111"
		finalizationID = "22222222-2222-4222-8222-222222222222"
	)
	manager := desktop.NewWsSessionManager()
	setUnexportedField(t, manager, "sessions", map[string]*desktop.WsStreamSession{
		sessionID: {},
	})
	h := &Heartbeat{wsDesktopMgr: manager}

	result := handleDesktopStreamStop(h, Command{
		ID:   finalizationID,
		Type: "desktop_stream_stop",
		Payload: map[string]any{
			"sessionId":      sessionID,
			"finalizationId": finalizationID,
		},
	})

	if result.Status != "completed" {
		t.Fatalf("expected completed durable stop, got status=%q error=%q", result.Status, result.Error)
	}
	var proof struct {
		SessionID      string `json:"sessionId"`
		FinalizationID string `json:"finalizationId"`
		Outcome        string `json:"outcome"`
	}
	if err := json.Unmarshal([]byte(result.Stdout), &proof); err != nil {
		t.Fatalf("durable stop stdout is not bounded JSON proof: %v", err)
	}
	if proof.SessionID != sessionID || proof.FinalizationID != finalizationID {
		t.Fatalf("proof identity mismatch: %#v", proof)
	}
	if proof.Outcome != "stopped" {
		t.Fatalf("active stream outcome=%q, want stopped", proof.Outcome)
	}

	repeated := handleDesktopStreamStop(h, Command{
		ID:   finalizationID,
		Type: "desktop_stream_stop",
		Payload: map[string]any{
			"sessionId":      sessionID,
			"finalizationId": finalizationID,
		},
	})
	if err := json.Unmarshal([]byte(repeated.Stdout), &proof); err != nil {
		t.Fatalf("repeated durable stop stdout is not JSON: %v", err)
	}
	if proof.Outcome != "already_absent" {
		t.Fatalf("repeated stream outcome=%q, want already_absent", proof.Outcome)
	}
}

func TestHandleDesktopStreamStopExecutesLegacyCommandWithoutDurableProof(t *testing.T) {
	const sessionID = "11111111-1111-4111-8111-111111111111"
	manager := desktop.NewWsSessionManager()
	setUnexportedField(t, manager, "sessions", map[string]*desktop.WsStreamSession{
		sessionID: {},
	})
	h := &Heartbeat{wsDesktopMgr: manager}

	result := handleDesktopStreamStop(h, Command{
		ID:   "legacy-stop",
		Type: "desktop_stream_stop",
		Payload: map[string]any{
			"sessionId": sessionID,
		},
	})

	if result.Status != "completed" {
		t.Fatalf("legacy stop must remain executable during compatibility, got status=%q error=%q", result.Status, result.Error)
	}
	var legacy map[string]any
	if err := json.Unmarshal([]byte(result.Stdout), &legacy); err != nil {
		t.Fatalf("legacy stop stdout is not JSON: %v", err)
	}
	if _, ok := legacy["finalizationId"]; ok {
		t.Fatal("legacy stop must not fabricate an ID-bound durable proof")
	}
	if _, ok := legacy["outcome"]; ok {
		t.Fatal("legacy stop must not report a durable stopped/already_absent outcome")
	}
	if manager.ActiveCount() != 0 {
		t.Fatal("accepted legacy command must still terminate the desktop stream")
	}
}

func TestHandleDesktopStreamStopRejectsInvalidPresentFinalizationIDBeforeStop(t *testing.T) {
	const sessionID = "11111111-1111-4111-8111-111111111111"
	for name, finalizationID := range map[string]any{
		"empty":      "",
		"non-string": float64(7),
		"mismatch":   "33333333-3333-4333-8333-333333333333",
	} {
		t.Run(name, func(t *testing.T) {
			manager := desktop.NewWsSessionManager()
			setUnexportedField(t, manager, "sessions", map[string]*desktop.WsStreamSession{
				sessionID: {},
			})
			h := &Heartbeat{wsDesktopMgr: manager}

			result := handleDesktopStreamStop(h, Command{
				ID:   "22222222-2222-4222-8222-222222222222",
				Type: "desktop_stream_stop",
				Payload: map[string]any{
					"sessionId":      sessionID,
					"finalizationId": finalizationID,
				},
			})

			if result.Status != "failed" {
				t.Fatalf("invalid present finalizationId must fail, got %q", result.Status)
			}
			if manager.ActiveCount() != 1 {
				t.Fatal("invalid ID-bound command mutated the desktop stream")
			}
		})
	}
}

func TestHandleDesktopStreamStopHeadlessStillExecutesBoundStop(t *testing.T) {
	const (
		sessionID      = "11111111-1111-4111-8111-111111111111"
		finalizationID = "22222222-2222-4222-8222-222222222222"
	)
	manager := desktop.NewWsSessionManager()
	setUnexportedField(t, manager, "sessions", map[string]*desktop.WsStreamSession{
		sessionID: {},
	})
	h := &Heartbeat{wsDesktopMgr: manager, isHeadless: true}

	result := handleDesktopStreamStop(h, Command{
		ID:   finalizationID,
		Type: "desktop_stream_stop",
		Payload: map[string]any{
			"sessionId":      sessionID,
			"finalizationId": finalizationID,
		},
	})

	if result.Status != "completed" || manager.ActiveCount() != 0 {
		t.Fatalf("headless bound stop did not execute: status=%q active=%d", result.Status, manager.ActiveCount())
	}
}

// TestHandleStopDesktopStateBasedRoutesDirectSession proves the state-based stop
// routing (Task 11 change #3): a direct (non-owner) session is stopped via
// h.desktopMgr.StopSession even when h.isHeadless is true and an IPC broker is
// present. Under the old flag-gated routing this exact input returned a "failed"
// owner-unavailable error and stranded the live capture. The headless flag is
// deliberately toggled true to prove the routing no longer relies on it.
func TestHandleStopDesktopStateBasedRoutesDirectSession(t *testing.T) {
	const sessionID = "11111111-1111-1111-1111-111111111111"

	mgr := desktop.NewSessionManager()
	// Inject a direct session into the manager. It is never registered in
	// desktopOwners, mimicking a Linux WebRTC session that boots headless.
	setUnexportedField(t, mgr, "sessions", map[string]*desktop.Session{sessionID: {}})

	h := &Heartbeat{
		isHeadless:    true,                         // the flip the fix must ignore
		sessionBroker: newTestBrokerWithSessions(t), // non-nil, but owns no desktop session
		desktopMgr:    mgr,
	}

	res := handleStopDesktop(h, Command{
		ID:      "c1",
		Payload: map[string]any{"sessionId": sessionID},
	})

	if res.Status != "completed" {
		t.Fatalf("expected completed stop for direct session, got status=%q error=%q", res.Status, res.Error)
	}

	// The session must have been removed from the manager, proving StopSession
	// actually ran (not a blind success return).
	sessions, ok := getUnexportedField(t, mgr, "sessions").(map[string]*desktop.Session)
	if !ok {
		t.Fatalf("unexpected sessions field type")
	}
	if _, still := sessions[sessionID]; still {
		t.Fatalf("desktopMgr.StopSession was not invoked; session %q still present", sessionID)
	}
}
