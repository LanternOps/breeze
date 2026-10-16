package main

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/desktop"
)

func stubCaptureBackend(t *testing.T, euid int) (resets, pins *int) {
	t.Helper()
	saveEUID, saveReset, savePin, saveVerdict := geteuidFn, resetSCKVerdictFn, pinCoreGraphicsFn, sckVerdictFn
	t.Cleanup(func() {
		geteuidFn, resetSCKVerdictFn, pinCoreGraphicsFn, sckVerdictFn = saveEUID, saveReset, savePin, saveVerdict
	})
	resets, pins = new(int), new(int)
	geteuidFn = func() int { return euid }
	resetSCKVerdictFn = func() (string, bool, error) { *resets++; return "/Users/u/v.json", true, nil }
	pinCoreGraphicsFn = func() (string, error) { *pins++; return "/Users/u/v.json", nil }
	sckVerdictFn = func() desktop.ScreenCaptureKitVerdictStatus {
		return desktop.ScreenCaptureKitVerdictStatus{Supported: true, Present: true, Reason: "operator"}
	}
	return resets, pins
}

// The verdict is per console user; as root these would edit /var/root's copy,
// which nothing reads, and report success.
func TestCaptureBackendCommands_RefuseRoot(t *testing.T) {
	resets, pins := stubCaptureBackend(t, 0)
	var w bytes.Buffer
	for name, run := range map[string]func() error{
		"show":  func() error { return runCaptureBackendShow(&w) },
		"reset": func() error { return runCaptureBackendReset(&w) },
		"pin":   func() error { return runCaptureBackendPin(&w) },
	} {
		if err := run(); !errors.Is(err, errCaptureBackendAsRoot) {
			t.Fatalf("%s as root = %v, want errCaptureBackendAsRoot", name, err)
		}
	}
	if *resets != 0 || *pins != 0 {
		t.Fatalf("root ran reset=%d pin=%d, want 0/0", *resets, *pins)
	}
}

func TestCaptureBackendCommands_AsConsoleUser(t *testing.T) {
	resets, pins := stubCaptureBackend(t, 501)
	var w bytes.Buffer
	if err := runCaptureBackendShow(&w); err != nil || !strings.Contains(w.String(), `"operator"`) {
		t.Fatalf("show = %v, %q", err, w.String())
	}
	if err := runCaptureBackendReset(&w); err != nil || *resets != 1 {
		t.Fatalf("reset = %v (calls %d)", err, *resets)
	}
	if err := runCaptureBackendPin(&w); err != nil || *pins != 1 {
		t.Fatalf("pin = %v (calls %d)", err, *pins)
	}
}

func TestCaptureBackendCommands_SurfaceUnsupported(t *testing.T) {
	stubCaptureBackend(t, 501)
	resetSCKVerdictFn = func() (string, bool, error) { return "", false, desktop.ErrCaptureVerdictUnsupported }
	var w bytes.Buffer
	if err := runCaptureBackendReset(&w); !errors.Is(err, desktop.ErrCaptureVerdictUnsupported) {
		t.Fatalf("reset = %v, want ErrCaptureVerdictUnsupported", err)
	}
}
