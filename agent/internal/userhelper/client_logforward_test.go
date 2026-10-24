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

// TestRunPumpsInstalledLogForwarder pins the wiring that makes the #9266 relay
// do anything at all: once a helper authenticates, Client.Run drains the
// process-wide forwarder onto its connection — including a record queued
// before the connection existed, which is how a startup warning (an unopenable
// log file, say) reaches Agent Logs.
func TestRunPumpsInstalledLogForwarder(t *testing.T) {
	fwd := NewLogForwarder(8)
	prev := activeLogForwarder.Swap(fwd)
	t.Cleanup(func() { activeLogForwarder.Store(prev) })

	// Queued before the helper ever connects.
	fwd.Offer(entry("warn", "helper log file unavailable; logging to stdout only"))

	// Not t.TempDir(): its path blows past the ~104-byte sun_path limit on macOS.
	dir, err := os.MkdirTemp("", "bzl")
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

	got := make(chan ipc.HelperLogRecord, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		srv := ipc.NewConn(conn)
		if _, err := srv.Recv(); err != nil { // auth request
			return
		}
		key := make([]byte, 32)
		if _, err := rand.Read(key); err != nil {
			return
		}
		payload, _ := json.Marshal(ipc.AuthResponse{
			Accepted:      true,
			SessionKey:    hex.EncodeToString(key),
			AgentID:       "agent-under-test",
			AllowedScopes: []string{"*"},
		})
		if err := srv.Send(&ipc.Envelope{Type: ipc.TypeAuthResponse, ID: "auth", Payload: payload}); err != nil {
			return
		}
		srv.SetSessionKey(key)
		for {
			env, err := srv.Recv()
			if err != nil {
				return
			}
			if env.Type != ipc.TypeHelperLog {
				continue // capabilities etc.
			}
			var rec ipc.HelperLogRecord
			if json.Unmarshal(env.Payload, &rec) == nil {
				got <- rec
			}
			return
		}
	}()

	client := NewWithOptions(socketPath, ipc.HelperRoleUser, ipc.HelperBinaryUserHelper, "")
	go func() { _ = client.Run() }()
	t.Cleanup(client.Stop)

	select {
	case rec := <-got:
		if rec.Level != "warn" || rec.Message != "helper log file unavailable; logging to stdout only" {
			t.Fatalf("relayed record = %+v", rec)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Client.Run never pumped the installed log forwarder onto its connection")
	}
}
