package userhelper

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestBuildConsentDialogText(t *testing.T) {
	tests := []struct {
		name     string
		req      ipc.ConsentRequest
		wantBody []string // substrings that must appear
		notBody  []string // substrings that must NOT appear
	}{
		{
			"full identity",
			ipc.ConsentRequest{TechnicianName: "Billy", TechnicianEmail: "billy@example.com", OrgName: "Olive Technology"},
			[]string{"Billy (billy@example.com) from Olive Technology", "requesting remote access"},
			nil,
		},
		{
			"name only",
			ipc.ConsentRequest{TechnicianName: "Billy"},
			[]string{"Billy is requesting remote access"},
			[]string{"()", " from "},
		},
		{
			"generic with partner",
			ipc.ConsentRequest{OrgName: "Olive Technology"},
			[]string{"A technician from Olive Technology is requesting remote access"},
			nil,
		},
		{
			"fully generic",
			ipc.ConsentRequest{},
			[]string{"A technician is requesting remote access"},
			nil,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			title, body := buildConsentDialogText(tt.req)
			if title != "Remote Support Request" {
				t.Errorf("title = %q", title)
			}
			for _, want := range tt.wantBody {
				if !strings.Contains(body, want) {
					t.Errorf("body %q missing %q", body, want)
				}
			}
			for _, not := range tt.notBody {
				if strings.Contains(body, not) {
					t.Errorf("body %q must not contain %q", body, not)
				}
			}
		})
	}
}

func TestSanitizeConsentRequest(t *testing.T) {
	long := strings.Repeat("x", 5000)
	req := sanitizeConsentRequest(ipc.ConsentRequest{
		TechnicianName: "  Billy\x00 ", TechnicianEmail: long, OrgName: long,
		TimeoutMs: 99_999_999, OnTimeout: "PROCEED",
	})
	if strings.ContainsAny(req.TechnicianName, "\x00") || req.TechnicianName != "Billy" {
		t.Errorf("name not sanitized: %q", req.TechnicianName)
	}
	if len(req.TechnicianEmail) > maxNotifyTitleBytes || len(req.OrgName) > maxNotifyTitleBytes {
		t.Error("email/org not truncated")
	}
	if req.TimeoutMs != maxConsentTimeoutMs {
		t.Errorf("timeout not clamped: %d", req.TimeoutMs)
	}
	if req.OnTimeout != "proceed" {
		t.Errorf("onTimeout not normalized: %q", req.OnTimeout)
	}

	negative := sanitizeConsentRequest(ipc.ConsentRequest{TimeoutMs: -5})
	if negative.TimeoutMs != 0 {
		t.Errorf("negative timeout not clamped to 0: %d", negative.TimeoutMs)
	}

	controlChars := sanitizeConsentRequest(ipc.ConsentRequest{
		TechnicianEmail: "billy\x00@example.com",
		OrgName:         "Olive\x7f Technology",
	})
	if strings.ContainsAny(controlChars.TechnicianEmail, "\x00") || controlChars.TechnicianEmail != "billy@example.com" {
		t.Errorf("email control chars not stripped: %q", controlChars.TechnicianEmail)
	}
	if strings.ContainsAny(controlChars.OrgName, "\x7f") || controlChars.OrgName != "Olive Technology" {
		t.Errorf("org name control chars not stripped: %q", controlChars.OrgName)
	}
}

// Version 1 (an older agent that sends no nonce): a click is reported as
// allow/deny, an expired countdown keeps the legacy policy verdict, and a
// prompt that could not be shown is an error reply (the agent fails closed on
// it) — never a decision.
func TestLegacyConsentDecision(t *testing.T) {
	tests := []struct {
		name      string
		outcome   dialogOutcome
		onTimeout string
		want      string
		wantErr   bool
	}{
		{"user allowed", dialogAllowed, "block", "allow", false},
		{"user denied", dialogDenied, "proceed", "deny", false},
		{"expired with proceed keeps the v1 verdict", dialogExpired, "proceed", "allow", false},
		{"expired with block", dialogExpired, "block", "deny", false},
		{"expired with unknown behavior fails closed", dialogExpired, "", "deny", false},
		{"could not be shown is never a decision", dialogUnavailable, "proceed", "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, isErr := legacyConsentDecision(tt.outcome, tt.onTimeout)
			if got != tt.want || isErr != tt.wantErr {
				t.Errorf("legacyConsentDecision() = (%q,%v), want (%q,%v)", got, isErr, tt.want, tt.wantErr)
			}
		})
	}
}

