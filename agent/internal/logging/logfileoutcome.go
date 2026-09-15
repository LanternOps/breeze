package logging

import "log/slog"

// LogFileOutcome renders the one-line startup record every helper emits to
// say where its diagnostics are going.
//
// Before #5877 a helper that could not open its log file fell back to
// stdout silently — under launchd that reads as an empty log with no
// explanation anywhere, which is precisely how the macOS 0700 root-owned
// log directory went unnoticed. openErr is the error from opening the log
// file (nil on success) and mkdirErr the error from creating its directory
// (usually the underlying cause, and only reported when non-nil, so the
// success line stays uncluttered).
//
// Returned as (warn, message, attrs) rather than logged here so the
// caller can emit it through whichever logger it holds — the standalone
// desktop-helper uses its component logger, runHelperProcess uses slog
// directly — without the two drifting apart.
func LogFileOutcome(path string, openErr, mkdirErr, homeErr error) (warn bool, msg string, attrs []any) {
	if openErr == nil {
		return false, "helper log file opened", []any{"path", path}
	}

	attrs = []any{"path", path, "error", openErr}
	if mkdirErr != nil {
		attrs = append(attrs, "mkdirError", mkdirErr)
	}
	// On macOS an unresolvable home directory is why the helper is
	// writing to the shared root-owned directory at all, so report it
	// here rather than letting it read as a bare permissions failure.
	if homeErr != nil {
		attrs = append(attrs, "homeDirError", homeErr)
	}
	return true, "helper log file unavailable; logging to stdout only", attrs
}

// EmitLogFileOutcome writes the LogFileOutcome line through logger at the
// level LogFileOutcome selected.
//
// Call this AFTER the log shipper is initialised. Both macOS helper
// LaunchAgents hardcode StandardOutPath/StandardErrorPath to /dev/null
// (internal/launchdplist), so when the local log file cannot be opened the
// stdout fallback is discarded by launchd — shipping is then the only sink
// that reaches an operator, and the warn level clears the default
// log_shipping_level of "warn".
func EmitLogFileOutcome(logger *slog.Logger, path string, openErr, mkdirErr, homeErr error) {
	warn, msg, attrs := LogFileOutcome(path, openErr, mkdirErr, homeErr)
	if warn {
		logger.Warn(msg, attrs...)
		return
	}
	logger.Info(msg, attrs...)
}
