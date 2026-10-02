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
	session, _, closeFn := recordingDesktopHelper(t, sessionID, "2", "1000")
	return session, closeFn
}

// recordingDesktopHelper is answeringDesktopHelper in a given Windows session
// and identity, which also answers desktop_stop and reports every message
// type it receives.
func recordingDesktopHelper(t *testing.T, sessionID, winSession, identity string) (*sessionbroker.Session, <-chan string, func()) {
	t.Helper()
	serverConn, clientConn := createTestSocketPair(t)
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)
	session := sessionbroker.NewSession(serverIPC, 1000, identity, "alice", "quartz", "helper-desktop-"+sessionID, []string{"desktop"})
	session.WinSessionID = winSession
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})
	received := make(chan string, 16)
	go func() {
		_ = clientIPC.SetReadDeadline(time.Now().Add(10 * time.Second))
		for {
			env, err := clientIPC.Recv()
			if err != nil {
				return
			}
			select {
			case received <- env.Type:
			default:
			}
			switch env.Type {
			case ipc.TypeDesktopStart:
				payload, _ := json.Marshal(ipc.DesktopStartResponse{SessionID: sessionID, Answer: "answer-sdp"})
				_ = clientIPC.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeDesktopStart, Payload: payload})
			case ipc.TypeDesktopStop:
				_ = clientIPC.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeDesktopStop, Payload: json.RawMessage(`{}`)})
			}
		}
	}()
	return session, received, func() {
		_ = session.Close()
		_ = clientIPC.Close()
	}
}

// sawType reports whether typ arrives on received within the timeout.
func sawType(received <-chan string, typ string, within time.Duration) bool {
	deadline := time.After(within)
	for {
		select {
		case got := <-received:
			if got == typ {
				return true
			}
		case <-deadline:
			return false
		}
	}
}

// grantingConsentHelper is a v2 consent helper in Windows session "2" that
// confirms and grants the prompt.
func grantingConsentHelper(t *testing.T, name string) *consentTestHelper {
	t.Helper()
	c := newConsentTestHelper(t, name, []string{ipc.ScopeConsentUI}, ipc.ConsentProtocolVersion)
	go func() {
		if env, req := c.recvRequest(t); env != nil {
			c.ack(t, env.ID, req.Nonce)
			c.result(t, env.ID, ipc.ConsentResult{Nonce: req.Nonce, Outcome: ipc.ConsentOutcomeGranted})
		}
	}()
	return c
}

// withConsentHostOS makes the consent binding rules behave as on goos.
func withConsentHostOS(t *testing.T, goos string) {
	t.Helper()
	prev := consentHostOS
	consentHostOS = goos
	t.Cleanup(func() { consentHostOS = prev })
}

// Consent binds to the desktop of the user who answered. When the capture
// helper that started is in another session (Windows) or another user's
// (macOS), the start is torn down — the capture helper is told to stop — and
// refused, instead of the answer being released.
func TestHandleStartDesktopConsentCaptureInAnotherSessionTearsDown(t *testing.T) {
	if runtime.GOOS == "linux" {
		t.Skip("handleStartDesktop never takes the helper start path on linux")
	}
	for _, goos := range []string{"windows", "darwin"} {
		t.Run(goos, func(t *testing.T) {
			withConsentSeams(t, occupancyOccupied, true)
			withConsentHostOS(t, goos)
			sessionID := "sess-binding-mismatch-" + goos
			// The consenting helper is session "2", identity "1000".
			c := grantingConsentHelper(t, "helper-consent-mismatch-"+goos)
			capture, received, closeCapture := recordingDesktopHelper(t, sessionID, "5", "2000")
			defer closeCapture()

			h := &Heartbeat{
				isService:     true,
				sessionBroker: newTestBrokerWithSessions(t, c.session, capture),
				desktopMgr:    desktop.NewSessionManager(),
				helperFinder:  func(string) *sessionbroker.Session { return capture },
			}

			result := handleStartDesktop(h, startDesktopCmd(sessionID, consentModePrompt("block", 5000)))
			assertConsentDenied(t, result, "no_user")
			if payload := consentPayloadOf(t, result); payload["consentDetail"] != "capture_target_changed" {
				t.Fatalf("detail = %v, want capture_target_changed", payload["consentDetail"])
			}
			if !sawType(received, ipc.TypeDesktopStop, 3*time.Second) {
				t.Fatal("the started capture must be told to stop")
			}
		})
	}
}

