package heartbeat

import (
	"errors"
	"runtime"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/patching"
)

// #10250: the 60 s wait exists for macOS softwareupdate, which keeps working
// after the install call returns. Windows and Linux installs are synchronous,
// so they only get a short settle before the rescan.
func TestPostInstallRescanDelayOnlyWaitsLongOnMacOS(t *testing.T) {
	cases := map[string]time.Duration{
		"darwin":  60 * time.Second,
		"windows": 5 * time.Second,
		"linux":   5 * time.Second,
	}
	for goos, want := range cases {
		if got := postInstallRescanDelay(goos); got != want {
			t.Errorf("postInstallRescanDelay(%q) = %v, want %v", goos, got, want)
		}
	}
}

type rescanCall struct {
	delay time.Duration
}

func captureRescans(t *testing.T) *[]rescanCall {
	t.Helper()
	calls := &[]rescanCall{}
	prev := schedulePostInstallRescan
	schedulePostInstallRescan = func(_ *Heartbeat, delay time.Duration) {
		*calls = append(*calls, rescanCall{delay: delay})
	}
	t.Cleanup(func() { schedulePostInstallRescan = prev })
	return calls
}

func TestExecutePatchInstallSchedulesRescanWithPlatformDelay(t *testing.T) {
	calls := captureRescans(t)
	provider := &heartbeatMockProvider{id: "apt"}
	h := &Heartbeat{patchMgr: patching.NewPatchManager(provider)}

	h.executePatchInstallCommand(map[string]any{"patchIds": []any{"openssl"}}, false)

	if len(*calls) != 1 {
		t.Fatalf("expected one post-install rescan, got %d", len(*calls))
	}
	if want := postInstallRescanDelay(runtime.GOOS); (*calls)[0].delay != want {
		t.Fatalf("rescan delay = %v, want %v for %s", (*calls)[0].delay, want, runtime.GOOS)
	}
}

// A fully failed install used to skip the rescan entirely, leaving the
// inventory (and the dashboard) on whatever the last scheduled scan saw.
func TestExecutePatchInstallRescansAfterAFullyFailedInstall(t *testing.T) {
	calls := captureRescans(t)
	provider := &heartbeatMockProvider{id: "apt", installErr: errors.New("install failed")}
	h := &Heartbeat{patchMgr: patching.NewPatchManager(provider)}

	result := h.executePatchInstallCommand(map[string]any{"patchIds": []any{"openssl"}}, false)

	if result.Status != "failed" {
		t.Fatalf("expected failed status, got %s", result.Status)
	}
	if len(*calls) != 1 {
		t.Fatalf("expected a post-install rescan after a failed install, got %d", len(*calls))
	}
}

func TestExecutePatchRollbackFailureStillRescans(t *testing.T) {
	calls := captureRescans(t)
	provider := &heartbeatMockProvider{id: "apt", uninstallErr: errors.New("uninstall failed")}
	h := &Heartbeat{patchMgr: patching.NewPatchManager(provider)}

	h.executePatchInstallCommand(map[string]any{"patchIds": []any{"openssl"}}, true)

	if len(*calls) != 1 {
		t.Fatalf("expected a post-rollback rescan after a failed rollback, got %d", len(*calls))
	}
}

func TestExecutePatchInstallWithNoPatchesDoesNotRescan(t *testing.T) {
	calls := captureRescans(t)
	provider := &heartbeatMockProvider{id: "apt"}
	h := &Heartbeat{patchMgr: patching.NewPatchManager(provider)}

	h.executePatchInstallCommand(map[string]any{"patchIds": []any{}}, false)

	if len(*calls) != 0 {
		t.Fatalf("expected no rescan when nothing was attempted, got %d", len(*calls))
	}
}

// The scheduled rescan must still honour agent shutdown during the wait.
func TestPostInstallRescanCancelledByShutdown(t *testing.T) {
	h := &Heartbeat{stopChan: make(chan struct{})}
	done := make(chan struct{})
	go func() {
		h.runPostInstallRescan(time.Hour)
		close(done)
	}()
	close(h.stopChan)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("post-install rescan did not return after shutdown")
	}
}