// Version 2: the helper reports what actually happened. An expired countdown
// is presented_expired (never "allow"), and a prompt the OS could not show is
// unavailable (never a user denial).
func TestConsentOutcomeWireValue(t *testing.T) {
	tests := []struct {
		outcome dialogOutcome
		want    string
	}{
		{dialogAllowed, ipc.ConsentOutcomeGranted},
		{dialogDenied, ipc.ConsentOutcomeDenied},
		{dialogExpired, ipc.ConsentOutcomePresentedExpired},
		{dialogUnavailable, ipc.ConsentOutcomeUnavailable},
		{dialogOutcome(99), ipc.ConsentOutcomeUnavailable},
	}
	for _, tt := range tests {
		if got := tt.outcome.wireValue(); got != tt.want {
			t.Errorf("dialogOutcome(%d).wireValue() = %q, want %q", tt.outcome, got, tt.want)
		}
	}
}

// Each platform's dialog result is classified by a pure function so the
// mapping is tested on every OS, not only where the dialog can run.
func TestClassifyMessageBoxReturn(t *testing.T) {
	tests := []struct {
		ret  uintptr
		want dialogOutcome
	}{
		{6, dialogAllowed},     // IDYES
		{7, dialogDenied},      // IDNO
		{32000, dialogExpired}, // MessageBoxTimeoutW timed out
		{0, dialogUnavailable}, // the call failed: no dialog was shown
		{2, dialogUnavailable}, // IDCANCEL cannot come from a Yes/No box
	}
	for _, tt := range tests {
		if got := classifyMessageBoxReturn(tt.ret); got != tt.want {
			t.Errorf("classifyMessageBoxReturn(%d) = %v, want %v", tt.ret, got, tt.want)
		}
	}
}

