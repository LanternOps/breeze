package sessionbroker

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestDismissPamConsentReturnsCorrelatedHelperResult(t *testing.T) {
	tests := []struct {
		name string
		want ipc.PamDismissConsentResult
	}{
		{
			name: "success",
			want: ipc.PamDismissConsentResult{Success: true, Reason: "dismissed"},
		},
		{
			name: "helper reports non-success",
			want: ipc.PamDismissConsentResult{
				Success:       false,
				Reason:        "not_found",
				DetailMessage: "consent.exe was not running",
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			session, clientIPC := createPamDismissTestSession()
			defer session.Close()
			defer clientIPC.Close()

			got, err := exchangePamDismiss(
				t,
				session,
				clientIPC,
				"dismiss-1",
				ipc.TypePamDismissConsentResult,
				tc.want,
				"",
				2*time.Second,
			)
			if err != nil {
				t.Fatalf("DismissPamConsent: %v", err)
			}
			if got != tc.want {
				t.Fatalf("DismissPamConsent result = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestDismissPamConsentRequiresSystemPamSession(t *testing.T) {
	tests := []struct {
		name    string
		role    string
		scopes  []string
		wantErr string
	}{
		{
			name:    "user helper with PAM scope",
			role:    ipc.HelperRoleUser,
			scopes:  []string{ipc.ScopePam},
			wantErr: "SYSTEM helper",
		},
		{
			name:    "system helper without PAM scope",
			role:    ipc.HelperRoleSystem,
			scopes:  []string{"desktop"},
			wantErr: ipc.ScopePam,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			session := &Session{HelperRole: tc.role, AllowedScopes: tc.scopes}
			got, err := (&Broker{}).DismissPamConsent(session, "dismiss-rejected", time.Millisecond)
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("DismissPamConsent error = %v, want substring %q", err, tc.wantErr)
			}
			if got != (ipc.PamDismissConsentResult{}) {
				t.Fatalf("rejected result = %+v, want zero value", got)
			}
		})
	}
}

func TestDismissPamConsentRejectsNilSession(t *testing.T) {
	got, err := (&Broker{}).DismissPamConsent(nil, "dismiss-nil", time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "nil PAM helper session") {
		t.Fatalf("DismissPamConsent error = %v, want nil-session error", err)
	}
	if got != (ipc.PamDismissConsentResult{}) {
		t.Fatalf("nil-session result = %+v, want zero value", got)
	}
}

func TestDismissPamConsentReturnsEnvelopeAndDecodeErrors(t *testing.T) {
	tests := []struct {
		name          string
		response      any
		envelopeError string
		wantErr       string
	}{
		{
			name:          "error envelope",
			envelopeError: "helper access denied",
			wantErr:       "helper access denied",
		},
		{
			name:     "malformed result JSON",
			response: map[string]any{"success": "yes", "reason": 42},
			wantErr:  "decode PAM consent dismissal result",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			session, clientIPC := createPamDismissTestSession()
			defer session.Close()
			defer clientIPC.Close()

			got, err := exchangePamDismiss(
				t,
				session,
				clientIPC,
				"dismiss-error",
				ipc.TypePamDismissConsentResult,
				tc.response,
				tc.envelopeError,
				2*time.Second,
			)
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("DismissPamConsent error = %v, want substring %q", err, tc.wantErr)
			}
			if got != (ipc.PamDismissConsentResult{}) {
				t.Fatalf("error result = %+v, want zero value", got)
			}
		})
	}
}

func TestDismissPamConsentRejectsWrongResponseType(t *testing.T) {
	session, clientIPC := createPamDismissTestSession()
	defer session.Close()
	defer clientIPC.Close()

	got, err := exchangePamDismiss(
		t,
		session,
		clientIPC,
		"dismiss-wrong-type",
		ipc.TypePamDialogResult,
		ipc.PamDismissConsentResult{Success: true, Reason: "dismissed"},
		"",
		50*time.Millisecond,
	)
	if !errors.Is(err, ErrCommandTimeout) {
		t.Fatalf("DismissPamConsent error = %v, want ErrCommandTimeout", err)
	}
	if got != (ipc.PamDismissConsentResult{}) {
		t.Fatalf("wrong-type result = %+v, want zero value", got)
	}
}

func TestDismissPamConsentTimesOut(t *testing.T) {
	session, clientIPC := createPamDismissTestSession()
	defer session.Close()
	defer clientIPC.Close()

	got, err := exchangePamDismiss(
		t,
		session,
		clientIPC,
		"dismiss-timeout",
		"",
		nil,
		"",
		50*time.Millisecond,
	)
	if !errors.Is(err, ErrCommandTimeout) {
		t.Fatalf("DismissPamConsent error = %v, want ErrCommandTimeout", err)
	}
	if got != (ipc.PamDismissConsentResult{}) {
		t.Fatalf("timeout result = %+v, want zero value", got)
	}
}

func exchangePamDismiss(
	t *testing.T,
	session *Session,
	clientIPC *ipc.Conn,
	id string,
	responseType string,
	response any,
	envelopeError string,
	timeout time.Duration,
) (ipc.PamDismissConsentResult, error) {
	t.Helper()

	helperDone := make(chan error, 1)
	go func() {
		if err := clientIPC.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
			helperDone <- fmt.Errorf("set client read deadline: %w", err)
			return
		}
		env, err := clientIPC.Recv()
		if err != nil {
			helperDone <- fmt.Errorf("client recv: %w", err)
			return
		}
		if env.ID != id {
			helperDone <- fmt.Errorf("request ID = %q, want %q", env.ID, id)
			return
		}
		if env.Type != ipc.TypePamDismissConsent {
			helperDone <- fmt.Errorf("request type = %q, want %q", env.Type, ipc.TypePamDismissConsent)
			return
		}
		if string(env.Payload) != `{}` {
			helperDone <- fmt.Errorf("request payload = %s, want {}", env.Payload)
			return
		}
		var request ipc.PamDismissConsentRequest
		if err := json.Unmarshal(env.Payload, &request); err != nil {
			helperDone <- fmt.Errorf("decode request: %w", err)
			return
		}

		if responseType == "" {
			helperDone <- nil
			return
		}
		if envelopeError != "" {
			helperDone <- clientIPC.Send(&ipc.Envelope{
				ID:    env.ID,
				Type:  responseType,
				Error: envelopeError,
			})
			return
		}
		helperDone <- clientIPC.SendTyped(env.ID, responseType, response)
	}()
	go session.RecvLoop(func(s *Session, env *ipc.Envelope) {})

	got, err := (&Broker{}).DismissPamConsent(session, id, timeout)
	if helperErr := <-helperDone; helperErr != nil {
		t.Fatalf("helper exchange: %v", helperErr)
	}
	return got, err
}

func createPamDismissTestSession() (*Session, *ipc.Conn) {
	serverConn, clientConn := net.Pipe()
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)
	session := NewSession(serverIPC, 1000, "1000", "testuser", "x11:0", "test-session-1", []string{ipc.ScopePam})
	session.HelperRole = ipc.HelperRoleSystem
	return session, clientIPC
}
