package heartbeat

// Consent gate smoke tests for handleStartDesktop (Task 10), updated for the
// v2 consent exchange (the helper confirms the prompt is on screen, then
// reports one outcome) and the occupancy rule (a prompt that cannot be shown
// follows the policy only when nobody is signed in).
//
// Why some cases go through runConsentGate instead of handleStartDesktop: the
// non-service "allow → proceed" path calls desktopMgr.StartSession, which
// needs a real WebRTC/capture pipeline not available in unit tests.

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// mustString is a convenience pointer helper used to populate DesktopPrompt fields.
func mustString(s string) *string { return &s }

// consentModePrompt returns a minimal DesktopPrompt in "consent" mode.
func consentModePrompt(unavailableBehavior string, timeoutMs int) *ipc.DesktopPrompt {
	return &ipc.DesktopPrompt{
		Mode:                       "consent",
		TechnicianName:             mustString("Test Tech"),
		ConsentUnavailableBehavior: unavailableBehavior,
		ConsentTimeoutMs:           timeoutMs,
	}
}

// startDesktopCmd builds a minimal start_desktop command payload with an
// embedded consent prompt block.
func startDesktopCmd(sessionID string, prompt *ipc.DesktopPrompt) Command {
	// Encode the prompt as a map[string]any so parseDesktopPrompt can decode it.
	raw, _ := json.Marshal(prompt)
	var promptMap map[string]any
	_ = json.Unmarshal(raw, &promptMap)

	return Command{
		ID:   "cmd-consent-" + sessionID,
		Type: tools.CmdStartDesktop,
		Payload: map[string]any{
			"sessionId":       sessionID,
			"offer":           "test-offer",
			"prompt":          promptMap,
			"revocationLease": testRevocationLeasePayload(),
		},
	}
}

// assertConsentDenied asserts that result carries the consent_denied marker.
func assertConsentDenied(t *testing.T, result tools.CommandResult, wantReason string) {
	t.Helper()
	if result.Status != "completed" {
		t.Fatalf("consent_denied result should have status 'completed', got %q (error=%q)", result.Status, result.Error)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(result.Stdout), &payload); err != nil {
		t.Fatalf("could not unmarshal result stdout: %v (stdout=%q)", err, result.Stdout)
	}
	if payload["event"] != "consent_denied" {
		t.Fatalf("result event = %q, want 'consent_denied' (payload=%v)", payload["event"], payload)
	}
	if payload["reason"] != wantReason {
		t.Fatalf("result reason = %q, want %q", payload["reason"], wantReason)
	}
}

// assertNotConsentDenied asserts that the gate passed (the session was NOT
// short-circuited with a consent_denied marker). The result may be failed
// (e.g. desktopMgr.StartSession fails in the test environment) but must not
// carry the consent_denied event.
func assertNotConsentDenied(t *testing.T, result tools.CommandResult) {
	t.Helper()
	if result.Stdout == "" {
		return // failed result with no stdout — gate passed, real path returned an error
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(result.Stdout), &payload); err != nil {
		return // not JSON — not a consent_denied marker
	}
	if payload["event"] == "consent_denied" {
		t.Fatalf("expected session to proceed past consent gate, got consent_denied (reason=%v)", payload["reason"])
	}
}

// TestConsentGate_NoHelper_Block: no helper can show the prompt, nobody is
// signed in, and the policy says block → denied with no_user_session.
func TestConsentGate_NoHelper_Block(t *testing.T) {
	withConsentSeams(t, occupancyUnoccupied, true)
	h := &Heartbeat{
		// No sessionBroker → no helper can show the prompt.
		desktopMgr: desktop.NewSessionManager(),
	}

	result := handleStartDesktop(h, startDesktopCmd("sess-nohelper-block",
		consentModePrompt("block", 5000)))

	assertConsentDenied(t, result, "no_user_session")
}

// TestConsentGate_NoHelper_Proceed: nobody is signed in and the policy says
// proceed → the gate lets the start continue (desktopMgr.StartSession is
// reached; in a unit test it fails, but the result must NOT be consent_denied).
func TestConsentGate_NoHelper_Proceed(t *testing.T) {
	withConsentSeams(t, occupancyUnoccupied, true)
	h := &Heartbeat{
		desktopMgr: desktop.NewSessionManager(),
	}

	result := handleStartDesktop(h, startDesktopCmd("sess-nohelper-proceed",
		consentModePrompt("proceed", 5000)))

	assertNotConsentDenied(t, result)
}

