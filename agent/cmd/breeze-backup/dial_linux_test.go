//go:build linux

package main

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// breeze-backup runs as root and must not take a non-root listener for the
// broker. CI runs unprivileged, so a listener this test owns is one.
func TestDialIPC_RefusesNonRootBroker(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("running as root: a self-owned listener is a root server")
	}
	dir, err := os.MkdirTemp("", "bk")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	sock := filepath.Join(dir, "a.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		if c, err := ln.Accept(); err == nil {
			_ = c.Close()
		}
	}()

	conn, err := dialIPC(sock)
	if conn != nil {
		_ = conn.Close()
		t.Fatal("dialIPC accepted a non-root broker")
	}
	if !errors.Is(err, ipc.ErrUnixServerNotRoot) {
		t.Fatalf("dialIPC err = %v, want ErrUnixServerNotRoot", err)
	}
}
