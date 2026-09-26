//go:build !windows

package userhelper

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// serveHandshakeAndCollectCaps completes the helper auth handshake and then
// forwards every capabilities message the helper sends. Closing the returned
// drop channel ends the connection.
func serveHandshakeAndCollectCaps(t *testing.T, ln net.Listener) (<-chan ipc.Capabilities, chan<- struct{}) {
	t.Helper()
	capsCh := make(chan ipc.Capabilities, 8)
	drop := make(chan struct{})
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		go func() { <-drop; _ = conn.Close() }()

		srv := ipc.NewConn(conn)
		if _, err := srv.Recv(); err != nil {
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
			if env.Type != ipc.TypeCapabilities {
				continue
			}
			var caps ipc.Capabilities
			if json.Unmarshal(env.Payload, &caps) == nil {
				capsCh <- caps
			}
		}
	}()
	return capsCh, drop
}

// startRunForReprobeTest runs a desktop-helper Client against a fake broker.
// Callers must drop the connection and wait on the returned done channel,
// which closes after Run and its TCC goroutine have both exited, so the seam
// restores in t.Cleanup never race a goroutine still reading them.
func startRunForReprobeTest(t *testing.T, canCaptureAtConnect *atomic.Bool) (*Client, <-chan ipc.Capabilities, chan<- struct{}, <-chan struct{}) {
	t.Helper()
	dir, err := os.MkdirTemp("", "bzr")
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	ln, err := net.Listen("unix", filepath.Join(dir, "h.sock"))
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })

	restoreTCC, restoreDetect, restoreGOOS := runTCCCheckLoop, detectCapabilitiesFn, captureReprobeGOOS
	t.Cleanup(func() {
		runTCCCheckLoop, detectCapabilitiesFn, captureReprobeGOOS = restoreTCC, restoreDetect, restoreGOOS
	})
	tccReturned := make(chan struct{})
	runTCCCheckLoop = func(_ *ipc.Conn, stop chan struct{}, _ string, _ func() bool) {
		<-stop
		close(tccReturned)
	}
	captureReprobeGOOS = "darwin"
	detectCapabilitiesFn = func(string, string) ipc.Capabilities {
		return ipc.Capabilities{CanCapture: canCaptureAtConnect.Load(), DisplayServer: "quartz"}
	}

	capsCh, drop := serveHandshakeAndCollectCaps(t, ln)
	client := NewWithOptions(filepath.Join(dir, "h.sock"), ipc.HelperRoleUser,
		ipc.HelperBinaryDesktopHelper, ipc.DesktopContextUserSession)
	done := make(chan struct{})
	go func() {
		_ = client.Run()
		<-tccReturned
		close(done)
	}()
	return client, capsCh, drop, done
}

func waitRunDone(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("Run (or its TCC goroutine) did not return after the connection dropped")
	}
}

func recvCaps(t *testing.T, ch <-chan ipc.Capabilities) ipc.Capabilities {
	t.Helper()
	select {
	case c := <-ch:
		return c
	case <-time.After(5 * time.Second):
		t.Fatal("no capabilities message reached the broker side")
		return ipc.Capabilities{}
	}
}

// #6105: Run must start the re-probe when the connect-time probe fails, wire
// it to the real detect/send path, and stop it when Run ends.
func TestRun_StartsCaptureReprobeWhenConnectProbeFails(t *testing.T) {
	var canCapture atomic.Bool

	started := make(chan captureReprobeConfig, 1)
	loopReturned := make(chan struct{})
	restore := runCaptureReprobe
	t.Cleanup(func() { runCaptureReprobe = restore })
	runCaptureReprobe = func(done <-chan struct{}, cfg captureReprobeConfig) {
		started <- cfg
		<-done
		close(loopReturned)
	}

	_, capsCh, drop, runDone := startRunForReprobeTest(t, &canCapture)

	if first := recvCaps(t, capsCh); first.CanCapture {
		t.Fatalf("connect-time caps = %+v, want CanCapture=false", first)
	}

	var cfg captureReprobeConfig
	select {
	case cfg = <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not start the capture re-probe after a failed connect probe")
	}
	if cfg.initialDelay != captureReprobeInitialDelay || cfg.maxDelay != captureReprobeMaxDelay {
		t.Fatalf("re-probe schedule = %v..%v, want %v..%v",
			cfg.initialDelay, cfg.maxDelay, captureReprobeInitialDelay, captureReprobeMaxDelay)
	}
	if cfg.canProbe == nil || !cfg.canProbe() {
		t.Fatal("canProbe must allow probing while no desktop session is active")
	}

	// Capture recovers: the loop's detect must see it and its send must reach
	// the broker side of the real connection.
	canCapture.Store(true)
	recovered := cfg.detect()
	if !recovered.CanCapture {
		t.Fatal("detect did not go through the helper's capability detection")
	}
	if err := cfg.send(recovered); err != nil {
		t.Fatalf("send: %v", err)
	}
	if resent := recvCaps(t, capsCh); !resent.CanCapture {
		t.Fatalf("re-sent caps = %+v, want CanCapture=true", resent)
	}

	close(drop)
	waitRunDone(t, runDone)
	select {
	case <-loopReturned:
	case <-time.After(5 * time.Second):
		t.Fatal("capture re-probe outlived Run")
	}
}

func TestRun_NoCaptureReprobeWhenConnectProbeSucceeds(t *testing.T) {
	var canCapture atomic.Bool
	canCapture.Store(true)

	var invoked atomic.Bool
	restore := runCaptureReprobe
	t.Cleanup(func() { runCaptureReprobe = restore })
	runCaptureReprobe = func(<-chan struct{}, captureReprobeConfig) { invoked.Store(true) }

	client, capsCh, drop, runDone := startRunForReprobeTest(t, &canCapture)
	if first := recvCaps(t, capsCh); !first.CanCapture {
		t.Fatalf("connect-time caps = %+v, want CanCapture=true", first)
	}
	waitForCondition(t, 5*time.Second, func() bool { return !client.AuthenticatedAt().IsZero() })
	// Give Run time to pass the wiring point before asserting absence.
	time.Sleep(200 * time.Millisecond)
	close(drop)
	waitRunDone(t, runDone)
	if invoked.Load() {
		t.Fatal("re-probe started although the connect-time probe succeeded")
	}
}
