package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/desktop"
)

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
