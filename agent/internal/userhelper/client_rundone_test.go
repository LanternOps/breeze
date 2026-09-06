//go:build !windows

package userhelper

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// serveOneHelperHandshake accepts a single helper connection on ln, completes
// the auth handshake, and returns a function that drops the connection the way
// a restarting agent would.
func serveOneHelperHandshake(t *testing.T, ln net.Listener, accepted chan<- struct{}) chan<- struct{} {
	t.Helper()

	drop := make(chan struct{})
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()

		srv := ipc.NewConn(conn)
		if _, err := srv.Recv(); err != nil { // the auth request
			return
		}

		key := make([]byte, 32)
		if _, err := rand.Read(key); err != nil {
			return
		}
		payload, err := json.Marshal(ipc.AuthResponse{
			Accepted:      true,
			SessionKey:    hex.EncodeToString(key),
			AgentID:       "agent-under-test",
			AllowedScopes: []string{"*"},
		})
		if err != nil {
			return
		}
		if err := srv.Send(&ipc.Envelope{Type: ipc.TypeAuthResponse, ID: "auth", Payload: payload}); err != nil {
			return
		}
		srv.SetSessionKey(key)

		close(accepted)
		<-drop // hold the connection open until the test drops it
	}()
	return drop
}

// TestRunTearsDownPerRunGoroutinesWhenTheConnectionDrops pins the contract the
// reconnect supervisor depends on: goroutines started by Run must stop when
// Run returns, even though the supervisor discards the client WITHOUT calling
// Stop.
//
// Keying those goroutines off c.stopChan alone was safe only while any IPC
// error killed the process. Now that the helper stays resident and reconnects
// (#4194), a goroutine that ignores a returning Run is stranded holding a dead
// *ipc.Conn — for the TCC check loop that is up to three 60-minute intervals,
// and a fresh orphan accumulates on every reconnect.
func TestRunTearsDownPerRunGoroutinesWhenTheConnectionDrops(t *testing.T) {
	// Not t.TempDir(): its path blows past the ~104-byte sun_path limit on
	// macOS and bind fails with EINVAL.
	dir, err := os.MkdirTemp("", "bzh")
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })

	socketPath := filepath.Join(dir, "h.sock")
	ln, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer func() { _ = ln.Close() }()

	// Capture the channel Run hands to its per-run goroutines, and report
	// when the loop actually observes it.
	loopReturned := make(chan struct{})
	restore := runTCCCheckLoop
	t.Cleanup(func() { runTCCCheckLoop = restore })
	runTCCCheckLoop = func(_ *ipc.Conn, stop chan struct{}, _ string, _ func() bool) {
		<-stop
		close(loopReturned)
	}

	accepted := make(chan struct{})
	drop := serveOneHelperHandshake(t, ln, accepted)

	client := NewWithOptions(socketPath, ipc.HelperRoleUser, ipc.HelperBinaryDesktopHelper, ipc.DesktopContextUserSession)

	runReturned := make(chan error, 1)
	go func() { runReturned <- client.Run() }()

	select {
	case <-accepted:
	case <-time.After(5 * time.Second):
		t.Fatal("helper never completed the auth handshake")
	}

	// The supervisor reads AuthenticatedAt to decide whether a connection was
	// stable enough to reset the backoff, so it has to be set on a real
	// successful handshake.
	waitForCondition(t, 5*time.Second, func() bool {
		return !client.AuthenticatedAt().IsZero()
	})

	// Drop the connection the way a restarting agent does. Crucially the test
	// never calls client.Stop() — that is exactly the supervisor's behaviour.
	close(drop)

	select {
	case err := <-runReturned:
		if err == nil {
			t.Error("Run should report the dropped connection as an error so the supervisor retries")
		}
	case <-time.After(15 * time.Second):
		t.Fatal("Run did not return after the connection dropped")
	}

	select {
	case <-loopReturned:
	case <-time.After(5 * time.Second):
		t.Fatal("per-run goroutine outlived Run: it is still holding a dead *ipc.Conn, " +
			"and one more will leak on every reconnect")
	}
}
