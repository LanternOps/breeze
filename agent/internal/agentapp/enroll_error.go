package agentapp

import (
	"encoding/json"
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
// 10..16 (plus 17, added for catIdentityConflict — #2764 Task 6) to keep
// each category distinguishable in msiexec install.log without colliding
// with Go's default runtime-error exit code (2).
type enrollErrCategory int

const (
	catNetwork   enrollErrCategory = iota // dial/DNS/TLS/timeout/conn refused
	catAuth                               // 401, 403
	catNotFound                           // 404
	catRateLimit                          // 429
	catServer                             // 5xx
	catConfig                             // pre-flight validation or save failed
	catUnknown                            // fallback — message comes from raw error
	// catIdentityConflict was appended AFTER catUnknown (not inserted
	// earlier in the block) so every previously-shipped exit code
	// (10..16) stays exactly as it was — see enrollErrCategory.exitCode.
	catIdentityConflict // 4xx enroll rejection naming a specific existing-row conflict (#2764 Task 6)
)

func (c enrollErrCategory) exitCode() int { return int(c) + 10 }

// isRefundable4xx reports whether cat represents a definitive 4xx rejection
// from the enroll endpoint — the request reached the server, and the server
// looked at it and said no. In that case a bootstrap-redeemed child key's
// slot is provably unused and safe to refund via cancelBootstrapIfRefundable
// (bootstrap.go). catNetwork and catServer are excluded: for both, the
// enroll request may have reached the server and created a device despite
// the failure the agent observed (a network error can mean the response was
// merely lost in flight; a 5xx can mean the transaction committed before an
// unrelated later failure). catConfig is excluded because it fires before
// any HTTP call is ever made — there is nothing to refund. catUnknown is
// excluded because it covers genuinely ambiguous failures (including a
// non-JSON or unparseable 2xx body, i.e. a call that may have succeeded).
func (c enrollErrCategory) isRefundable4xx() bool {
	switch c {
	case catAuth, catNotFound, catRateLimit, catIdentityConflict:
		return true
	default:
		return false
	}
}

// Package-level test seams. Production assigns them to the real
// implementations in init(); tests override with t.Cleanup-guarded
// stubs in enroll_error_test.go.
var (
	osExit              = os.Exit
	writeLastErrorFile  = defaultWriteLastErrorFile
	eventLogError       = eventlog.Error
	enrollLastErrorPath = defaultEnrollLastErrorPath
)

// cancelBootstrapOnEnrollFailure, when non-nil, is invoked by enrollError
// with the failure's category immediately before it exits the process —
// the last point at which a rejected enroll that consumed a bootstrap
// token can still safely refund the redeemed child key's slot (Task 6,
// #2764). runBootstrap (bootstrap.go) installs this hook — closing over
// the server URL and the child key's own enrollment secret — for the
// duration of its enrollDevice call, and clears it again once enrollDevice
// returns. enrollDevice invoked directly by the `enroll` CLI command never
// sets this hook: a manually-supplied enrollment key was never behind a
// bootstrap-redeemed slot, so there is nothing to refund.
var cancelBootstrapOnEnrollFailure func(cat enrollErrCategory)

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

	// Last chance to refund a bootstrap-redeemed child key's slot before the
	// process exits — see cancelBootstrapOnEnrollFailure's doc comment.
	if cancelBootstrapOnEnrollFailure != nil {
		cancelBootstrapOnEnrollFailure(cat)
	}

	osExit(cat.exitCode())
}

// identityConflictReasons maps the server's machine-readable `reason` field
// on a rejected /agents/enroll response to a short description of what
// collided. All three land in catIdentityConflict — they mean this
// hostname's identity collides with an existing device row in a way that
// needs operator action before an automatic re-enroll can succeed.
//
//   - hostname_collision_requires_existing_device_token: emitted only by
//     OLD servers (pre-#2764). Current servers enroll a fresh row instead
//     of ever returning this reason, but a self-hosted deployment may still
//     be running an older API.
//   - existing_decommissioned_row_has_suspended_token: the existing row for
//     this hostname is decommissioned AND its agent token was suspended
//     after a cross-tenant probe alarm — a deliberate ops alarm that must
//     not auto-clear.
//   - device_quarantined: the existing row for this hostname is quarantined
//     pending administrator review; re-enrolling cannot clear containment.
var identityConflictReasons = map[string]string{
	"hostname_collision_requires_existing_device_token": "an existing device already uses this hostname and this install could not present that device's token",
	"existing_decommissioned_row_has_suspended_token":   "the existing device row for this hostname is decommissioned but its agent token was suspended after a cross-tenant probe alarm",
	"device_quarantined":                                "the existing device for this hostname is quarantined pending administrator review",
}

// classifyIdentityConflict inspects httpErr's JSON body for a `reason` field
// matching identityConflictReasons. Returns ok=false (falling through to the
// generic status-code switch below) for any error body that isn't JSON,
// lacks a `reason` field, or names a reason this table doesn't recognize —
// including a plain 401/403/404 with no `reason` at all.
func classifyIdentityConflict(httpErr *api.ErrHTTPStatus) (string, bool) {
	var body struct {
		Reason string `json:"reason"`
	}
	if json.Unmarshal([]byte(httpErr.Body), &body) != nil {
		return "", false
	}
	detail, ok := identityConflictReasons[body.Reason]
	if !ok {
		return "", false
	}
	return fmt.Sprintf(
		"enrollment blocked by an identity conflict — %s. An administrator must decommission the existing device first (Devices → select the device → Decommission) to free this hostname, or resolve the specific conflict directly (approve/un-quarantine the device, or clear its suspended agent token) before retrying.",
		detail,
	), true
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
		// Reason-based classification takes priority over the generic
		// status-code switch below: device_quarantined arrives as a 403
		// (which would otherwise match catAuth), and both 409 reasons have
		// no status-code case at all (falling to catUnknown).
		if friendly, ok := classifyIdentityConflict(httpErr); ok {
			return catIdentityConflict, friendly
		}
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
