package heartbeat

// Consent prompt protocol v2 at the agent: the helper confirms the prompt is
// on screen, then reports one terminal outcome for the request's nonce.
// These drive solicitConsent / runConsentGate against a fake helper over a
// real IPC connection.

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// consentTestHelper is a fake helper on the far end of an IPC connection.
type consentTestHelper struct {
	session *sessionbroker.Session
	conn    *ipc.Conn
}

func newConsentTestHelper(t *testing.T, name string, scopes []string, protocol int) *consentTestHelper {
	t.Helper()
	serverConn, clientConn := createTestSocketPair(t)
	session := sessionbroker.NewSession(ipc.NewConn(serverConn), 1000, "1000", "alice", "quartz", name, scopes)
	session.WinSessionID = "2"
	session.ConsentProtocolVersion = protocol
	go func() {
		// Mirrors the broker: a helper whose connection drops is closed
		// (finishHelperSession), which is what the gate observes.
		session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})
		_ = session.Close()
	}()
	h := &consentTestHelper{session: session, conn: ipc.NewConn(clientConn)}
	t.Cleanup(func() {
		_ = session.Close()
		_ = h.conn.Close()
	})
	return h
}

// recvRequest reads the consent_request the agent sent.
func (c *consentTestHelper) recvRequest(t *testing.T) (*ipc.Envelope, ipc.ConsentRequest) {
	t.Helper()
	c.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	env, err := c.conn.Recv()
	if err != nil {
		t.Errorf("helper recv: %v", err)
		return nil, ipc.ConsentRequest{}
	}
	if env.Type != ipc.TypeConsentRequest {
		t.Errorf("helper got %q, want consent_request", env.Type)
	}
	var req ipc.ConsentRequest
	_ = json.Unmarshal(env.Payload, &req)
	return env, req
}

func (c *consentTestHelper) ack(t *testing.T, id, nonce string) {
	t.Helper()
	if err := c.conn.SendTyped(id, ipc.TypeConsentPresented, ipc.ConsentPresented{Nonce: nonce}); err != nil {
		t.Errorf("ack: %v", err)
	}
}

func (c *consentTestHelper) result(t *testing.T, id string, res ipc.ConsentResult) {
	t.Helper()
	if err := c.conn.SendTyped(id, ipc.TypeConsentResult, res); err != nil {
		t.Errorf("result: %v", err)
	}
}

// withConsentSeams pins the occupancy and visibility the gate observes and
// shortens the presentation budget.
func withConsentSeams(t *testing.T, occupancy string, visible bool) {
	t.Helper()
	origOcc, origVis, origBudget := consentOccupancyFn, consentVisibleFn, consentPresentBudget
	consentOccupancyFn = func(string) string { return occupancy }
	consentVisibleFn = func(*sessionbroker.Session) bool { return visible }
	consentPresentBudget = 300 * time.Millisecond
	t.Cleanup(func() {
		consentOccupancyFn, consentVisibleFn, consentPresentBudget = origOcc, origVis, origBudget
	})
}