// The matching case: capture in the consenting user's session is released.
func TestHandleStartDesktopConsentCaptureInConsentingSessionProceeds(t *testing.T) {
	if runtime.GOOS == "linux" {
		t.Skip("handleStartDesktop never takes the helper start path on linux")
	}
	for _, goos := range []string{"windows", "darwin"} {
		t.Run(goos, func(t *testing.T) {
			withConsentSeams(t, occupancyOccupied, true)
			withConsentHostOS(t, goos)
			sessionID := "sess-binding-match-" + goos
			c := grantingConsentHelper(t, "helper-consent-match-"+goos)
			capture, received, closeCapture := recordingDesktopHelper(t, sessionID, "2", "1000")
			defer closeCapture()

			h := &Heartbeat{
				isService:     true,
				sessionBroker: newTestBrokerWithSessions(t, c.session, capture),
				desktopMgr:    desktop.NewSessionManager(),
				helperFinder:  func(string) *sessionbroker.Session { return capture },
			}

			result := handleStartDesktop(h, startDesktopCmd(sessionID, consentModePrompt("block", 5000)))
			payload := consentPayloadOf(t, result)
			if payload["consentReason"] != "user" || payload["consentOutcome"] != "granted" {
				t.Fatalf("marker = %+v, want user/granted", payload)
			}
			if sawType(received, ipc.TypeDesktopStop, 300*time.Millisecond) {
				t.Fatal("a capture in the consenting session must not be stopped")
			}
		})
	}
}

// An untargeted Windows start is pinned to the consenting user's session: the
// capture helper is looked up for that session, not picked by the machine-wide
// preference.
func TestHandleStartDesktopConsentPinsUntargetedWindowsCapture(t *testing.T) {
	if runtime.GOOS == "linux" {
		t.Skip("handleStartDesktop never takes the helper start path on linux")
	}
	withConsentSeams(t, occupancyOccupied, true)
	withConsentHostOS(t, "windows")
	const sessionID = "sess-pinned"
	c := grantingConsentHelper(t, "helper-consent-pinned")
	capture, _, closeCapture := recordingDesktopHelper(t, sessionID, "2", "1000")
	defer closeCapture()

	var asked []string
	h := &Heartbeat{
		isService:     true,
		sessionBroker: newTestBrokerWithSessions(t, c.session, capture),
		desktopMgr:    desktop.NewSessionManager(),
		helperFinder: func(target string) *sessionbroker.Session {
			asked = append(asked, target)
			return capture
		},
	}

	result := handleStartDesktop(h, startDesktopCmd(sessionID, consentModePrompt("block", 5000)))
	if payload := consentPayloadOf(t, result); payload["consentReason"] != "user" || payload["event"] == "consent_denied" {
		t.Fatalf("expected a granted start, got %+v", payload)
	}
	if len(asked) == 0 || asked[0] != "2" {
		t.Fatalf("capture helper looked up for %v, want the consenting session \"2\"", asked)
	}
}

// "Nobody is signed in" must still be true when capture is up: a user who
// signs in meanwhile gets the start torn down.
func TestHandleStartDesktopNoUserSessionRechecksOccupancy(t *testing.T) {
	if runtime.GOOS == "linux" {
		t.Skip("handleStartDesktop never takes the helper start path on linux")
	}
	withConsentSeams(t, occupancyUnoccupied, true)
	const sessionID = "sess-user-signed-in"
	capture, received, closeCapture := recordingDesktopHelper(t, sessionID, "2", "1000")
	defer closeCapture()

	h := &Heartbeat{
		isService:     true,
		sessionBroker: newTestBrokerWithSessions(t, capture),
		desktopMgr:    desktop.NewSessionManager(),
		helperFinder: func(string) *sessionbroker.Session {
			// Someone signs in while the capture helper comes up.
			consentOccupancyFn = func(string) string { return occupancyOccupied }
			return capture
		},
	}

	result := handleStartDesktop(h, startDesktopCmd(sessionID, consentModePrompt("proceed", 5000)))
	assertConsentDenied(t, result, "no_user")
	if payload := consentPayloadOf(t, result); payload["consentDetail"] != "user_signed_in" {
		t.Fatalf("detail = %v, want user_signed_in", payload["consentDetail"])
	}
	if !sawType(received, ipc.TypeDesktopStop, 3*time.Second) {
		t.Fatal("the started capture must be told to stop")
	}
}

