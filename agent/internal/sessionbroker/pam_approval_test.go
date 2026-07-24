package sessionbroker

import (
	"encoding/json"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestRequestPamApprovalReturnsDialogResult(t *testing.T) {
	session, clientIPC := createPamApprovalTestSession()
	defer func() { _ = session.Close() }()
	defer func() { _ = clientIPC.Close() }()

	go func() {
		clientIPC.SetReadDeadline(time.Now().Add(2 * time.Second))
		env, err := clientIPC.Recv()
		if err != nil {
			t.Errorf("client recv: %v", err)
			return
		}
		if env.Type != ipc.TypePamRequestDialog {
			t.Errorf("request type = %q, want %q", env.Type, ipc.TypePamRequestDialog)
			return
		}
		var req ipc.PamRequestDialog
		if err := json.Unmarshal(env.Payload, &req); err != nil {
			t.Errorf("decode request: %v", err)
			return
		}
		if req.ExePath != `C:\Windows\System32\cmd.exe` {
			t.Errorf("ExePath = %q", req.ExePath)
			return
		}
		if err := clientIPC.SendTyped(env.ID, ipc.TypePamDialogResult, ipc.PamDialogResult{Approved: true}); err != nil {
			t.Errorf("client send: %v", err)
		}
	}()
	go session.RecvLoop(func(s *Session, env *ipc.Envelope) {})

	got, err := (&Broker{}).RequestPamApproval(session, "pam-1", ipc.PamRequestDialog{
		ExePath: `C:\Windows\System32\cmd.exe`,
	}, 2*time.Second)
	if err != nil {
		t.Fatalf("RequestPamApproval: %v", err)
	}
	if !got.Approved || got.DismissedByUser {
		t.Fatalf("RequestPamApproval result = %+v, want approved", got)
	}
}

func TestRequestPamApprovalTimeoutDeniesAndDismisses(t *testing.T) {
	session, clientIPC := createPamApprovalTestSession()
	defer func() { _ = session.Close() }()
	defer func() { _ = clientIPC.Close() }()

	go func() {
		clientIPC.SetReadDeadline(time.Now().Add(2 * time.Second))
		if _, err := clientIPC.Recv(); err != nil {
			t.Errorf("client recv: %v", err)
		}
	}()
	go session.RecvLoop(func(s *Session, env *ipc.Envelope) {})

	got, err := (&Broker{}).RequestPamApproval(session, "pam-timeout", ipc.PamRequestDialog{}, 25*time.Millisecond)
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if got.Approved || !got.DismissedByUser {
		t.Fatalf("timeout result = %+v, want deny+dismiss", got)
	}
}

func TestRequestPamApprovalRequiresSystemPamSession(t *testing.T) {
	tests := []struct {
		name    string
		role    ipc.HelperRole
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
			serverConn, clientConn := net.Pipe()
			defer func() { _ = serverConn.Close() }()
			defer func() { _ = clientConn.Close() }()
			if err := serverConn.SetWriteDeadline(time.Now().Add(100 * time.Millisecond)); err != nil {
				t.Fatalf("set write deadline: %v", err)
			}

			session := NewSession(ipc.NewConn(serverConn), 1000, "1000", "testuser", "x11:0", "test-session-1", tc.scopes)
			session.HelperRole = tc.role
			got, err := (&Broker{}).RequestPamApproval(session, "pam-rejected", ipc.PamRequestDialog{}, time.Millisecond)
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("RequestPamApproval error = %v, want substring %q", err, tc.wantErr)
			}
			if got.Approved || !got.DismissedByUser {
				t.Fatalf("rejected result = %+v, want deny+dismiss", got)
			}
		})
	}
}

func createPamApprovalTestSession() (*Session, *ipc.Conn) {
	serverConn, clientConn := net.Pipe()
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)
	session := NewSession(serverIPC, 1000, "1000", "testuser", "x11:0", "test-session-1", []string{ipc.ScopePam})
	session.HelperRole = ipc.HelperRoleSystem
	return session, clientIPC
}
