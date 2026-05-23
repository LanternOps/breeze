package heartbeat

import (
	"errors"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

// TestPrefetchUserHelper_HappyPath covers the success branch: the injected
// downloader returns a temp path with no error, and prefetchUserHelper builds
// a *BinaryPair pointing the helper-restart script at
// <agent-dir>/breeze-user-helper.exe.
func TestPrefetchUserHelper_HappyPath(t *testing.T) {
	tempPath := filepath.Join(t.TempDir(), "breeze-user-helper-dl-12345")
	var calls atomic.Int32
	h := &Heartbeat{
		config:         &config.Config{},
		agentVersion:   "1.2.3",
		userHelperGOOS: "windows",
		userHelperDownloader: func(targetVersion string) (string, error) {
			calls.Add(1)
			if targetVersion != "1.2.4" {
				t.Fatalf("expected targetVersion=1.2.4, got %q", targetVersion)
			}
			return tempPath, nil
		},
	}

	binaryPath := "/opt/breeze/breeze-agent"
	pair := h.prefetchUserHelper("1.2.4", binaryPath)
	if pair == nil {
		t.Fatal("expected non-nil BinaryPair on happy path")
	}
	if pair.Temp != tempPath {
		t.Fatalf("Temp: expected %q, got %q", tempPath, pair.Temp)
	}
	wantTarget := filepath.Join(filepath.Dir(binaryPath), "breeze-user-helper.exe")
	if pair.Target != wantTarget {
		t.Fatalf("Target: expected %q, got %q", wantTarget, pair.Target)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("downloader call count: expected 1, got %d", got)
	}
}

// TestPrefetchUserHelper_DownloadFails covers the non-fatal failure branch:
// downloader returns an error (404 from pre-#816 release, transient network
// error, checksum mismatch, etc.). prefetchUserHelper must return nil so the
// caller proceeds with an agent-only upgrade — the entire reason PR #845
// exists.
func TestPrefetchUserHelper_DownloadFails(t *testing.T) {
	var calls atomic.Int32
	h := &Heartbeat{
		config:         &config.Config{},
		agentVersion:   "1.2.3",
		userHelperGOOS: "windows",
		userHelperDownloader: func(targetVersion string) (string, error) {
			calls.Add(1)
			return "", errors.New("404 status: not found")
		},
	}

	pair := h.prefetchUserHelper("1.2.4", "/opt/breeze/breeze-agent")
	if pair != nil {
		t.Fatalf("expected nil BinaryPair on download failure, got %+v", pair)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("downloader should be called exactly once even on failure, got %d", got)
	}
}

// TestPrefetchUserHelper_NonWindows verifies the prefetch is a no-op on
// non-Windows runtimes. Non-Windows agents never spawn user-helper sessions,
// so the download would be pointless work + needless server load.
func TestPrefetchUserHelper_NonWindows(t *testing.T) {
	var calls atomic.Int32
	for _, goos := range []string{"linux", "darwin"} {
		t.Run(goos, func(t *testing.T) {
			h := &Heartbeat{
				config:         &config.Config{},
				agentVersion:   "1.2.3",
				userHelperGOOS: goos,
				userHelperDownloader: func(targetVersion string) (string, error) {
					calls.Add(1)
					return "/tmp/should-not-be-called", nil
				},
			}
			pair := h.prefetchUserHelper("1.2.4", "/opt/breeze/breeze-agent")
			if pair != nil {
				t.Fatalf("expected nil BinaryPair on non-Windows runtime %s, got %+v", goos, pair)
			}
		})
	}
	if got := calls.Load(); got != 0 {
		t.Fatalf("downloader must not be invoked on non-Windows runtimes, got %d calls", got)
	}
}

// TestPrefetchUserHelper_DefaultGOOSMatchesRuntime is a smoke test: when no
// override is set, the function falls back to runtime.GOOS. On non-Windows
// CI hosts this means a nil return without ever touching the network — which
// is exactly the safety property we want.
func TestPrefetchUserHelper_DefaultGOOSMatchesRuntime(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test asserts non-Windows runtime safety; would need network on Windows")
	}
	h := &Heartbeat{
		config:       &config.Config{},
		agentVersion: "1.2.3",
		// No userHelperGOOS override, no userHelperDownloader injection.
		// On a non-Windows host this must short-circuit before constructing
		// the real updater (which would otherwise try to hit ServerURL).
	}
	pair := h.prefetchUserHelper("1.2.4", "/opt/breeze/breeze-agent")
	if pair != nil {
		t.Fatalf("expected nil BinaryPair on non-Windows runtime, got %+v", pair)
	}
}
