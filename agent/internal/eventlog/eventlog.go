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