func TestSolicitConsentV2(t *testing.T) {
	tests := []struct {
		name        string
		script      func(t *testing.T, c *consentTestHelper, env *ipc.Envelope, req ipc.ConsentRequest)
		wantOutcome string
		wantDetail  string
		wantCancel  bool
	}{
		{
			name: "acknowledged then granted",
			script: func(t *testing.T, c *consentTestHelper, env *ipc.Envelope, req ipc.ConsentRequest) {
				c.ack(t, env.ID, req.Nonce)
				c.result(t, env.ID, ipc.ConsentResult{Nonce: req.Nonce, Outcome: ipc.ConsentOutcomeGranted})
			},
			wantOutcome: ipc.ConsentOutcomeGranted,
		},
		{
			name: "acknowledged then expired",
			script: func(t *testing.T, c *consentTestHelper, env *ipc.Envelope, req ipc.ConsentRequest) {
				c.ack(t, env.ID, req.Nonce)
				c.result(t, env.ID, ipc.ConsentResult{Nonce: req.Nonce, Outcome: ipc.ConsentOutcomePresentedExpired})
			},
			wantOutcome: ipc.ConsentOutcomePresentedExpired,
		},
		{
			name: "expired without ever confirming the prompt is not an unanswered prompt",
			script: func(t *testing.T, c *consentTestHelper, env *ipc.Envelope, req ipc.ConsentRequest) {
				c.result(t, env.ID, ipc.ConsentResult{Nonce: req.Nonce, Outcome: ipc.ConsentOutcomePresentedExpired})
			},
			wantOutcome: consentOutcomeUnknown,
			wantDetail:  "expired_without_presentation",
		},
		{
			name: "helper says it cannot show the prompt",
			script: func(t *testing.T, c *consentTestHelper, env *ipc.Envelope, req ipc.ConsentRequest) {
				c.result(t, env.ID, ipc.ConsentResult{Nonce: req.Nonce, Outcome: ipc.ConsentOutcomeUnavailable, Detail: "window_failed"})
			},
			wantOutcome: ipc.ConsentOutcomeUnavailable,
			wantDetail:  "window_failed",
		},
		{
			name:        "no acknowledgement within the presentation budget",
			script:      func(t *testing.T, c *consentTestHelper, env *ipc.Envelope, req ipc.ConsentRequest) {},
			wantOutcome: ipc.ConsentOutcomeUnavailable,
			wantDetail:  "no_presentation",
			wantCancel:  true,
		},
		{
			name: "acknowledged, then no answer (a lost Deny must not become anything else)",
			script: func(t *testing.T, c *consentTestHelper, env *ipc.Envelope, req ipc.ConsentRequest) {
				c.ack(t, env.ID, req.Nonce)
			},
			wantOutcome: consentOutcomeUnknown,
			wantDetail:  "no_answer",
			wantCancel:  true,
		},
		{
			name: "acknowledged, then the helper goes away",
			script: func(t *testing.T, c *consentTestHelper, env *ipc.Envelope, req ipc.ConsentRequest) {
				c.ack(t, env.ID, req.Nonce)
				time.Sleep(50 * time.Millisecond)
				_ = c.conn.Close()
			},
			wantOutcome: consentOutcomeUnknown,
			wantDetail:  "helper_disconnected",
		},
		{
			name: "replies for another nonce are ignored",
			script: func(t *testing.T, c *consentTestHelper, env *ipc.Envelope, req ipc.ConsentRequest) {
				c.ack(t, env.ID, "someone-else")
				c.result(t, env.ID, ipc.ConsentResult{Nonce: "someone-else", Outcome: ipc.ConsentOutcomeGranted})
			},
			wantOutcome: ipc.ConsentOutcomeUnavailable,
			wantDetail:  "no_presentation",
			wantCancel:  true,
		},
		{
			name: "error reply after the prompt was shown",
			script: func(t *testing.T, c *consentTestHelper, env *ipc.Envelope, req ipc.ConsentRequest) {
				c.ack(t, env.ID, req.Nonce)
				_ = c.conn.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeConsentResult, Error: "consent handler panicked"})
			},
			wantOutcome: consentOutcomeUnknown,
			wantDetail:  "helper_error",
		},
		{
			name: "garbled reply",
			script: func(t *testing.T, c *consentTestHelper, env *ipc.Envelope, req ipc.ConsentRequest) {
				c.ack(t, env.ID, req.Nonce)
				_ = c.conn.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeConsentResult, Payload: json.RawMessage("[1]")})
			},
			wantOutcome: consentOutcomeUnknown,
			wantDetail:  "invalid_reply",
		},
		{
			name: "a v1-style decision from a v2 helper is not an answer",
			script: func(t *testing.T, c *consentTestHelper, env *ipc.Envelope, req ipc.ConsentRequest) {
				c.ack(t, env.ID, req.Nonce)
				c.result(t, env.ID, ipc.ConsentResult{Nonce: req.Nonce, Decision: "allow"})
			},
			wantOutcome: consentOutcomeUnknown,
			wantDetail:  "invalid_reply",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			withConsentSeams(t, occupancyOccupied, true)
			c := newConsentTestHelper(t, "helper-v2", []string{ipc.ScopeConsentUI}, ipc.ConsentProtocolVersion)
			h := &Heartbeat{sessionBroker: newTestBrokerWithSessions(t, c.session)}

			cancelled := make(chan string, 1)
			go func() {
				env, req := c.recvRequest(t)
				if env == nil {
					return
				}
				if req.ProtocolVersion != ipc.ConsentProtocolVersion || len(req.Nonce) < 16 {
					t.Errorf("request must carry the v2 protocol and a nonce: %+v", req)
				}
				tt.script(t, c, env, req)
				c.conn.SetReadDeadline(time.Now().Add(3 * time.Second))
				if next, err := c.conn.Recv(); err == nil && next.Type == ipc.TypeConsentCancel {
					var cc ipc.ConsentCancel
					_ = json.Unmarshal(next.Payload, &cc)
					if cc.Nonce == req.Nonce {
						cancelled <- cc.Nonce
					}
				}
			}()

			att := h.solicitConsent("sess-v2", consentModePrompt("proceed", 200), "")
			if att.outcome != tt.wantOutcome || att.detail != tt.wantDetail {
				t.Fatalf("attempt = (%q,%q), want (%q,%q)", att.outcome, att.detail, tt.wantOutcome, tt.wantDetail)
			}
			if att.helper != c.session {
				t.Fatal("the attempt must record which helper was asked")
			}
			if tt.wantCancel {
				select {
				case <-cancelled:
				case <-time.After(3 * time.Second):
					t.Fatal("an abandoned prompt must be cancelled on the helper")
				}
			}
		})
	}
}

