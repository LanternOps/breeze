//go:build !windows

package userhelper

import (
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// TestStopConcurrentWithConnectHasNoDataRace pins the connMu contract: the
// reconnect supervisor's shutdown goroutine calls Stop() (which reads c.conn
// via currentConn) while the Run goroutine may still be inside connect()
// (which writes c.conn). Without the mutex those two accesses are an
// unsynchronized read/write pair — this test exists to make the race detector
// prove the guard is still there, so it only earns its keep under -race
// (the Test Agent (race) CI job). Verified red by mutation: stripping the
// connMu lock/unlock from connect/currentConn makes this fail under -race.
func TestStopConcurrentWithConnectHasNoDataRace(t *testing.T) {
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

	// Accept and immediately discard connections so dialIPC always succeeds.
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()

	// Many iterations so the write in connect and the read in Stop actually
	// overlap; the race detector flags the pair even on near misses.
	for i := 0; i < 50; i++ {
		client := NewWithOptions(socketPath, ipc.HelperRoleUser, ipc.HelperBinaryDesktopHelper, ipc.DesktopContextUserSession)

		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			if err := client.connect(); err != nil {
				t.Errorf("connect: %v", err)
			}
		}()
		go func() {
			defer wg.Done()
			client.Stop()
		}()
		wg.Wait()

		if conn := client.currentConn(); conn != nil {
			_ = conn.Close()
		}
	}
}
