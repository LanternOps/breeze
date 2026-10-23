package monitoring

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"runtime"
	"testing"

	"github.com/breeze-rmm/agent/internal/svcquery"
)

// A service lookup that failed for any reason other than "the service does not
// exist" must not be reported as not_found (#7967: a running WinDefend was
// reported not_found because the open was denied).
func TestServiceErrorStatus(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want CheckStatus
	}{
		{"sentinel not found", svcquery.ErrServiceNotFound, StatusNotFound},
		{"wrapped not found", fmt.Errorf("svcquery: open service Foo: %w", svcquery.ErrServiceNotFound), StatusNotFound},
		{"access denied", errors.New("svcquery: open service WinDefend: Access is denied."), StatusError},
		{"scm connect failure", errors.New("svcquery: connect to SCM: Access is denied."), StatusError},
		{"query failure", errors.New("svcquery: query Foo: The handle is invalid."), StatusError},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := serviceErrorStatus(tt.err); got != tt.want {
				t.Errorf("serviceErrorStatus(%v) = %q, want %q", tt.err, got, tt.want)
			}
		})
	}
}

// darwin checkService maps svcquery errors through serviceErrorStatus: a
// launchctl that could not be run is an error, only a proven-absent label (no
// listing entry and no plist; svcquery wraps ErrServiceNotFound) is not_found.
// Older agents reported every darwin lookup error as not_found.
func TestServiceErrorStatus_DarwinLookups(t *testing.T) {
	if got := serviceErrorStatus(fmt.Errorf("svcquery: launchctl list: %w", errors.New("exit status 1"))); got != StatusError {
		t.Fatalf("launchctl list failure = %q, want error", got)
	}
	if got := serviceErrorStatus(fmt.Errorf("svcquery: service ctrld: %w", svcquery.ErrServiceNotFound)); got != StatusNotFound {
		t.Fatalf("absent label = %q, want not_found", got)
	}
}

func TestClassifyExec(t *testing.T) {
	tests := []struct {
		name   string
		ctxErr error
		err    error
		want   execOutcome
	}{
		{"success", nil, nil, execOK},
		{"non-zero exit", nil, &exec.ExitError{}, execExitNonZero},
		{"wrapped non-zero exit", nil, fmt.Errorf("run: %w", &exec.ExitError{}), execExitNonZero},
		{"binary missing", nil, exec.ErrNotFound, execFailed},
		{"timeout kill is not an exit status", context.DeadlineExceeded, &exec.ExitError{}, execFailed},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := classifyExec(tt.ctxErr, tt.err); got != tt.want {
				t.Fatalf("classifyExec = %v, want %v", got, tt.want)
			}
		})
	}
}

// Linux checkService: only systemd itself proving the unit absent is
// not_found; failing to run systemctl is an error (older agents said
// not_found, which a compliance pass would read as "uninstalled").
func TestSystemctlCheckResult(t *testing.T) {
	never := func() (string, execOutcome) {
		t.Helper()
		t.Fatal("systemctl show must not run")
		return "", execOK
	}
	load := func(out string, o execOutcome) func() (string, execOutcome) {
		return func() (string, execOutcome) { return out, o }
	}

	tests := []struct {
		name     string
		output   string
		isActive execOutcome
		exitCode int
		show     func() (string, execOutcome)
		want     CheckStatus
	}{
		{"active", "active", execOK, 0, never, StatusRunning},
		{"systemctl missing or timed out", "", execFailed, -1, never, StatusError},
		// Exit 1 is systemctl failing to reach systemd (a container or chroot
		// not booted with systemd): no answer about the unit at all.
		{"systemd unreachable", "", execExitNonZero, 1, never, StatusError},
		{"failed unit", "failed", execExitNonZero, 3, never, StatusStopped},
		{"deactivating", "deactivating", execExitNonZero, 3, never, StatusStopped},
		{"inactive and unit loaded", "inactive", execExitNonZero, 3, load("LoadState=loaded\n", execOK), StatusStopped},
		{"inactive and unit absent", "inactive", execExitNonZero, 3, load("LoadState=not-found\n", execOK), StatusNotFound},
		{"no such unit exit 4", "", execExitNonZero, 4, load("LoadState=not-found", execOK), StatusNotFound},
		{"inactive and show cannot run", "inactive", execExitNonZero, 3, load("", execFailed), StatusError},
		{"inactive and show exits non-zero", "inactive", execExitNonZero, 3, load("", execExitNonZero), StatusError},
		{"inactive and show prints nothing", "inactive", execExitNonZero, 3, load("", execOK), StatusError},
		{"activating and unit loaded", "activating", execExitNonZero, 3, load("LoadState=loaded", execOK), StatusStopped},
		{"masked unit is installed", "inactive", execExitNonZero, 3, load("LoadState=masked", execOK), StatusStopped},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := systemctlCheckResult("ctrld", tt.output, tt.isActive, tt.exitCode, "boom", tt.show)
			if got.Status != tt.want {
				t.Fatalf("status = %q, want %q (details %v)", got.Status, tt.want, got.Details)
			}
		})
	}
}

func TestExitCodeOf(t *testing.T) {
	if got := exitCodeOf(nil); got != 0 {
		t.Fatalf("exitCodeOf(nil) = %d", got)
	}
	if got := exitCodeOf(errors.New("not an exit")); got != -1 {
		t.Fatalf("exitCodeOf(plain) = %d, want -1", got)
	}
	if runtime.GOOS == "windows" {
		return
	}
	err := exec.Command("sh", "-c", "exit 3").Run() // constant script, no input
	if got := exitCodeOf(err); got != 3 {
		t.Fatalf("exitCodeOf(exit 3) = %d (err %v)", got, err)
	}
}