// A version 1 Assist (no consentProtocolVersion at auth) cannot say whether
// its prompt was shown: its clicks are honored, its silence is not an
// unanswered prompt.
func TestSolicitConsentLegacyAssist(t *testing.T) {
	tests := []struct {
		name        string
		reply       func(c *consentTestHelper, env *ipc.Envelope)
		wantOutcome string
	}{
		{"click allow", func(c *consentTestHelper, env *ipc.Envelope) {
			_ = c.conn.SendTyped(env.ID, ipc.TypeConsentResult, ipc.ConsentResult{Decision: "allow"})
		}, ipc.ConsentOutcomeGranted},
		{"click deny", func(c *consentTestHelper, env *ipc.Envelope) {
			_ = c.conn.SendTyped(env.ID, ipc.TypeConsentResult, ipc.ConsentResult{Decision: "deny"})
		}, ipc.ConsentOutcomeDenied},
		{"silence", func(c *consentTestHelper, env *ipc.Envelope) {}, consentOutcomeUnknown},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			withConsentSeams(t, occupancyOccupied, true)
			c := newConsentTestHelper(t, "assist-v1", []string{ipc.ScopeConsentUI}, 0)
			h := &Heartbeat{sessionBroker: newTestBrokerWithSessions(t, c.session)}
			go func() {
				if env, _ := c.recvRequest(t); env != nil {
					tt.reply(c, env)
				}
			}()
			att := h.solicitConsent("sess-v1", consentModePrompt("proceed", 50), "")
			if att.outcome != tt.wantOutcome {
				t.Fatalf("outcome = %q, want %q", att.outcome, tt.wantOutcome)
			}
		})
	}
}

// A native helper that predates v2 turned an expired countdown into "allow"
// under a proceed policy — indistinguishable from a click. It is never asked.
func TestSolicitConsentSkipsLegacyNativeHelper(t *testing.T) {
	withConsentSeams(t, occupancyOccupied, true)
	c := newConsentTestHelper(t, "native-v1", []string{ipc.ScopeConsentUIFallback}, 0)
	h := &Heartbeat{sessionBroker: newTestBrokerWithSessions(t, c.session)}

	got := make(chan string, 1)
	go func() {
		c.conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		if env, err := c.conn.Recv(); err == nil {
			got <- env.Type
		}
		close(got)
	}()

	v := h.runConsentGate("sess-native-v1", consentModePrompt("proceed", 50), "")
	if v.proceed || v.reason != consentReasonHelperUnreachable || v.outcome != ipc.ConsentOutcomeUnavailable || v.detail != "no_helper" {
		t.Fatalf("verdict = %+v, want a refusal: someone is signed in and no v2 helper can ask them", v)
	}
	if typ, ok := <-got; ok {
		t.Fatalf("a pre-v2 native helper must not be sent the prompt, got %q", typ)
	}
}

