package heartbeat

// Consent gate smoke tests for handleStartDesktop (Task 10).
//
// Approach: end-to-end through handleStartDesktop for deny/no-helper cases,
// and through requestConsent (the gate seam) for allow and timeout cases.
//
// Why the split: the non-service "allow → proceed" path calls
// desktopMgr.StartSession which requires a real WebRTC/capture pipeline not
// available in unit tests. For those cases we test requestConsent directly
// (verifying the returned verdict that handleStartDesktop acts on) and also
// verify the gate doesn't short-circuit in handleStartDesktop for the "allow"
// verdict by confirming the result is NOT "consent_denied".
//
// All four branches of the gate are exercised:
//   1. no helper (nil broker, block)  → consent_denied / helper_absent
//   2. no helper (nil broker, proceed)→ gate passes, proceeds to capture (non-denied)
//   3. user allows                     → gate passes (requestConsent), verified via seam
//   4. user denies                     → consent_denied / user (end-to-end)
//   5. timeout + block                 → consent_denied / timeout (end-to-end)
//   6. timeout + proceed               → gate passes (requestConsent), verified via seam

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
			"sessionId": sessionID,
			"offer":     "test-offer",
			"prompt":    promptMap,
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

// TestConsentGate_NoHelper_Block verifies that when no helper is connected
// (nil sessionBroker) and the unavailable-behavior is "block", handleStartDesktop
// returns a consent_denied result with reason helper_absent.
func TestConsentGate_NoHelper_Block(t *testing.T) {
	h := &Heartbeat{
		// No sessionBroker → requestConsent returns ("", false, false)
		desktopMgr: desktop.NewSessionManager(),
	}

	result := handleStartDesktop(h, startDesktopCmd("sess-nohelper-block",
		consentModePrompt("block", 5000)))

	assertConsentDenied(t, result, "helper_absent")
}

// TestConsentGate_NoHelper_Proceed verifies that when no helper is connected
// and the unavailable-behavior is "proceed", the gate allows the session to
// continue (desktopMgr.StartSession is reached; in a unit test it will fail
// because there is no real WebRTC pipeline, but the result must NOT be
// consent_denied).
func TestConsentGate_NoHelper_Proceed(t *testing.T) {
	h := &Heartbeat{
		desktopMgr: desktop.NewSessionManager(),
	}

	result := handleStartDesktop(h, startDesktopCmd("sess-nohelper-proceed",
		consentModePrompt("proceed", 5000)))

	assertNotConsentDenied(t, result)
}

// TestConsentGate_UserDenies_EndToEnd verifies that when a helper is connected
// and the user replies "deny", handleStartDesktop returns consent_denied with
// reason "user".
func TestConsentGate_UserDenies_EndToEnd(t *testing.T) {
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
		desktopMgr:   desktop.NewSessionManager(),
	}

	result := handleStartDesktop(h, startDesktopCmd("sess-deny", consentModePrompt("block", 5000)))

	<-done
	_ = session.Close()
	_ = clientIPC.Close()

	assertConsentDenied(t, result, "user")
}

// TestConsentGate_Timeout_Block verifies that when the helper disconnects
// mid-flight (IPC error) and the unavailable-behavior is "block",
// handleStartDesktop returns consent_denied with reason "timeout".
func TestConsentGate_Timeout_Block(t *testing.T) {
	serverConn, clientConn := createTestSocketPair(t)
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)

	session := sessionbroker.NewSession(serverIPC, 1000, "1000", "alice", "quartz", "helper-timeout-block", []string{"consent_ui"})
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})

	// Close the client side immediately — the service sees an IPC error which
	// requestConsent treats as (verdict="", helperPresent=true, timedOut=true).
	_ = clientIPC.Close()

	broker := newTestBrokerWithSessions(t, session)
	h := &Heartbeat{
		sessionBroker: broker,
		desktopMgr:   desktop.NewSessionManager(),
	}

	// ConsentTimeoutMs must be very short so SendCommand's timeout fires quickly.
	prompt := consentModePrompt("block", 100)
	result := handleStartDesktop(h, startDesktopCmd("sess-timeout-block", prompt))

	_ = session.Close()

	assertConsentDenied(t, result, "timeout")
}

