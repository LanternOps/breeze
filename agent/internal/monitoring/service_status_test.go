package monitoring

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
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
	never := func() execOutcome { t.Helper(); t.Fatal("systemctl cat must not run"); return execOK }
	catExits := func() execOutcome { return execExitNonZero }
	catOK := func() execOutcome { return execOK }
	catFails := func() execOutcome { return execFailed }

	tests := []struct {
		name     string
		output   string
		isActive execOutcome
		cat      func() execOutcome
		want     CheckStatus
	}{
		{"active", "active", execOK, never, StatusRunning},
		{"systemctl missing or timed out", "", execFailed, never, StatusError},
		{"failed unit", "failed", execExitNonZero, never, StatusStopped},
		{"deactivating", "deactivating", execExitNonZero, never, StatusStopped},
		{"inactive and unit exists", "inactive", execExitNonZero, catOK, StatusStopped},
		{"inactive and unit absent", "inactive", execExitNonZero, catExits, StatusNotFound},
		{"inactive and cat cannot run", "inactive", execExitNonZero, catFails, StatusError},
		{"unknown output and unit absent", "unknown", execExitNonZero, catExits, StatusNotFound},
		{"empty output and cat cannot run", "", execExitNonZero, catFails, StatusError},
		{"activating and unit exists", "activating", execExitNonZero, catOK, StatusStopped},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := systemctlCheckResult("ctrld", tt.output, tt.isActive, "boom", tt.cat)
			if got.Status != tt.want {
				t.Fatalf("status = %q, want %q (details %v)", got.Status, tt.want, got.Details)
			}
		})
	}
}