// TestConsentGate_NoHelper_SignedInUserBlocksDespiteProceed is the fail-open
// this protocol closes: a user is signed in, no helper can show them the
// prompt, and "proceed" must NOT start the session.
func TestConsentGate_NoHelper_SignedInUserBlocksDespiteProceed(t *testing.T) {
	withConsentSeams(t, occupancyOccupied, true)
	h := &Heartbeat{desktopMgr: desktop.NewSessionManager()}

	result := handleStartDesktop(h, startDesktopCmd("sess-nohelper-occupied",
		consentModePrompt("proceed", 5000)))

	assertConsentDenied(t, result, "helper_unreachable")
}

// TestConsentGate_UserDenies_EndToEnd verifies that when a helper is connected
// and the user replies "deny", handleStartDesktop returns consent_denied with
// reason "user".
func TestConsentGate_UserDenies_EndToEnd(t *testing.T) {
	withConsentSeams(t, occupancyOccupied, true)
	serverConn, clientConn := createTestSocketPair(t)
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)

	session := sessionbroker.NewSession(serverIPC, 1000, "1000", "alice", "quartz", "helper-deny", []string{"consent_ui"})
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})

	done := make(chan struct{})
	go func() {
		defer close(done)
		clientIPC.SetReadDeadline(time.Now().Add(5 * time.Second))
		env, err := clientIPC.Recv()
		if err != nil {
			t.Errorf("helper recv: %v", err)
			return
		}
		// Verify the incoming envelope is a consent_request.
		if env.Type != ipc.TypeConsentRequest {
			t.Errorf("expected %q envelope, got %q", ipc.TypeConsentRequest, env.Type)
		}
		// Reply with a deny decision.
		result := ipc.ConsentResult{Decision: "deny"}
		payload, _ := json.Marshal(result)
		if err := clientIPC.Send(&ipc.Envelope{
			ID:      env.ID,
			Type:    ipc.TypeConsentResult,
			Payload: payload,
		}); err != nil {
			t.Errorf("helper send: %v", err)
		}
	}()

	broker := newTestBrokerWithSessions(t, session)
	h := &Heartbeat{
		sessionBroker: broker,
		desktopMgr:    desktop.NewSessionManager(),
	}

	result := handleStartDesktop(h, startDesktopCmd("sess-deny", consentModePrompt("block", 5000)))

	<-done
	_ = session.Close()
	_ = clientIPC.Close()

	assertConsentDenied(t, result, "user")
}

// TestConsentGate_LegacyHelperSilence_Blocks: a version 1 Assist that goes
// away (or says nothing) cannot prove its prompt was shown, so even under
// "proceed" the start is refused (reason no_user, outcome unknown) — before v2
// this was reported as a timeout and let through.
func TestConsentGate_LegacyHelperSilence_Blocks(t *testing.T) {
	withConsentSeams(t, occupancyOccupied, true)
	serverConn, clientConn := createTestSocketPair(t)
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)

	session := sessionbroker.NewSession(serverIPC, 1000, "1000", "alice", "quartz", "helper-timeout-block", []string{"consent_ui"})
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})

	// Close the client side immediately — the service sees an IPC error.
	_ = clientIPC.Close()

	broker := newTestBrokerWithSessions(t, session)
	h := &Heartbeat{
		sessionBroker: broker,
		desktopMgr:    desktop.NewSessionManager(),
	}

	result := handleStartDesktop(h, startDesktopCmd("sess-timeout-block", consentModePrompt("proceed", 100)))

	_ = session.Close()

	assertConsentDenied(t, result, "no_user")
}