// End-to-end through handleStartDesktop on the helper path: no consent-capable
// helper is connected, nobody is signed in to the captured session, the policy
// says proceed, and the start completes. The marker says no_user_session —
// never user.
func TestHandleStartDesktopConsentProceedReportsNoUserSession(t *testing.T) {
	if runtime.GOOS == "linux" {
		t.Skip("handleStartDesktop never takes the helper start path on linux")
	}
	withConsentSeams(t, occupancyUnoccupied, true)
	const sessionID = "sess-6819-no-user-session"
	helper, closeHelper := answeringDesktopHelper(t, sessionID)
	defer closeHelper()

	h := &Heartbeat{
		isService:     true,
		sessionBroker: newTestBrokerWithSessions(t), // no consent_ui helper
		desktopMgr:    desktop.NewSessionManager(),
		helperFinder:  func(string) *sessionbroker.Session { return helper },
	}

	result := handleStartDesktop(h, startDesktopCmd(sessionID, consentModePrompt("proceed", 5000)))
	payload := consentPayloadOf(t, result)
	if payload["consentReason"] != "no_user_session" || payload["consentOutcome"] != "unavailable" ||
		payload["consentOccupancy"] != "unoccupied" || payload["consentProtocol"] != float64(ipc.ConsentProtocolVersion) {
		t.Fatalf("marker = %+v, want no_user_session/unavailable/unoccupied/v2", payload)
	}
}

// The owner-fixed rule: when someone is signed in to the captured session and
// the prompt cannot be shown to them, the start is refused even though the
// policy says proceed.
func TestHandleStartDesktopConsentRefusesSignedInUserWhoCannotBeAsked(t *testing.T) {
	for _, occ := range []string{occupancyOccupied, occupancyUnknown} {
		t.Run(occ, func(t *testing.T) {
			withConsentSeams(t, occ, true)
			h := &Heartbeat{
				isService:     true,
				sessionBroker: newTestBrokerWithSessions(t),
				desktopMgr:    desktop.NewSessionManager(),
				helperFinder: func(string) *sessionbroker.Session {
					t.Fatal("capture must not start when the gate refuses")
					return nil
				},
			}
			result := handleStartDesktop(h, startDesktopCmd("sess-signed-in-"+occ, consentModePrompt("proceed", 5000)))
			assertConsentDenied(t, result, "helper_unreachable")
		})
	}
}

// A consent helper that confirms the prompt and reports its countdown ran out
// under proceed: the start completes with reason timeout.
func TestHandleStartDesktopConsentProceedReportsTimeout(t *testing.T) {
	if runtime.GOOS == "linux" {
		t.Skip("handleStartDesktop never takes the helper start path on linux")
	}
	withConsentSeams(t, occupancyOccupied, true)
	const sessionID = "sess-6819-timeout"
	helper, closeHelper := answeringDesktopHelper(t, sessionID)
	defer closeHelper()

	c := newConsentTestHelper(t, "helper-consent-6819", []string{ipc.ScopeConsentUI}, ipc.ConsentProtocolVersion)
	go func() {
		if env, req := c.recvRequest(t); env != nil {
			c.ack(t, env.ID, req.Nonce)
			c.result(t, env.ID, ipc.ConsentResult{Nonce: req.Nonce, Outcome: ipc.ConsentOutcomePresentedExpired})
		}
	}()

	h := &Heartbeat{
		isService:     true,
		sessionBroker: newTestBrokerWithSessions(t, c.session),
		desktopMgr:    desktop.NewSessionManager(),
		helperFinder:  func(string) *sessionbroker.Session { return helper },
	}

	h.sessionBroker = newTestBrokerWithSessions(t, c.session, helper)
	result := handleStartDesktop(h, startDesktopCmd(sessionID, consentModePrompt("proceed", 100)))
	payload := consentPayloadOf(t, result)
	if payload["consentReason"] != "timeout" || payload["consentOutcome"] != "presented_expired" {
		t.Fatalf("marker = %+v, want timeout/presented_expired", payload)
	}
}

