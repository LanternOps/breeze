package main

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/eventlog"
	"github.com/breeze-rmm/agent/pkg/api"
)

// enrollErrCategory classifies an enrollment failure for exit-code
// stability and human-readable messaging. Exit codes are mapped to
// 10..16 to keep each category distinguishable in msiexec install.log
// without colliding with Go's default runtime-error exit code (2).
type enrollErrCategory int

const (
	catNetwork   enrollErrCategory = iota // dial/DNS/TLS/timeout/conn refused
	catAuth                               // 401, 403
	catNotFound                           // 404
	catRateLimit                          // 429
	catServer                             // 5xx
	catConfig                             // pre-flight validation or save failed
	catUnknown                            // fallback — message comes from raw error
)

func (c enrollErrCategory) exitCode() int { return int(c) + 10 }

// Package-level test seams. Production assigns them to the real
// implementations in init(); tests override with t.Cleanup-guarded
// stubs in enroll_error_test.go.
var (
	osExit             = os.Exit
	writeLastErrorFile = defaultWriteLastErrorFile
	eventLogError      = eventlog.Error
	enrollLastErrorPath = defaultEnrollLastErrorPath
)

// defaultEnrollLastErrorPath returns the platform-specific path to the
// single-line enrollment error marker. Windows: under ProgramData\Breeze\logs.
// Unix: under LogDir().
func defaultEnrollLastErrorPath() string {
	return filepath.Join(config.LogDir(), "enroll-last-error.txt")
}

// defaultWriteLastErrorFile overwrites enroll-last-error.txt with a
// single line containing the RFC3339 timestamp and the friendly message.
// Silently ignores errors — this is a diagnostic aid, not a critical
// path.
func defaultWriteLastErrorFile(line string) {
	path := enrollLastErrorPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	content := fmt.Sprintf("%s — %s\n", time.Now().Format(time.RFC3339), line)
	_ = os.WriteFile(path, []byte(content), 0o644)
}

// clearEnrollLastError removes enroll-last-error.txt if present. Called
// at the start of every enrollment attempt so a successful retry leaves
// no residual error file. Errors from os.Remove are silently ignored
// (the file may legitimately not exist, and cleanup bookkeeping must
// not fail an enrollment attempt).
func clearEnrollLastError() {
	path := enrollLastErrorPath()
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		// Log at debug level only — not worth bothering admins. The scoped
		// enrollLog is initialized by initEnrollLogging before this helper
		// is called.
		log.Debug("could not clear stale enroll-last-error file",
			"path", path, "error", err.Error())
	}
}

// enrollError writes a human-readable failure line to all four sinks
// (stderr → msiexec install.log, agent.log via slog, enroll-last-error.txt,
// Windows Event Log) and exits the process with a category-specific
// code. Never returns in production; tests inject a panicking osExit
// stub so assertion code after the call is reachable via defer+recover.
func enrollError(cat enrollErrCategory, friendly string, detail error) {
	line := fmt.Sprintf("Enrollment failed: %s", friendly)
	if detail != nil {
		line += fmt.Sprintf(" (%v)", detail)
	}

	// Sink 1: stderr → msiexec /l*v captures into install.log.
	fmt.Fprintln(os.Stderr, line)

	// Sink 2: agent.log via slog. The scoped enrollLog is initialized
	// by initEnrollLogging in enrollDevice before any failure path
	// can fire; fall back to the main log if called from an unexpected
	// context.
	log.Error("enrollment failed",
		"category", cat,
		"friendly", friendly,
		"error", fmt.Sprint(detail))

	// Sink 3: enroll-last-error.txt — single-line timestamped marker.
	writeLastErrorFile(line)

	// Sink 4: Windows Event Log (no-op on macOS/Linux).
	eventLogError("BreezeAgent", line)

	osExit(cat.exitCode())
}

// classifyEnrollError inspects an error returned by api.Client.Enroll
// and maps it to the appropriate category + user-facing friendly
// message. The serverURL is threaded through so friendly messages can
// echo it back to the admin ("check that SERVER_URL is correct").
func classifyEnrollError(err error, serverURL string) (enrollErrCategory, string) {
	if err == nil {
		return catUnknown, ""
	}

	var httpErr *api.ErrHTTPStatus
	if errors.As(err, &httpErr) {
		switch {
		case httpErr.StatusCode == 401 || httpErr.StatusCode == 403:
			return catAuth, "enrollment key not recognized — verify the key is active in Settings → Enrollment on the server"
		case httpErr.StatusCode == 404:
			return catNotFound, fmt.Sprintf(
				"enrollment endpoint not found on %s — check that SERVER_URL is correct (did you include /api or point at the wrong host?)",
				serverURL)
		case httpErr.StatusCode == 429:
			return catRateLimit, "rate limited by server — wait one minute and retry the install"
		case httpErr.StatusCode >= 500:
			return catServer, fmt.Sprintf(
				"server error %d — contact Breeze support if this persists",
				httpErr.StatusCode)
		}
	}

	// Network-layer errors come through as *url.Error wrapping dial/DNS/TLS/timeout.
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return catNetwork, fmt.Sprintf(
			"server unreachable at %s — check firewall, DNS, and that SERVER_URL is correct",
			serverURL)
	}

	return catUnknown, err.Error()
}
