package tools

import (
	"errors"
	"log/slog"
	"strings"
	"unicode/utf8"

	"github.com/breeze-rmm/agent/internal/svcquery"
)

// service_running detection (#6958). The pure pieces live in this tag-free
// file so Linux CI exercises them; the per-OS files are thin exec wrappers:
//
//   - windows, darwin: svcquery.GetStatus (SCM with display-name fallback;
//     launchd label) → classifyServiceLookup
//   - linux: `systemctl is-active --quiet -- <unit>` → classifySystemctl
//   - anything else: unsupported
//
// The windows and darwin wrappers run only in the owner lab (gates L1–L3).

// serviceStatusFn reports whether the named service is running, and whether
// that answer is trustworthy. supported=false means the lookup could not tell
// (access denied, systemctl unavailable, timeout): the clause is then
// unsupported, never pass and never fail (#2022 contract). A var solely so
// tests can stub the OS.
var serviceStatusFn func(name string) (running bool, supported bool) = platformServiceStatus

// maxServiceNameBytes mirrors the shared validator's 256 bound, counted in
// UTF-8 bytes (packages/shared/src/validators/softwareDetection.ts).
const maxServiceNameBytes = 256

// validServiceName refuses a name before it can reach any OS tooling: empty or
// blank, over 256 bytes, invalid UTF-8, a leading '-' (an option to
// systemctl/sc/launchctl), or any C0 control, DEL, C1 control (U+0080–U+009F,
// incl. NEL U+0085), LINE SEPARATOR U+2028 or PARAGRAPH SEPARATOR U+2029.
// The shared SERVICE_NAME_REGEX refuses the same set, so a server-validated
// rule never trips this; it is defense in depth against a forged payload.
func validServiceName(name string) bool {
	if strings.TrimSpace(name) == "" || len(name) > maxServiceNameBytes || !utf8.ValidString(name) {
		return false
	}
	if strings.HasPrefix(name, "-") {
		return false
	}
	for _, r := range name {
		switch {
		case r <= 0x1f, r >= 0x7f && r <= 0x9f, r == 0x2028, r == 0x2029:
			return false
		}
	}
	return true
}

// evaluateServiceRunningRule evaluates one service_running clause.
func evaluateServiceRunningRule(rule DetectionRule) (matched bool, supported bool) {
	if !validServiceName(rule.ServiceName) {
		// The name is never logged verbatim: it failed validation precisely
		// because it may carry control characters.
		slog.Warn("detection: refusing service_running clause with an invalid service name",
			"nameBytes", len(rule.ServiceName))
		return false, false
	}
	return serviceStatusFn(rule.ServiceName)
}

// unsupportedClauseDetail explains an unsupported clause. A refused service
// name says so instead of blaming the platform.
func unsupportedClauseDetail(rule DetectionRule) string {
	if rule.Type == "service_running" && !validServiceName(rule.ServiceName) {
		return "unsupported clause service_running: invalid service name"
	}
	return "unsupported on this platform: " + rule.Type
}

// exitCoder is satisfied by *exec.ExitError (and by test doubles).
type exitCoder interface{ ExitCode() int }

// classifySystemctl maps the outcome of `systemctl is-active --quiet -- <unit>`.
// execErr is a failure to run systemctl at all (missing binary, timeout) and
// exitErr a non-zero exit. systemctl documents 3 for any non-active unit
// (inactive, failed, activating; also an unknown unit on older systemd) and 4
// for "no such unit". Any other exit, notably 1 when systemd cannot be reached
// (a container not booted with systemd), proves nothing about the service.
func classifySystemctl(exitErr error, execErr error) (running bool, supported bool) {
	if execErr != nil {
		return false, false
	}
	if exitErr == nil {
		return true, true
	}
	var coder exitCoder
	if errors.As(exitErr, &coder) {
		switch coder.ExitCode() {
		case 3, 4:
			return false, true
		}
	}
	return false, false
}

// classifyServiceLookup maps a svcquery.GetStatus result. Only a lookup that
// proved the service absent (ErrServiceNotFound) is a clean negative; any other
// error means the service could not be inspected and may well be running
// (#7967), and an unmapped state is equally undeterminable.
func classifyServiceLookup(info svcquery.ServiceInfo, err error) (running bool, supported bool) {
	if err != nil {
		if errors.Is(err, svcquery.ErrServiceNotFound) {
			return false, true
		}
		return false, false
	}
	switch info.Status {
	case svcquery.StatusRunning:
		return true, true
	case svcquery.StatusStopped, svcquery.StatusDisabled:
		return false, true
	default:
		return false, false
	}
}
