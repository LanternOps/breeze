package userhelper

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// sendRejectionEnvelope sends a pre-auth reject envelope over conn using
// ipc.Conn framing (handles HMAC + length-prefix).
func sendRejectionEnvelope(t *testing.T, conn net.Conn, env *ipc.Envelope) {
	t.Helper()
	c := ipc.NewConn(conn)
	if err := c.Send(env); err != nil {
		t.Fatalf("sendRejectionEnvelope: %v", err)
	}
}

// TestAuthenticate_PermanentPreAuthReject verifies that authenticate() returns
// a *PermanentRejectError when the broker sends TypePreAuthReject{Permanent: true}.
func TestAuthenticate_PermanentPreAuthReject(t *testing.T) {
	t.Parallel()

	clientConn, serverConn := net.Pipe()
	defer clientConn.Close()
	defer serverConn.Close()

	// Server goroutine: read one envelope (the auth request), then send back a
	// permanent pre-auth rejection.
	go func() {
		srvIPC := ipc.NewConn(serverConn)
		_, _ = srvIPC.Recv() // consume the auth_request (may error on conn close — ignore)

		rej := ipc.PreAuthReject{
			Code:      "binary_path_unknown",
			Reason:    "binary not registered with broker",
			Permanent: true,
		}
		payload, _ := json.Marshal(rej)
		env := &ipc.Envelope{
			Type:    ipc.TypePreAuthReject,
			ID:      "0",
			Payload: payload,
		}
		_ = srvIPC.Send(env)
	}()

	// Wire the client-side conn directly (bypass dialIPC).
	c := New("/unused", ipc.HelperRoleSystem)
	c.conn = ipc.NewConn(clientConn)

	err := c.authenticate()
	if err == nil {
		t.Fatal("authenticate(): expected error, got nil")
	}

	var permErr *PermanentRejectError
	if !errors.As(err, &permErr) {
		t.Fatalf("authenticate(): error is %T (%v), want *PermanentRejectError", err, err)
	}
	if permErr.Code != "binary_path_unknown" {
		t.Errorf("PermanentRejectError.Code = %q, want %q", permErr.Code, "binary_path_unknown")
	}
	if permErr.Reason != "binary not registered with broker" {
		t.Errorf("PermanentRejectError.Reason = %q, want %q", permErr.Reason, "binary not registered with broker")
	}
}

// TestAuthenticate_TransientPreAuthReject verifies that authenticate() returns
// a plain (non-permanent) error when the broker sends TypePreAuthReject{Permanent: false}.
func TestAuthenticate_TransientPreAuthReject(t *testing.T) {
	t.Parallel()

	clientConn, serverConn := net.Pipe()
	defer clientConn.Close()
	defer serverConn.Close()

	// Server goroutine: read auth request, send transient (non-permanent) rejection.
	go func() {
		srvIPC := ipc.NewConn(serverConn)
		_, _ = srvIPC.Recv()

		rej := ipc.PreAuthReject{
			Code:      "rate_limited",
			Reason:    "too many connection attempts",
			Permanent: false,
		}
		payload, _ := json.Marshal(rej)
		env := &ipc.Envelope{
			Type:    ipc.TypePreAuthReject,
			ID:      "0",
			Payload: payload,
		}
		_ = srvIPC.Send(env)
	}()

	c := New("/unused", ipc.HelperRoleSystem)
	c.conn = ipc.NewConn(clientConn)

	err := c.authenticate()
	if err == nil {
		t.Fatal("authenticate(): expected error for transient rejection, got nil")
	}

	var permErr *PermanentRejectError
	if errors.As(err, &permErr) {
		t.Errorf("authenticate(): got *PermanentRejectError for transient rejection, want plain error")
	}
}

// TestAuthenticate_AuthResponsePermanent verifies that authenticate() returns
// a *PermanentRejectError when the broker sends an AuthResponse with
// Accepted=false and Permanent=true (auth-rejected path, not pre-auth-reject).
func TestAuthenticate_AuthResponsePermanent(t *testing.T) {
	t.Parallel()

	clientConn, serverConn := net.Pipe()
	defer clientConn.Close()
	defer serverConn.Close()

	go func() {
		srvIPC := ipc.NewConn(serverConn)
		_, _ = srvIPC.Recv()

		resp := ipc.AuthResponse{
			Accepted:  false,
			Reason:    "SID mismatch",
			Permanent: true,
		}
		payload, _ := json.Marshal(resp)
		env := &ipc.Envelope{
			Type:    ipc.TypeAuthResponse,
			ID:      "0",
			Payload: payload,
		}
		_ = srvIPC.Send(env)
	}()

	c := New("/unused", ipc.HelperRoleSystem)
	c.conn = ipc.NewConn(clientConn)

	err := c.authenticate()
	if err == nil {
		t.Fatal("authenticate(): expected error for permanent auth rejection, got nil")
	}

	var permErr *PermanentRejectError
	if !errors.As(err, &permErr) {
		t.Fatalf("authenticate(): error is %T (%v), want *PermanentRejectError", err, err)
	}
	if permErr.Code != "auth_rejected" {
		t.Errorf("PermanentRejectError.Code = %q, want %q", permErr.Code, "auth_rejected")
	}
}

// TestAuthenticate_ConnectionClosed verifies that authenticate() returns an
// error (not panic) when the server closes the connection without sending anything.
func TestAuthenticate_ConnectionClosed(t *testing.T) {
	t.Parallel()

	clientConn, serverConn := net.Pipe()
	defer clientConn.Close()

	// Server immediately closes after reading the auth request.
	go func() {
		srvIPC := ipc.NewConn(serverConn)
		_, _ = srvIPC.Recv()
		serverConn.Close()
	}()

	c := New("/unused", ipc.HelperRoleSystem)
	c.conn = ipc.NewConn(clientConn)

	err := c.authenticate()
	if err == nil {
		t.Fatal("authenticate(): expected error on closed connection, got nil")
	}
	// The error may be EOF, closed pipe, or network error — any is acceptable.
	// What matters is it's not a *PermanentRejectError.
	var permErr *PermanentRejectError
	if errors.As(err, &permErr) {
		t.Errorf("authenticate(): got *PermanentRejectError on connection close, want plain error")
	}
	// Log the actual error for diagnostic purposes.
	_ = io.EOF // imported for completeness
	t.Logf("authenticate() returned (expected): %v", err)
}
