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
			defer func() { _ = session.Close() }()
			defer func() { _ = clientIPC.Close() }()

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
			defer func() { _ = session.Close() }()
			defer func() { _ = clientIPC.Close() }()

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
	defer func() { _ = session.Close() }()
	defer func() { _ = clientIPC.Close() }()

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
	var uncertain *PamDismissUncertainError
	if !errors.As(err, &uncertain) || uncertain.Quiesced == nil {
		t.Fatalf("wrong-type error = %T, want uncertain completion with quiescence", err)
	}
	select {
	case <-uncertain.Quiesced:
		t.Fatal("wrong response type must not prove helper quiescence")
	default:
	}
}

func TestDismissPamConsentTimesOut(t *testing.T) {
	session, clientIPC := createPamDismissTestSession()
	defer func() { _ = session.Close() }()
	defer func() { _ = clientIPC.Close() }()

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

func TestDismissPamConsentTransportFailureIsUncertain(t *testing.T) {
	session, clientIPC := createPamDismissTestSession()
	defer func() { _ = session.Close() }()
	if err := clientIPC.Close(); err != nil {
		t.Fatalf("close helper connection: %v", err)
	}

	got, err := (&Broker{}).DismissPamConsent(session, "dismiss-send-failed", 2*time.Second)
	if err == nil {
		t.Fatal("DismissPamConsent error = nil, want transport error")
	}
	if got != (ipc.PamDismissConsentResult{}) {
		t.Fatalf("transport-error result = %+v, want zero value", got)
	}
	var uncertain *PamDismissUncertainError
	if !errors.As(err, &uncertain) || uncertain.Quiesced == nil {
		t.Fatalf("transport error = %T, want uncertain completion with quiescence", err)
	}
	select {
	case <-uncertain.Quiesced:
		t.Fatal("transport failure must not prove helper quiescence")
	default:
	}
}

func TestDismissPamConsentTimeoutSignalsLateHelperQuiescence(t *testing.T) {
	session, clientIPC := createPamDismissTestSession()
	defer func() { _ = session.Close() }()
	defer func() { _ = clientIPC.Close() }()

	releaseResponse := make(chan struct{})
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
		<-releaseResponse
		helperDone <- clientIPC.SendTyped(env.ID, ipc.TypePamDismissConsentResult, ipc.PamDismissConsentResult{
			Success: true,
			Reason:  "dismissed",
		})
	}()
	go session.RecvLoop(func(s *Session, env *ipc.Envelope) {})

	got, err := (&Broker{}).DismissPamConsent(session, "dismiss-late", 50*time.Millisecond)
	if got != (ipc.PamDismissConsentResult{}) {
		t.Fatalf("timeout result = %+v, want zero value", got)
	}
	if !errors.Is(err, ErrCommandTimeout) {
		t.Fatalf("DismissPamConsent error = %v, want ErrCommandTimeout", err)
	}
	var uncertain *PamDismissUncertainError
	if !errors.As(err, &uncertain) {
		t.Fatalf("DismissPamConsent error = %T, want *PamDismissUncertainError", err)
	}
	if uncertain.Quiesced == nil {
		t.Fatal("uncertain timeout did not expose helper quiescence")
	}
	select {
	case <-uncertain.Quiesced:
		t.Fatal("helper reported quiescent before its late response")
	default:
	}

	close(releaseResponse)
	select {
	case <-uncertain.Quiesced:
	case <-time.After(2 * time.Second):
		t.Fatal("helper quiescence was not signaled after the correlated late response")
	}
	if helperErr := <-helperDone; helperErr != nil {
		t.Fatalf("late helper response: %v", helperErr)
	}
}

func TestPamDismissConsentDeadlineReservesResponseGrace(t *testing.T) {
	now := time.Date(2026, time.July, 16, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name    string
		timeout time.Duration
		want    time.Time
		wantErr bool
	}{
		{
			name:    "ten second timeout reserves one second",
			timeout: 10 * time.Second,
			want:    now.Add(9 * time.Second),
		},
		{
			name:    "short timeout reserves one fifth",
			timeout: 50 * time.Millisecond,
			want:    now.Add(40 * time.Millisecond),
		},
		{name: "zero timeout", timeout: 0, wantErr: true},
		{name: "timeout too small for grace", timeout: 4 * time.Nanosecond, wantErr: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := pamDismissConsentDeadline(now, tc.timeout)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("pamDismissConsentDeadline(%v) error = nil, want error", tc.timeout)
				}
				return
			}
			if err != nil {
				t.Fatalf("pamDismissConsentDeadline(%v): %v", tc.timeout, err)
			}
			if !got.Equal(tc.want) {
				t.Fatalf("deadline = %v, want %v", got, tc.want)
			}
		})
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
		var request ipc.PamDismissConsentRequest
		if err := json.Unmarshal(env.Payload, &request); err != nil {
			helperDone <- fmt.Errorf("decode request: %w", err)
			return
		}
		receivedAt := time.Now()
		deadline := time.UnixMilli(request.DeadlineUnixMs)
		if request.DeadlineUnixMs <= 0 {
			helperDone <- fmt.Errorf("request deadline = %v, want positive deadline", deadline)
			return
		}
		if deadline.After(receivedAt.Add(timeout)) {
			helperDone <- fmt.Errorf("request deadline = %v, want no later than broker timeout", deadline)
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