// Two starts must not stack prompts on the same helper: the second is refused
// while the first is on screen.
func TestSolicitConsentRefusesConcurrentPromptOnSameHelper(t *testing.T) {
	withConsentSeams(t, occupancyOccupied, true)
	consentPresentBudget = 2 * time.Second
	c := newConsentTestHelper(t, "helper-busy", []string{ipc.ScopeConsentUI}, ipc.ConsentProtocolVersion)
	h := &Heartbeat{sessionBroker: newTestBrokerWithSessions(t, c.session)}

	firstReq := make(chan ipc.ConsentRequest, 1)
	firstEnv := make(chan *ipc.Envelope, 1)
	go func() {
		env, req := c.recvRequest(t)
		if env != nil {
			c.ack(t, env.ID, req.Nonce)
			firstEnv <- env
			firstReq <- req
		}
	}()

	first := make(chan consentAttempt, 1)
	go func() { first <- h.solicitConsent("sess-a", consentModePrompt("block", 2000), "") }()

	env := <-firstEnv
	req := <-firstReq
	second := h.solicitConsent("sess-b", consentModePrompt("block", 2000), "")
	if second.outcome != ipc.ConsentOutcomeUnavailable || second.detail != "prompt_in_progress" {
		t.Fatalf("second prompt = %+v, want unavailable/prompt_in_progress", second)
	}

	c.result(t, env.ID, ipc.ConsentResult{Nonce: req.Nonce, Outcome: ipc.ConsentOutcomeDenied})
	if att := <-first; att.outcome != ipc.ConsentOutcomeDenied {
		t.Fatalf("first prompt = %+v", att)
	}
}

func TestSanitizeConsentDetail(t *testing.T) {
	for in, want := range map[string]string{
		"window_failed":          "window_failed",
		"":                       "",
		"Has Caps":               "",
		"x;rm":                   "",
		string(make([]byte, 65)): "",
	} {
		if got := sanitizeConsentDetail(in); got != want {
			t.Errorf("sanitizeConsentDetail(%q) = %q, want %q", in, got, want)
		}
	}
}

// Consent is bound to the session the user answered in: an untargeted
// Windows start is pinned there, and the capture must land there.
func TestConsentCaptureTarget(t *testing.T) {
	helper := &sessionbroker.Session{WinSessionID: "3"}
	tests := []struct {
		name   string
		goos   string
		target string
		helper *sessionbroker.Session
		want   string
	}{
		{"untargeted windows pins to the consenting session", "windows", "", helper, "3"},
		{"explicit target stays", "windows", "5", helper, "5"},
		{"no helper (nobody signed in) stays untargeted", "windows", "", nil, ""},
		{"session 0 is never pinned", "windows", "", &sessionbroker.Session{WinSessionID: "0"}, ""},
		{"non-windows is untouched", "darwin", "", helper, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := consentCaptureTarget(tt.goos, tt.target, tt.helper); got != tt.want {
				t.Fatalf("consentCaptureTarget = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestSameConsentPrincipal(t *testing.T) {
	consent := &sessionbroker.Session{WinSessionID: "3", IdentityKey: "501"}
	tests := []struct {
		name    string
		goos    string
		capture *sessionbroker.Session
		want    bool
	}{
		{"windows same session (capture runs as SYSTEM there)", "windows", &sessionbroker.Session{WinSessionID: "3", IdentityKey: "S-1-5-18"}, true},
		{"windows other session", "windows", &sessionbroker.Session{WinSessionID: "4"}, false},
		{"mac same user", "darwin", &sessionbroker.Session{IdentityKey: "501"}, true},
		{"mac other user", "darwin", &sessionbroker.Session{IdentityKey: "502"}, false},
		{"linux has no capture helper to compare", "linux", &sessionbroker.Session{IdentityKey: "0"}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := sameConsentPrincipal(tt.goos, consent, tt.capture); got != tt.want {
				t.Fatalf("sameConsentPrincipal = %v, want %v", got, tt.want)
			}
		})
	}
}

// The marker the API ingests: version 2 fields ride alongside the reason.
func TestConsentMarkerFields(t *testing.T) {
	m := consentMarkerFields(consentVerdict{reason: "helper_unreachable", outcome: ipc.ConsentOutcomeUnavailable, occupancy: occupancyOccupied, detail: "no_helper"})
	if m["consentProtocol"] != ipc.ConsentProtocolVersion || m["consentOutcome"] != "unavailable" ||
		m["consentOccupancy"] != "occupied" || m["consentDetail"] != "no_helper" {
		t.Fatalf("marker = %v", m)
	}
	m = consentMarkerFields(consentVerdict{reason: "user", outcome: ipc.ConsentOutcomeGranted})
	if _, ok := m["consentOccupancy"]; ok {
		t.Fatalf("occupancy is only reported when it was evaluated: %v", m)
	}
	if _, ok := m["consentDetail"]; ok {
		t.Fatalf("empty detail must be omitted: %v", m)
	}
}