// Consent binds to the logon that gave it: if the consenting helper is gone by
// the time capture is up, the start is torn down instead of released.
func TestHandleStartDesktopConsentBindingLostTearsDown(t *testing.T) {
	if runtime.GOOS == "linux" {
		t.Skip("handleStartDesktop never takes the helper start path on linux")
	}
	withConsentSeams(t, occupancyOccupied, true)
	const sessionID = "sess-binding-lost"
	helper, received, closeHelper := recordingDesktopHelper(t, sessionID, "2", "1000")
	defer closeHelper()

	c := newConsentTestHelper(t, "helper-consent-binding", []string{ipc.ScopeConsentUI}, ipc.ConsentProtocolVersion)
	go func() {
		if env, req := c.recvRequest(t); env != nil {
			c.ack(t, env.ID, req.Nonce)
			c.result(t, env.ID, ipc.ConsentResult{Nonce: req.Nonce, Outcome: ipc.ConsentOutcomeGranted})
		}
	}()

	h := &Heartbeat{
		isService:     true,
		sessionBroker: newTestBrokerWithSessions(t, c.session, helper),
		desktopMgr:    desktop.NewSessionManager(),
		helperFinder: func(string) *sessionbroker.Session {
			// The user signs out between answering and capture starting.
			_ = c.session.Close()
			return helper
		},
	}

	result := handleStartDesktop(h, startDesktopCmd(sessionID, consentModePrompt("block", 5000)))
	assertConsentDenied(t, result, "no_user")
	if payload := consentPayloadOf(t, result); payload["consentDetail"] != "consent_helper_gone" {
		t.Fatalf("detail = %v, want consent_helper_gone", payload["consentDetail"])
	}
	if !sawType(received, ipc.TypeDesktopStop, 3*time.Second) {
		t.Fatal("the started capture must be told to stop")
	}
}

// consentPayloadOf decodes a completed start result's JSON payload.
func consentPayloadOf(t *testing.T, result tools.CommandResult) map[string]any {
	t.Helper()
	if result.Status != "completed" {
		t.Fatalf("start did not complete: status=%q error=%q", result.Status, result.Error)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(result.Stdout), &payload); err != nil {
		t.Fatalf("stdout not JSON: %v (%q)", err, result.Stdout)
	}
	return payload
}

// The direct start path (the only one linux takes) carries the gate's marker
// in consent mode and no marker otherwise.
func TestDirectStartResultCarriesDecidedReason(t *testing.T) {
	for _, v := range []consentVerdict{
		{reason: "user", outcome: ipc.ConsentOutcomeGranted},
		{reason: "no_user_session", outcome: ipc.ConsentOutcomeUnavailable, occupancy: occupancyUnoccupied},
		{reason: "timeout", outcome: ipc.ConsentOutcomePresentedExpired},
	} {
		result := directStartResult("s", "a", &ipc.DesktopPrompt{Mode: "consent"}, v, 1)
		var payload map[string]any
		if err := json.Unmarshal([]byte(result.Stdout), &payload); err != nil {
			t.Fatalf("stdout not JSON: %v", err)
		}
		if payload["consentReason"] != v.reason || payload["consentOutcome"] != v.outcome || payload["answer"] != "a" || payload["sessionId"] != "s" {
			t.Fatalf("reason %s: unexpected payload %+v", v.reason, payload)
		}
	}
	for _, prompt := range []*ipc.DesktopPrompt{nil, {Mode: "notify"}} {
		result := directStartResult("s", "a", prompt, consentVerdict{reason: "no_user_session"}, 1)
		var payload map[string]any
		if err := json.Unmarshal([]byte(result.Stdout), &payload); err != nil {
			t.Fatalf("stdout not JSON: %v", err)
		}
		if _, ok := payload["consentReason"]; ok {
			t.Fatalf("non-consent start must carry no marker, got %+v", payload)
		}
		if _, ok := payload["consentOutcome"]; ok {
			t.Fatalf("non-consent start must carry no marker, got %+v", payload)
		}
	}
}

// The marker carries whatever the gate decided; notify mode gets none.
func TestWithConsentGrantedCarriesDecidedReason(t *testing.T) {
	base := tools.NewSuccessResult(map[string]any{"sessionId": "s", "answer": "a"}, 1)
	for _, v := range []consentVerdict{
		{reason: "user", outcome: ipc.ConsentOutcomeGranted},
		{reason: "no_user_session", outcome: ipc.ConsentOutcomeUnavailable, occupancy: occupancyUnoccupied},
		{reason: "timeout", outcome: ipc.ConsentOutcomePresentedExpired},
	} {
		annotated := withConsentGranted(base, &ipc.DesktopPrompt{Mode: "consent"}, v)
		var payload map[string]any
		if err := json.Unmarshal([]byte(annotated.Stdout), &payload); err != nil {
			t.Fatalf("stdout not JSON: %v", err)
		}
		if payload["consentReason"] != v.reason || payload["consentOutcome"] != v.outcome {
			t.Fatalf("marker = %+v, want %s/%s", payload, v.reason, v.outcome)
		}
	}
	if got := withConsentGranted(base, &ipc.DesktopPrompt{Mode: "notify"}, consentVerdict{reason: "user"}); got.Stdout != base.Stdout {
		t.Fatalf("notify mode must not be annotated: %s", got.Stdout)
	}
}
