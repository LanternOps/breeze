//go:build windows

package winsvcinstall

import (
	"errors"
	"fmt"
	"testing"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

// A reconfigured service must get the same command line CreateService would
// have produced. Program Files contains a space, so unquoted the SCM would read
// the path as an executable plus a stray "Files\breeze-agent.exe" argument.
func TestBinaryPathNameQuotesPathsWithSpaces(t *testing.T) {
	got := binaryPathName(`C:\Program Files\Breeze\breeze-agent.exe`, "run")
	want := `"C:\Program Files\Breeze\breeze-agent.exe" run`
	if got != want {
		t.Fatalf("binaryPathName = %s, want %s", got, want)
	}
}

func TestBinaryPathNameWithoutArgs(t *testing.T) {
	got := binaryPathName(`C:\Breeze\breeze-watchdog.exe`)
	if got != `C:\Breeze\breeze-watchdog.exe` {
		t.Fatalf("binaryPathName = %s", got)
	}
}

// STOP_PENDING must NOT map to STOPPED: a service on its way down is still
// holding its image open, so treating it as stopped would let the installer
// stage a binary over a locked file.
func TestNeutralStateMapping(t *testing.T) {
	cases := []struct {
		in   svc.State
		want State
	}{
		{svc.Stopped, StateStopped},
		{svc.StartPending, StateStartPending},
		{svc.Running, StateRunning},
		{svc.StopPending, StateOther},
		{svc.Paused, StateOther},
		{svc.PausePending, StateOther},
		{svc.ContinuePending, StateOther},
	}
	for _, c := range cases {
		if got := neutralState(c.in); got != c.want {
			t.Errorf("neutralState(%d) = %v, want %v", c.in, got, c.want)
		}
	}
}

// The SCM's ERROR_SERVICE_ALREADY_RUNNING (1056), bare or wrapped, must reach
// startAndWait as ErrAlreadyRunning; anything else must pass through (#7474).
func TestStartRequestErrorMapsAlreadyRunning(t *testing.T) {
	if got := startRequestError(windows.ERROR_SERVICE_ALREADY_RUNNING); !errors.Is(got, ErrAlreadyRunning) {
		t.Fatalf("startRequestError(ERROR_SERVICE_ALREADY_RUNNING) = %v, want ErrAlreadyRunning", got)
	}
	wrapped := fmt.Errorf("start: %w", windows.ERROR_SERVICE_ALREADY_RUNNING)
	if got := startRequestError(wrapped); !errors.Is(got, ErrAlreadyRunning) {
		t.Fatalf("startRequestError(wrapped) = %v, want ErrAlreadyRunning", got)
	}
	if got := startRequestError(nil); got != nil {
		t.Fatalf("startRequestError(nil) = %v, want nil", got)
	}
	denied := windows.ERROR_ACCESS_DENIED
	if got := startRequestError(denied); !errors.Is(got, denied) || errors.Is(got, ErrAlreadyRunning) {
		t.Fatalf("startRequestError(ERROR_ACCESS_DENIED) = %v, want it unchanged", got)
	}
}