func TestClassifyZenityExit(t *testing.T) {
	tests := []struct {
		name     string
		exitCode int
		started  bool
		stderr   string
		want     dialogOutcome
	}{
		{"allow", 0, true, "", dialogAllowed},
		{"deny", 1, true, "", dialogDenied},
		{"deny with harmless gtk noise", 1, true, "Gtk-Message: GtkDialog mapped without a transient parent", dialogDenied},
		{"no display is not a denial", 1, true, "(zenity:123): Gtk-WARNING **: cannot open display: :0", dialogUnavailable},
		{"timeout", 5, true, "", dialogExpired},
		{"zenity missing", -1, false, "", dialogUnavailable},
		{"crash", 139, true, "", dialogUnavailable},
		{"killed", -1, true, "", dialogUnavailable},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := classifyZenityExit(tt.exitCode, tt.started, tt.stderr); got != tt.want {
				t.Errorf("classifyZenityExit = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestClassifyOsascriptResult(t *testing.T) {
	tests := []struct {
		name   string
		output string
		failed bool
		want   dialogOutcome
	}{
		{"allow", "button returned:Allow, gave up:false", false, dialogAllowed},
		{"deny is a user cancel", "execution error: User canceled. (-128)", true, dialogDenied},
		{"expired", "button returned:, gave up:true", false, dialogExpired},
		{"no window server is not an expiry", "execution error: No user interaction allowed. (-1713)", true, dialogUnavailable},
		{"osascript missing", "", true, dialogUnavailable},
		{"unrecognized success output", "something else", false, dialogUnavailable},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := classifyOsascriptResult(tt.output, tt.failed); got != tt.want {
				t.Errorf("classifyOsascriptResult = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestConsentProtocolForAuth(t *testing.T) {
	if got := consentProtocolForAuth(true); got != ipc.ConsentProtocolVersion {
		t.Fatalf("a helper that renders native dialogs must advertise v%d, got %d", ipc.ConsentProtocolVersion, got)
	}
	if got := consentProtocolForAuth(false); got != 0 {
		t.Fatalf("a helper that cannot render the prompt must not advertise a consent protocol, got %d", got)
	}
}

func TestShowConsentDialogFnInjectable(t *testing.T) {
	orig := showConsentDialogFn
	defer func() { showConsentDialogFn = orig }()
	called := false
	showConsentDialogFn = func(req ipc.ConsentRequest, presented func()) dialogOutcome {
		called = true
		presented()
		return dialogAllowed
	}
	acked := false
	if got := showConsentDialogFn(ipc.ConsentRequest{}, func() { acked = true }); !called || !acked || got != dialogAllowed {
		t.Fatal("injection seam broken")
	}
}

// consentRequestPayload marshals a minimal valid v1 ConsentRequest.
func consentRequestPayload(t *testing.T, sessionID string) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(ipc.ConsentRequest{SessionID: sessionID, OnTimeout: "block"})
	if err != nil {
		t.Fatalf("marshal consent request: %v", err)
	}
	return raw
}

// consentRequestPayloadV2 marshals a v2 ConsentRequest carrying nonce.
func consentRequestPayloadV2(t *testing.T, sessionID, nonce string) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(ipc.ConsentRequest{
		SessionID: sessionID, OnTimeout: "proceed", TimeoutMs: 1000,
		ProtocolVersion: ipc.ConsentProtocolVersion, Nonce: nonce,
	})
	if err != nil {
		t.Fatalf("marshal consent request: %v", err)
	}
	return raw
}

func TestHandleConsentRequest_RepliesSameEnvelopeId(t *testing.T) {
	tests := []struct {
		name         string
		outcome      dialogOutcome
		wantDecision string
	}{
		{"allow", dialogAllowed, "allow"},
		{"deny", dialogDenied, "deny"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			orig := showConsentDialogFn
			defer func() { showConsentDialogFn = orig }()
			showConsentDialogFn = func(req ipc.ConsentRequest, presented func()) dialogOutcome {
				presented()
				return tt.outcome
			}

			client, peer, cleanup := createClientPipe(t)
			defer cleanup()

			const reqID = "consent-req-1"
			done := make(chan struct{})
			go func() {
				client.handleConsentRequest(&ipc.Envelope{
					ID:      reqID,
					Payload: consentRequestPayload(t, "session-1"),
				})
				close(done)
			}()

			peer.SetReadDeadline(time.Now().Add(2 * time.Second))
			env, err := peer.Recv()
			if err != nil {
				t.Fatalf("Recv: %v", err)
			}
			<-done

			// A v1 exchange has no presentation acknowledgement: the first and
			// only envelope is the decision.
			if env.ID != reqID {
				t.Fatalf("response id = %q, want %q", env.ID, reqID)
			}
			if env.Type != ipc.TypeConsentResult {
				t.Fatalf("response type = %q, want %q", env.Type, ipc.TypeConsentResult)
			}
			var result ipc.ConsentResult
			if err := json.Unmarshal(env.Payload, &result); err != nil {
				t.Fatalf("unmarshal payload: %v", err)
			}
			if result.Decision != tt.wantDecision {
				t.Fatalf("decision = %q, want %q", result.Decision, tt.wantDecision)
			}
		})
	}
}

func TestHandleConsentRequest_LegacyUnavailableIsAnErrorReply(t *testing.T) {
	orig := showConsentDialogFn
	defer func() { showConsentDialogFn = orig }()
	showConsentDialogFn = func(req ipc.ConsentRequest, presented func()) dialogOutcome { return dialogUnavailable }

	client, peer, cleanup := createClientPipe(t)
	defer cleanup()

	go client.handleConsentRequest(&ipc.Envelope{ID: "consent-v1-unavail", Payload: consentRequestPayload(t, "s")})

	peer.SetReadDeadline(time.Now().Add(2 * time.Second))
	env, err := peer.Recv()
	if err != nil {
		t.Fatalf("Recv: %v", err)
	}
	if env.Error == "" {
		t.Fatalf("a prompt that could not be shown must be an error reply, got %s", env.Payload)
	}
}

// recvConsentEnvelopes reads n envelopes from the fake agent side.
func recvConsentEnvelopes(t *testing.T, peer *ipc.Conn, n int) []*ipc.Envelope {
	t.Helper()
	var out []*ipc.Envelope
	for i := 0; i < n; i++ {
		peer.SetReadDeadline(time.Now().Add(2 * time.Second))
		env, err := peer.Recv()
		if err != nil {
			t.Fatalf("Recv %d: %v", i, err)
		}
		out = append(out, env)
	}
	return out
}

func TestHandleConsentRequest_V2AcknowledgesThenReportsOutcome(t *testing.T) {
	tests := []struct {
		name        string
		outcome     dialogOutcome
		present     bool
		wantAck     bool
		wantOutcome string
	}{
		{"granted", dialogAllowed, true, true, ipc.ConsentOutcomeGranted},
		{"denied", dialogDenied, true, true, ipc.ConsentOutcomeDenied},
		{"expired countdown is not a grant", dialogExpired, true, true, ipc.ConsentOutcomePresentedExpired},
		{"dialog could not be shown", dialogUnavailable, false, false, ipc.ConsentOutcomeUnavailable},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			orig := showConsentDialogFn
			defer func() { showConsentDialogFn = orig }()
			showConsentDialogFn = func(req ipc.ConsentRequest, presented func()) dialogOutcome {
				if tt.present {
					presented()
				}
				return tt.outcome
			}

			client, peer, cleanup := createClientPipe(t)
			defer cleanup()

			const reqID = "consent-v2"
			go client.handleConsentRequest(&ipc.Envelope{ID: reqID, Payload: consentRequestPayloadV2(t, "s", "nonce-1")})

			want := 1
			if tt.wantAck {
				want = 2
			}
			envs := recvConsentEnvelopes(t, peer, want)
			if tt.wantAck {
				ack := envs[0]
				if ack.ID != reqID || ack.Type != ipc.TypeConsentPresented {
					t.Fatalf("first envelope = %s/%s, want the presentation ack", ack.ID, ack.Type)
				}
				var p ipc.ConsentPresented
				_ = json.Unmarshal(ack.Payload, &p)
				if p.Nonce != "nonce-1" {
					t.Fatalf("ack nonce = %q", p.Nonce)
				}
			}
			last := envs[len(envs)-1]
			if last.ID != reqID || last.Type != ipc.TypeConsentResult {
				t.Fatalf("terminal envelope = %s/%s", last.ID, last.Type)
			}
			var res ipc.ConsentResult
			if err := json.Unmarshal(last.Payload, &res); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if res.Nonce != "nonce-1" || res.Outcome != tt.wantOutcome || res.Decision != "" {
				t.Fatalf("result = %+v, want nonce-1/%s and no legacy decision", res, tt.wantOutcome)
			}
		})
	}
}

// A second prompt while one is on screen is refused, not stacked: the agent
// serializes prompts itself, and two stacked dialogs could have their answers
// attributed to the wrong request.
func TestHandleConsentRequest_V2RefusesAConcurrentPrompt(t *testing.T) {
	orig := showConsentDialogFn
	defer func() { showConsentDialogFn = orig }()
	release := make(chan struct{})
	showing := make(chan struct{})
	showConsentDialogFn = func(req ipc.ConsentRequest, presented func()) dialogOutcome {
		presented()
		close(showing)
		<-release
		return dialogDenied
	}

	client, peer, cleanup := createClientPipe(t)
	defer cleanup()

	go client.handleConsentRequest(&ipc.Envelope{ID: "consent-first", Payload: consentRequestPayloadV2(t, "s1", "n1")})
	ack := recvConsentEnvelopes(t, peer, 1)[0]
	if ack.Type != ipc.TypeConsentPresented {
		t.Fatalf("expected the first prompt's ack, got %s", ack.Type)
	}
	<-showing

	go client.handleConsentRequest(&ipc.Envelope{ID: "consent-second", Payload: consentRequestPayloadV2(t, "s2", "n2")})
	busy := recvConsentEnvelopes(t, peer, 1)[0]
	var res ipc.ConsentResult
	_ = json.Unmarshal(busy.Payload, &res)
	if busy.ID != "consent-second" || res.Nonce != "n2" || res.Outcome != ipc.ConsentOutcomeUnavailable || res.Detail != "prompt_in_progress" {
		t.Fatalf("second prompt reply = %s %+v, want unavailable/prompt_in_progress", busy.ID, res)
	}

	close(release)
	final := recvConsentEnvelopes(t, peer, 1)[0]
	_ = json.Unmarshal(final.Payload, &res)
	if final.ID != "consent-first" || res.Outcome != ipc.ConsentOutcomeDenied {
		t.Fatalf("first prompt result = %s %+v", final.ID, res)
	}
}

func TestHandleConsentRequest_BadPayloadFailsClosed(t *testing.T) {
	client, peer, cleanup := createClientPipe(t)
	defer cleanup()

	const reqID = "consent-req-bad"
	done := make(chan struct{})
	go func() {
		client.handleConsentRequest(&ipc.Envelope{
			ID:      reqID,
			Payload: []byte("{not json"),
		})
		close(done)
	}()

	peer.SetReadDeadline(time.Now().Add(2 * time.Second))
	env, err := peer.Recv()
	if err != nil {
		t.Fatalf("Recv: %v", err)
	}
	<-done

	if env.ID != reqID {
		t.Fatalf("response id = %q, want %q", env.ID, reqID)
	}
	if env.Error == "" {
		t.Fatal("expected a fail-closed error reply for a bad payload")
	}
	var result ipc.ConsentResult
	_ = json.Unmarshal(env.Payload, &result)
	if result.Decision == "allow" {
		t.Fatal("bad payload must never yield an allow decision")
	}
}

func TestHandleConsentRequest_PanicFailsClosed(t *testing.T) {
	for _, v2 := range []bool{false, true} {
		orig := showConsentDialogFn
		showConsentDialogFn = func(req ipc.ConsentRequest, presented func()) dialogOutcome {
			panic("simulated Win32 syscall crash")
		}

		client, peer, cleanup := createClientPipe(t)

		reqID := "consent-req-panic"
		payload := consentRequestPayload(t, "session-panic")
		if v2 {
			payload = consentRequestPayloadV2(t, "session-panic", "n-panic")
		}
		done := make(chan struct{})
		go func() {
			client.handleConsentRequest(&ipc.Envelope{ID: reqID, Payload: payload})
			close(done)
		}()

		peer.SetReadDeadline(time.Now().Add(2 * time.Second))
		env, err := peer.Recv()
		if err != nil {
			t.Fatalf("Recv: %v", err)
		}
		<-done

		if env.ID != reqID {
			t.Fatalf("response id = %q, want %q", env.ID, reqID)
		}
		if env.Error == "" {
			t.Fatal("expected a fail-closed error reply when the dialog handler panics")
		}
		var result ipc.ConsentResult
		_ = json.Unmarshal(env.Payload, &result)
		if result.Decision == "allow" || result.Outcome == ipc.ConsentOutcomeGranted {
			t.Fatal("panic path must never yield a grant")
		}
		// The panic must not leave the prompt marked as in progress.
		if client.consentPromptActive.Load() {
			t.Fatal("panic left the in-progress guard set")
		}
		cleanup()
		showConsentDialogFn = orig
	}
}
