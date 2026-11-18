//go:build !windows

package userhelper

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// trustTestServer lets a client talk to a listener owned by this unprivileged
// test process, which the Linux verifier would otherwise refuse as non-root.
func trustTestServer(c *Client) *Client {
	c.serverVerifier = func(net.Conn, string) error { return nil }
	return c
}

func listenShortUnix(t *testing.T) (net.Listener, string) {
	t.Helper()
	dir, err := os.MkdirTemp("", "sv")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	sock := filepath.Join(dir, "h.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	return ln, sock
}

// A server the verifier refuses is never handed to the auth handshake: the
// dial fails with the verifier's error and the connection is closed, so the
// server reads EOF rather than an auth_request.
func TestDialIPC_RefusedServerIsClosedBeforeAuth(t *testing.T) {
	ln, sock := listenShortUnix(t)
	sentinel := errors.New("server refused")
	got := make(chan error, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			got <- err
			return
		}
		defer c.Close()
		_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
		buf := make([]byte, 1)
		_, err = c.Read(buf)
		got <- err
	}()

	client := NewWithOptions(sock, ipc.HelperRoleUser, ipc.HelperBinaryUserHelper, "")
	var verifiedPath string
	client.serverVerifier = func(conn net.Conn, path string) error {
		verifiedPath = path
		return sentinel
	}
	conn, err := client.dialIPC()
	if conn != nil {
		t.Fatal("dialIPC returned a connection to a refused server")
	}
	if !errors.Is(err, sentinel) {
		t.Fatalf("dialIPC err = %v, want the verifier's error", err)
	}
	if verifiedPath != sock {
		t.Fatalf("verifier saw path %q, want %q", verifiedPath, sock)
	}
	select {
	case readErr := <-got:
		if readErr == nil {
			t.Fatal("server read a byte from a refused connection")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server never saw the refused connection close")
	}
}

func TestDialIPC_AcceptedServerIsReturned(t *testing.T) {
	ln, sock := listenShortUnix(t)
	go func() {
		c, err := ln.Accept()
		if err == nil {
			time.Sleep(100 * time.Millisecond)
			_ = c.Close()
		}
	}()
	client := NewWithOptions(sock, ipc.HelperRoleUser, ipc.HelperBinaryUserHelper, "")
	client.serverVerifier = func(net.Conn, string) error { return nil }
	conn, err := client.dialIPC()
	if err != nil {
		t.Fatalf("dialIPC: %v", err)
	}
	_ = conn.Close()
}

// Every client gets the platform verifier by default; nothing has to opt in.
func TestNewClientInstallsPlatformServerVerifier(t *testing.T) {
	client := NewWithOptions("/nonexistent.sock", ipc.HelperRoleUser, ipc.HelperBinaryUserHelper, "")
	if client.serverVerifier == nil {
		t.Fatal("client has no server verifier")
	}
}