// TestConsentGate_HelperErrorReply_FailsClosed_Proceed is the regression guard
// for the consent-gate fail-open finding: a PRESENT helper that replies with an
// application-level error envelope (e.g. it could not build/show the dialog)
// yielded no user decision. Even under the "proceed" unavailable-behavior the
// session MUST be denied (reason "no_user") — a broken/garbled helper reply must
// never silently grant a session.
func TestConsentGate_HelperErrorReply_FailsClosed_Proceed(t *testing.T) {
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
// instead of the expected object) yielded no usable decision. requestConsent
// swallows the unmarshal error and leaves the verdict empty, so even under the
// "proceed" unavailable-behavior the session MUST be denied (reason "no_user").
func TestConsentGate_HelperUndecodablePayload_FailsClosed_Proceed(t *testing.T) {
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
		// json.Unmarshal failure branch in requestConsent.
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

// TestConsentGate_RequestConsent_Allow verifies that requestConsent returns
// verdict "allow" when the helper responds with an allow decision, and that
// decideConsent maps that to proceed=true. This exercises the seam for the
// allow→proceed branch.
func TestConsentGate_RequestConsent_Allow(t *testing.T) {
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
		result := ipc.ConsentResult{Decision: "allow"}
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
	h := &Heartbeat{sessionBroker: broker}

	prompt := consentModePrompt("block", 5000)
	verdict, helperPresent, timedOut := h.requestConsent("sess-allow", prompt)

	<-done
	_ = session.Close()
	_ = clientIPC.Close()

	if verdict != "allow" {
		t.Fatalf("verdict = %q, want %q", verdict, "allow")
	}
	if !helperPresent {
		t.Fatal("helperPresent should be true")
	}
	if timedOut {
		t.Fatal("timedOut should be false")
	}

	proceed, reason := decideConsent(verdict, helperPresent, timedOut, prompt.ConsentUnavailableBehavior)
	if !proceed {
		t.Fatalf("decideConsent returned proceed=false for allow verdict (reason=%q)", reason)
	}
	if reason != "user" {
		t.Fatalf("decideConsent reason = %q, want %q", reason, "user")
	}
}

// TestConsentGate_RequestConsent_Timeout_Proceed verifies that a timeout with
// unavailableBehavior="proceed" results in proceed=true / reason="timeout".
func TestConsentGate_RequestConsent_Timeout_Proceed(t *testing.T) {
	serverConn, clientConn := createTestSocketPair(t)
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)

	session := sessionbroker.NewSession(serverIPC, 1000, "1000", "alice", "quartz", "helper-timeout-proceed", []string{"consent_ui"})
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})

	// Close the client side immediately to simulate IPC failure / timeout.
	_ = clientIPC.Close()

	broker := newTestBrokerWithSessions(t, session)
	h := &Heartbeat{sessionBroker: broker}

	prompt := consentModePrompt("proceed", 100)
	verdict, helperPresent, timedOut := h.requestConsent("sess-timeout-proceed", prompt)

	_ = session.Close()

	// IPC error → requestConsent returns ("", true, true)
	if verdict != "" {
		t.Fatalf("verdict = %q, want empty string on timeout", verdict)
	}
	if !helperPresent {
		t.Fatal("helperPresent should be true (helper was connected before IPC error)")
	}
	if !timedOut {
		t.Fatal("timedOut should be true on IPC error")
	}

	proceed, reason := decideConsent(verdict, helperPresent, timedOut, prompt.ConsentUnavailableBehavior)
	if !proceed {
		t.Fatalf("decideConsent returned proceed=false for timeout+proceed (reason=%q)", reason)
	}
	if reason != "timeout" {
		t.Fatalf("decideConsent reason = %q, want %q", reason, "timeout")
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
			"sessionId": "sess-notify-skip",
			"offer":     "test-offer",
			"prompt":    promptMap,
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
			"sessionId": "sess-noprompt",
			"offer":     "test-offer",
			// No "prompt" key → parseDesktopPrompt returns nil
		},
	})

	assertNotConsentDenied(t, result)
}

// TestConsentGate_ConsentDeniedResult_Shape verifies the consentDeniedResult
// helper produces a well-formed "completed" result with the expected JSON shape.
func TestConsentGate_ConsentDeniedResult_Shape(t *testing.T) {
	result := consentDeniedResult("my-session", "user", 42)
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
	if payload["reason"] != "user" {
		t.Fatalf("reason = %v, want 'user'", payload["reason"])
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

	annotated := withConsentGranted(base, prompt)

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

	result := withConsentGranted(base, prompt)

	if result.Stdout != base.Stdout {
		t.Fatalf("notify mode should not modify the result")
	}
	// Confirm no consentReason injected.
	if strings.Contains(result.Stdout, "consentReason") {
		t.Fatalf("consentReason should not appear in notify-mode result")
	}
}
