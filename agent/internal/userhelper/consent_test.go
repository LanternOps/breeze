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
			ipc.ConsentRequest{TechnicianName: "Billy", TechnicianEmail: "billy@olive.co", OrgName: "Olive Technology"},
			[]string{"Billy (billy@olive.co) from Olive Technology", "requesting remote access"},
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
		TechnicianEmail: "billy\x00@olive.co",
		OrgName:         "Olive\x7f Technology",
	})
	if strings.ContainsAny(controlChars.TechnicianEmail, "\x00") || controlChars.TechnicianEmail != "billy@olive.co" {
		t.Errorf("email control chars not stripped: %q", controlChars.TechnicianEmail)
	}
	if strings.ContainsAny(controlChars.OrgName, "\x7f") || controlChars.OrgName != "Olive Technology" {
		t.Errorf("org name control chars not stripped: %q", controlChars.OrgName)
	}
}

func TestConsentDecisionMapping(t *testing.T) {
	tests := []struct {
		name      string
		allow     bool
		answered  bool
		onTimeout string
		want      string
	}{
		{"user allowed", true, true, "block", "allow"},
		{"user denied", false, true, "proceed", "deny"},
		{"timeout with proceed", false, false, "proceed", "allow"}, // mirrors Tauri ConsentDialog.tsx
		{"timeout with block", false, false, "block", "deny"},
		{"timeout with unknown behavior fails closed", false, false, "", "deny"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := consentDecision(tt.allow, tt.answered, tt.onTimeout); got != tt.want {
				t.Errorf("consentDecision() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestShowConsentDialogFnInjectable(t *testing.T) {
	orig := showConsentDialogFn
	defer func() { showConsentDialogFn = orig }()
	called := false
	showConsentDialogFn = func(req ipc.ConsentRequest) (bool, bool) {
		called = true
		return true, true
	}
	allow, answered := showConsentDialogFn(ipc.ConsentRequest{})
	if !called || !allow || !answered {
		t.Fatal("injection seam broken")
	}
}

// consentRequestPayload marshals a minimal valid ConsentRequest for use as an
// envelope payload in the handleConsentRequest wiring tests below.
func consentRequestPayload(t *testing.T, sessionID string) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(ipc.ConsentRequest{SessionID: sessionID, OnTimeout: "block"})
	if err != nil {
		t.Fatalf("marshal consent request: %v", err)
	}
	return raw
}

func TestHandleConsentRequest_RepliesSameEnvelopeId(t *testing.T) {
	tests := []struct {
		name         string
		dialogAllow  bool
		dialogAnswer bool
		wantDecision string
	}{
		{"allow", true, true, "allow"},
		{"deny", false, true, "deny"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			orig := showConsentDialogFn
			defer func() { showConsentDialogFn = orig }()
			showConsentDialogFn = func(req ipc.ConsentRequest) (bool, bool) {
				return tt.dialogAllow, tt.dialogAnswer
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
	orig := showConsentDialogFn
	defer func() { showConsentDialogFn = orig }()
	showConsentDialogFn = func(req ipc.ConsentRequest) (bool, bool) {
		panic("simulated Win32 syscall crash")
	}

	client, peer, cleanup := createClientPipe(t)
	defer cleanup()

	const reqID = "consent-req-panic"
	done := make(chan struct{})
	go func() {
		client.handleConsentRequest(&ipc.Envelope{
			ID:      reqID,
			Payload: consentRequestPayload(t, "session-panic"),
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
		t.Fatal("expected a fail-closed error reply when the dialog handler panics")
	}
	var result ipc.ConsentResult
	_ = json.Unmarshal(env.Payload, &result)
	if result.Decision == "allow" {
		t.Fatal("panic path must never yield an allow decision")
	}
}