// TestConsentGate_HelperErrorReply_FailsClosed_Proceed is the regression guard
// for the consent-gate fail-open finding: a PRESENT helper that replies with an
// application-level error envelope (e.g. it could not build/show the dialog)
// yielded no user decision. Even under the "proceed" unavailable-behavior the
// session MUST be denied (reason "no_user") — a broken/garbled helper reply must
// never silently grant a session.
func TestConsentGate_HelperErrorReply_FailsClosed_Proceed(t *testing.T) {
	withConsentSeams(t, occupancyOccupied, true)
	serverConn, clientConn := createTestSocketPair(t)
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)

	session := sessionbroker.NewSession(serverIPC, 1000, "1000", "alice", "quartz", "helper-err", []string{"consent_ui"})
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})

	done := make(chan struct{})
	go func() {
		defer close(done)
		clientIPC.SetReadDeadline(time.Now().Add(5 * time.Second))
		env, err := clientIPC.Recv()
		if err != nil {
			t.Errorf("helper recv: %v", err)
			return
		}
		// Reply with an error envelope and no decision payload — the helper is
		// present and responsive but could not obtain a consent decision.
		if err := clientIPC.Send(&ipc.Envelope{
			ID:    env.ID,
			Type:  ipc.TypeConsentResult,
			Error: "failed to show consent dialog",
		}); err != nil {
			t.Errorf("helper send: %v", err)
		}
	}()

	broker := newTestBrokerWithSessions(t, session)
	h := &Heartbeat{
		sessionBroker: broker,
		desktopMgr:    desktop.NewSessionManager(),
	}

	// "proceed" policy — the fail-closed behavior must override it.
	result := handleStartDesktop(h, startDesktopCmd("sess-err", consentModePrompt("proceed", 5000)))

	<-done
	_ = session.Close()
	_ = clientIPC.Close()

	assertConsentDenied(t, result, "no_user")
}

// TestConsentGate_HelperUndecodablePayload_FailsClosed_Proceed is the sibling
// regression guard to the error-envelope case: a PRESENT helper that replies
// with a payload that does not decode into ipc.ConsentResult (here a JSON array
// instead of the expected object) yielded no usable decision. The gate
// swallows the unmarshal error and leaves the verdict empty, so even under the
// "proceed" unavailable-behavior the session MUST be denied (reason "no_user").
func TestConsentGate_HelperUndecodablePayload_FailsClosed_Proceed(t *testing.T) {
	withConsentSeams(t, occupancyOccupied, true)
	serverConn, clientConn := createTestSocketPair(t)
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)

	session := sessionbroker.NewSession(serverIPC, 1000, "1000", "alice", "quartz", "helper-baddata", []string{"consent_ui"})
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})

	done := make(chan struct{})
	go func() {
		defer close(done)
		clientIPC.SetReadDeadline(time.Now().Add(5 * time.Second))
		env, err := clientIPC.Recv()
		if err != nil {
			t.Errorf("helper recv: %v", err)
			return
		}
		// A JSON array can't unmarshal into the ConsentResult struct, forcing the
		// json.Unmarshal failure branch in the gate.
		if err := clientIPC.Send(&ipc.Envelope{
			ID:      env.ID,
			Type:    ipc.TypeConsentResult,
			Payload: json.RawMessage("[1,2,3]"),
		}); err != nil {
			t.Errorf("helper send: %v", err)
		}
	}()

	broker := newTestBrokerWithSessions(t, session)
	h := &Heartbeat{
		sessionBroker: broker,
		desktopMgr:    desktop.NewSessionManager(),
	}

	result := handleStartDesktop(h, startDesktopCmd("sess-baddata", consentModePrompt("proceed", 5000)))

	<-done
	_ = session.Close()
	_ = clientIPC.Close()

	assertConsentDenied(t, result, "no_user")
}

// TestConsentGate_LegacyAssistAllow: a version 1 Assist click is still a user
// grant.
func TestConsentGate_LegacyAssistAllow(t *testing.T) {
	withConsentSeams(t, occupancyOccupied, true)
	serverConn, clientConn := createTestSocketPair(t)
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)

	session := sessionbroker.NewSession(serverIPC, 1000, "1000", "alice", "quartz", "helper-allow", []string{"consent_ui"})
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})

	done := make(chan struct{})
	go func() {
		defer close(done)
		clientIPC.SetReadDeadline(time.Now().Add(5 * time.Second))
		env, err := clientIPC.Recv()
		if err != nil {
			t.Errorf("helper recv: %v", err)
			return
		}
		payload, _ := json.Marshal(ipc.ConsentResult{Decision: "allow"})
		if err := clientIPC.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeConsentResult, Payload: payload}); err != nil {
			t.Errorf("helper send: %v", err)
		}
	}()

	h := &Heartbeat{sessionBroker: newTestBrokerWithSessions(t, session)}
	v := h.runConsentGate("sess-allow", consentModePrompt("block", 5000), "")

	<-done
	_ = session.Close()
	_ = clientIPC.Close()

	if !v.proceed || v.reason != "user" || v.outcome != ipc.ConsentOutcomeGranted {
		t.Fatalf("verdict = %+v, want a user grant", v)
	}
}

