//go:build !windows

// Package eventlog writes informational, warning, and error events to
// the OS event log. On Windows this wraps the Application log; on
// macOS and Linux the calls compile to no-ops so agent call sites can
// stay cross-platform.
package eventlog

// Info writes an informational event to the OS event log (no-op on
// non-Windows platforms). source is a short registered name like
// "BreezeAgent".
func Info(source, message string) {}

// Warning writes a warning event.
func Warning(source, message string) {}

// Error writes an error event.
func Error(source, message string) {}

// WriteError is a no-op on non-Windows platforms.
func WriteError(source, message string) error { return nil }

// Level selects the Windows Application log severity for Event. Kept
// cross-platform (rather than gated behind eventlog_windows.go) so PAM call
// sites in cross-platform packages like heartbeat can call Event
// unconditionally.
type Level int

const (
	LevelInfo Level = iota
	LevelWarning
	LevelError
)

// Event is a no-op on non-Windows platforms.
func Event(source string, eventID uint32, level Level, message string) {}
