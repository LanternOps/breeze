package ipc

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

// SystemSID is the well-known Windows Local System account SID string. The
// agent's privileged broker service only ever runs under this account, so a
// named-pipe client can use it as the trust anchor when verifying the
// identity of the process on the other end of the pipe.
const SystemSID = "S-1-5-18"

// ErrServerProcessNotQueryable marks the one expected failure while
// gathering server evidence: this client may not open the server process at
// all (an unprivileged client against a Local System service). Only that
// case falls back to the pipe-owner check; a failure after the process was
// opened (image path, token) fails closed like any other error.
var ErrServerProcessNotQueryable = errors.New("ipc: server process not queryable")

func serverProcessNotQueryable(err error) bool {
	return errors.Is(err, ErrServerProcessNotQueryable)
}

// VerifyServerSID reports whether a named-pipe server's kernel-verified
// token SID identifies it as the Local System account. Pure — no syscalls,
// no filesystem access — so it is unit-testable on every platform the agent
// builds on, not just Windows, where the actual SID is resolved via
// GetNamedPipeServerProcessId + OpenProcessToken (see auth_windows.go).
func VerifyServerSID(sid string) bool {
	return sid == SystemSID
}

// VerifyServerBinaryPath reports whether a named-pipe server's kernel-
// resolved image path matches the expected installed agent binary. Both
// paths are compared case-insensitively after Clean; callers should resolve
// symlinks first on platforms that support them. An empty actual or
// expected path never matches — fail closed rather than treat "unknown" as
// trusted. Pure so it is unit-testable without touching the filesystem or
// any Windows API.
func VerifyServerBinaryPath(actual, expected string) bool {
	if actual == "" || expected == "" {
		return false
	}
	return strings.EqualFold(filepath.Clean(actual), filepath.Clean(expected))
}

// ServerIdentityEvidence is what a named-pipe client could learn, from the
// kernel, about whoever accepted its connection. Gathered on Windows by
// VerifyServerIdentity; kept as plain data so the trust decision
// (CheckServerIdentity) is a pure, cross-platform-testable function.
type ServerIdentityEvidence struct {
	// PipeOwnerSID is the owner of the pipe object, read with
	// GetSecurityInfo through the client's own connected handle (the
	// READ_CONTROL right the client already holds). Windows refuses to let a
	// process assign an owner it does not itself hold as an owner-capable
	// SID (ERROR_INVALID_OWNER) unless it has SeRestorePrivilege, so an
	// unprivileged process cannot create a pipe owned by Local System.
	PipeOwnerSID string
	// ProcessQueried is true when the server process could be opened for
	// query. An unprivileged client (the user-session helper, Breeze Assist)
	// is refused PROCESS_QUERY_LIMITED_INFORMATION on a Local System
	// service, so for those clients the pipe owner is the only evidence.
	ProcessQueried bool
	ProcessSID     string
	ProcessPath    string
	// ExpectedPath is the agent binary the server image must match when the
	// process was queried. Empty skips the path comparison.
	ExpectedPath string
}

// CheckServerIdentity decides whether a named-pipe server is the agent
// broker. The pipe must be owned by Local System (the broker's pipe SDDL
// sets O:SY explicitly, and a Local System creator gets that owner by
// default). When the client could also query the server process, that
// process must run as Local System and, when an expected path is known,
// from the agent binary. Fails closed on any missing piece of evidence.
func CheckServerIdentity(ev ServerIdentityEvidence) error {
	if ev.PipeOwnerSID != SystemSID {
		return fmt.Errorf("ipc: pipe owner SID %q is not the Local System account", ev.PipeOwnerSID)
	}
	if !ev.ProcessQueried {
		return nil
	}
	if !VerifyServerSID(ev.ProcessSID) {
		return fmt.Errorf("ipc: pipe server SID %q is not the Local System account", ev.ProcessSID)
	}
	if ev.ExpectedPath != "" && !VerifyServerBinaryPath(ev.ProcessPath, ev.ExpectedPath) {
		return fmt.Errorf("ipc: pipe server binary %q does not match expected agent binary %q", ev.ProcessPath, ev.ExpectedPath)
	}
	return nil
}
