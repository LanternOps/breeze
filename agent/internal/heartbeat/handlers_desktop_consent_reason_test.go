package heartbeat

import (
	"encoding/json"
	"runtime"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// #6819: a consent-mode start that proceeds only because consent could not be
// solicited (no consent helper, or the prompt went unanswered) under
// consentUnavailableBehavior "proceed" must report that real reason — the API
// audits consentReason "user" as the end user granting the session.

// answeringDesktopHelper returns a desktop-capable helper session that answers
// desktop_start with an SDP answer, and a func that closes both ends.
func answeringDesktopHelper(t *testing.T, sessionID string) (*sessionbroker.Session, func()) {
	t.Helper()
	serverConn, clientConn := createTestSocketPair(t)
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)
	session := sessionbroker.NewSession(serverIPC, 1000, "1000", "alice", "quartz", "helper-desktop-"+sessionID, []string{"desktop"})
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})
	go func() {
		clientIPC.SetReadDeadline(time.Now().Add(5 * time.Second))
		for {
			env, err := clientIPC.Recv()
			if err != nil {
				return
			}
			if env.Type != ipc.TypeDesktopStart {
				continue
			}
			payload, _ := json.Marshal(ipc.DesktopStartResponse{SessionID: sessionID, Answer: "answer-sdp"})
			_ = clientIPC.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeDesktopStart, Payload: payload})
		}
	}()
	return session, func() {
		_ = session.Close()
		_ = clientIPC.Close()
	}
}

func consentReasonOf(t *testing.T, result tools.CommandResult) any {
	t.Helper()
	if result.Status != "completed" {
		t.Fatalf("start did not complete: status=%q error=%q", result.Status, result.Error)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(result.Stdout), &payload); err != nil {
		t.Fatalf("stdout not JSON: %v (%q)", err, result.Stdout)
	}
	if payload["event"] == "consent_denied" {
		t.Fatalf("expected the start to proceed, got consent_denied (reason=%v)", payload["reason"])
	}
	return payload["consentReason"]
}

// End-to-end through handleStartDesktop on the helper path: no consent-capable
// helper is connected, the policy says proceed, and the start completes. The
// marker must say helper_absent, never user.
func TestHandleStartDesktopConsentProceedReportsHelperAbsent(t *testing.T) {
	if runtime.GOOS == "linux" {
		t.Skip("handleStartDesktop never takes the helper start path on linux")
	}
	const sessionID = "sess-6819-helper-absent"
	helper, closeHelper := answeringDesktopHelper(t, sessionID)
	defer closeHelper()

	h := &Heartbeat{
		isService:     true,
		sessionBroker: newTestBrokerWithSessions(t), // no consent_ui helper
		desktopMgr:    desktop.NewSessionManager(),
		helperFinder:  func(string) *sessionbroker.Session { return helper },
	}

	result := handleStartDesktop(h, startDesktopCmd(sessionID, consentModePrompt("proceed", 5000)))
	if got := consentReasonOf(t, result); got != "helper_absent" {
		t.Fatalf("consentReason = %v, want helper_absent", got)
	}
}

// Same, with a consent helper connected whose consent round-trip fails: the
// gate reports a timeout and the proceed fallback lets the start through.
func TestHandleStartDesktopConsentProceedReportsTimeout(t *testing.T) {
	if runtime.GOOS == "linux" {
		t.Skip("handleStartDesktop never takes the helper start path on linux")
	}
	const sessionID = "sess-6819-timeout"
	helper, closeHelper := answeringDesktopHelper(t, sessionID)
	defer closeHelper()

	serverConn, clientConn := createTestSocketPair(t)
	consentHelper := sessionbroker.NewSession(ipc.NewConn(serverConn), 1000, "1000", "alice", "quartz", "helper-consent-6819", []string{"consent_ui"})
	go consentHelper.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})
	// IPC failure on the consent round-trip = (verdict "", present, timedOut).
	_ = ipc.NewConn(clientConn).Close()
	defer consentHelper.Close()

	h := &Heartbeat{
		isService:     true,
		sessionBroker: newTestBrokerWithSessions(t, consentHelper),
		desktopMgr:    desktop.NewSessionManager(),
		helperFinder:  func(string) *sessionbroker.Session { return helper },
	}

	result := handleStartDesktop(h, startDesktopCmd(sessionID, consentModePrompt("proceed", 100)))
	if got := consentReasonOf(t, result); got != "timeout" {
		t.Fatalf("consentReason = %v, want timeout", got)
	}
}

// The direct start path (the only one linux takes) carries the gate's reason
// in consent mode and no marker otherwise.
func TestDirectStartResultCarriesDecidedReason(t *testing.T) {
	for _, reason := range []string{"user", "helper_absent", "timeout"} {
		result := directStartResult("s", "a", &ipc.DesktopPrompt{Mode: "consent"}, reason, 1)
		var payload map[string]any
		if err := json.Unmarshal([]byte(result.Stdout), &payload); err != nil {
			t.Fatalf("stdout not JSON: %v", err)
		}
		if payload["consentReason"] != reason || payload["answer"] != "a" || payload["sessionId"] != "s" {
			t.Fatalf("reason %s: unexpected payload %+v", reason, payload)
		}
	}
	for _, prompt := range []*ipc.DesktopPrompt{nil, {Mode: "notify"}} {
		result := directStartResult("s", "a", prompt, "helper_absent", 1)
		var payload map[string]any
		if err := json.Unmarshal([]byte(result.Stdout), &payload); err != nil {
			t.Fatalf("stdout not JSON: %v", err)
		}
		if _, ok := payload["consentReason"]; ok {
			t.Fatalf("non-consent start must carry no marker, got %+v", payload)
		}
	}
}

// The marker carries whatever reason the gate decided; notify mode gets none.
func TestWithConsentGrantedCarriesDecidedReason(t *testing.T) {
	base := tools.NewSuccessResult(map[string]any{"sessionId": "s", "answer": "a"}, 1)
	for _, reason := range []string{"user", "helper_absent", "timeout"} {
		annotated := withConsentGranted(base, &ipc.DesktopPrompt{Mode: "consent"}, reason)
		var payload map[string]any
		if err := json.Unmarshal([]byte(annotated.Stdout), &payload); err != nil {
			t.Fatalf("stdout not JSON: %v", err)
		}
		if payload["consentReason"] != reason {
			t.Fatalf("consentReason = %v, want %s", payload["consentReason"], reason)
		}
	}
	if got := withConsentGranted(base, &ipc.DesktopPrompt{Mode: "notify"}, "helper_absent"); got.Stdout != base.Stdout {
		t.Fatalf("notify mode must not be annotated: %s", got.Stdout)
	}
}