// TestConsentGate_NonConsentMode_Skips verifies that when the prompt mode is
// NOT "consent" (e.g. "notify"), the consent gate is skipped entirely and the
// session proceeds.
func TestConsentGate_NonConsentMode_Skips(t *testing.T) {
	h := &Heartbeat{
		desktopMgr: desktop.NewSessionManager(),
		// No sessionBroker — if the gate ran, it would block.
	}

	notifyPrompt := &ipc.DesktopPrompt{
		Mode:                       "notify",
		ConsentUnavailableBehavior: "block", // would block if gate ran
	}
	raw, _ := json.Marshal(notifyPrompt)
	var promptMap map[string]any
	_ = json.Unmarshal(raw, &promptMap)

	result := handleStartDesktop(h, Command{
		ID:   "cmd-notify-skip",
		Type: tools.CmdStartDesktop,
		Payload: map[string]any{
			"sessionId":       "sess-notify-skip",
			"offer":           "test-offer",
			"prompt":          promptMap,
			"revocationLease": testRevocationLeasePayload(),
		},
	})

	// The gate must not have fired: we should not see consent_denied.
	assertNotConsentDenied(t, result)
}

// TestConsentGate_NilPrompt_Skips verifies that when no prompt block is
// present in the payload (older API), the consent gate is skipped entirely.
func TestConsentGate_NilPrompt_Skips(t *testing.T) {
	h := &Heartbeat{
		desktopMgr: desktop.NewSessionManager(),
	}

	result := handleStartDesktop(h, Command{
		ID:   "cmd-noprompt",
		Type: tools.CmdStartDesktop,
		Payload: map[string]any{
			"sessionId":       "sess-noprompt",
			"offer":           "test-offer",
			"revocationLease": testRevocationLeasePayload(),
			// No "prompt" key → parseDesktopPrompt returns nil
		},
	})

	assertNotConsentDenied(t, result)
}

// TestConsentGate_ConsentDeniedResult_Shape verifies the consentDeniedResult
// helper produces a well-formed "completed" result with the expected JSON shape.
func TestConsentGate_ConsentDeniedResult_Shape(t *testing.T) {
	result := consentDeniedResult("my-session", consentVerdict{reason: "helper_unreachable", outcome: ipc.ConsentOutcomeUnavailable, occupancy: occupancyOccupied}, 42)
	if result.Status != "completed" {
		t.Fatalf("status = %q, want 'completed'", result.Status)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(result.Stdout), &payload); err != nil {
		t.Fatalf("stdout not JSON: %v (stdout=%q)", err, result.Stdout)
	}
	if payload["event"] != "consent_denied" {
		t.Fatalf("event = %v, want 'consent_denied'", payload["event"])
	}
	if payload["reason"] != "helper_unreachable" || payload["consentOutcome"] != "unavailable" || payload["consentOccupancy"] != "occupied" {
		t.Fatalf("unexpected marker %v", payload)
	}
	if payload["sessionId"] != "my-session" {
		t.Fatalf("sessionId = %v, want 'my-session'", payload["sessionId"])
	}
	if result.DurationMs != 42 {
		t.Fatalf("DurationMs = %d, want 42", result.DurationMs)
	}
}

// TestConsentGate_WithConsentGranted_AddsMarker verifies withConsentGranted
// annotates a completed start result with consentReason="user" in consent mode.
func TestConsentGate_WithConsentGranted_AddsMarker(t *testing.T) {
	prompt := &ipc.DesktopPrompt{Mode: "consent"}
	base := tools.NewSuccessResult(map[string]any{
		"sessionId": "s1",
		"answer":    "sdp-answer",
	}, 10)

	annotated := withConsentGranted(base, prompt, consentVerdict{reason: "user", outcome: ipc.ConsentOutcomeGranted})

	var payload map[string]any
	if err := json.Unmarshal([]byte(annotated.Stdout), &payload); err != nil {
		t.Fatalf("stdout not JSON: %v", err)
	}
	if payload["consentReason"] != "user" {
		t.Fatalf("consentReason = %v, want 'user'", payload["consentReason"])
	}
}

// TestConsentGate_WithConsentGranted_NotifyModeNoMarker verifies that
// withConsentGranted is a no-op in "notify" mode (the marker is only for
// consent mode sessions).
func TestConsentGate_WithConsentGranted_NotifyModeNoMarker(t *testing.T) {
	prompt := &ipc.DesktopPrompt{Mode: "notify"}
	base := tools.NewSuccessResult(map[string]any{"sessionId": "s2", "answer": "sdp"}, 5)

	result := withConsentGranted(base, prompt, consentVerdict{reason: "user", outcome: ipc.ConsentOutcomeGranted})

	if result.Stdout != base.Stdout {
		t.Fatalf("notify mode should not modify the result")
	}
	// Confirm no consentReason injected.
	if strings.Contains(result.Stdout, "consentReason") {
		t.Fatalf("consentReason should not appear in notify-mode result")
	}
}

// TestConsentGate_FallbackScope_EndToEnd: a native user-helper holding ONLY
// the consent_ui_fallback scope and speaking the v2 exchange answers the
// prompt when no assist helper is connected; its grant starts the session.
func TestConsentGate_FallbackScope_EndToEnd(t *testing.T) {
	withConsentSeams(t, occupancyOccupied, true)
	c := newConsentTestHelper(t, "helper-fallback", []string{ipc.ScopeConsentUIFallback}, ipc.ConsentProtocolVersion)

	go func() {
		if env, req := c.recvRequest(t); env != nil {
			c.ack(t, env.ID, req.Nonce)
			c.result(t, env.ID, ipc.ConsentResult{Nonce: req.Nonce, Outcome: ipc.ConsentOutcomeGranted})
		}
	}()

	h := &Heartbeat{sessionBroker: newTestBrokerWithSessions(t, c.session), desktopMgr: desktop.NewSessionManager()}

	result := handleStartDesktop(h, startDesktopCmd("sess-fallback", consentModePrompt("block", 5000)))

	assertNotConsentDenied(t, result)
}

// TestConsentGate_AssistHelperPreferredOverFallback: when BOTH an assist
// helper (consent_ui) and a fallback user-helper (consent_ui_fallback) are
// connected, the consent request goes to the assist helper. The fallback
// client never receives an envelope (its Recv sees only the socket closing).
func TestConsentGate_AssistHelperPreferredOverFallback(t *testing.T) {
	withConsentSeams(t, occupancyOccupied, true)
	assistServer, assistClient := createTestSocketPair(t)
	fallbackServer, fallbackClient := createTestSocketPair(t)
	assistIPC, fallbackIPC := ipc.NewConn(assistServer), ipc.NewConn(fallbackServer)
	assistClientIPC, fallbackClientIPC := ipc.NewConn(assistClient), ipc.NewConn(fallbackClient)

	assistSession := sessionbroker.NewSession(assistIPC, 1000, "1000", "alice", "quartz", "helper-assist", []string{"consent_ui"})
	fallbackSession := sessionbroker.NewSession(fallbackIPC, 1000, "1000", "alice", "quartz", "helper-native", []string{ipc.ScopeConsentUIFallback})
	go assistSession.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})
	go fallbackSession.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})

	fallbackGotEnvelope := make(chan string, 1)
	go func() {
		fallbackClientIPC.SetReadDeadline(time.Now().Add(3 * time.Second))
		if env, err := fallbackClientIPC.Recv(); err == nil {
			fallbackGotEnvelope <- env.Type
		}
		close(fallbackGotEnvelope)
	}()

	done := make(chan struct{})
	go func() {
		defer close(done)
		assistClientIPC.SetReadDeadline(time.Now().Add(5 * time.Second))
		env, err := assistClientIPC.Recv()
		if err != nil {
			t.Errorf("assist helper recv: %v", err)
			return
		}
		if env.Type != ipc.TypeConsentRequest {
			t.Errorf("expected %q envelope, got %q", ipc.TypeConsentRequest, env.Type)
		}
		payload, _ := json.Marshal(ipc.ConsentResult{Decision: "deny"})
		if err := assistClientIPC.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeConsentResult, Payload: payload}); err != nil {
			t.Errorf("assist helper send: %v", err)
		}
	}()

	broker := newTestBrokerWithSessions(t, assistSession, fallbackSession)
	h := &Heartbeat{sessionBroker: broker, desktopMgr: desktop.NewSessionManager()}

	result := handleStartDesktop(h, startDesktopCmd("sess-prefer-assist", consentModePrompt("block", 5000)))

	<-done
	_ = assistSession.Close()
	_ = fallbackSession.Close()
	_ = assistClientIPC.Close()
	_ = fallbackClientIPC.Close()

	assertConsentDenied(t, result, "user")
	if typ, ok := <-fallbackGotEnvelope; ok {
		t.Errorf("fallback helper must not receive envelopes when assist helper is connected, got %q", typ)
	}
}
