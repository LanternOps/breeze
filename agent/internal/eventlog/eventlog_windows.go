//go:build windows

// Package eventlog writes informational, warning, and error events to
// the Windows Application Event Log. Registration is lazy: on first
// use per source, we attempt InstallAsEventCreate, and if that fails
// because the source already exists we fall back to Open. Both
// failures are silently swallowed — the package's contract is that
// logging is best-effort and never returns errors to callers.
package eventlog

import (
	"sync"

	"golang.org/x/sys/windows/svc/eventlog"
)

// Event IDs used by this package. Fixed values keep the Windows
// Application log filterable by event ID in SIEM tools.
const (
	eventIDInfo    uint32 = 1001
	eventIDWarning uint32 = 1002
	eventIDError   uint32 = 1003
)

var (
	registryMu sync.Mutex
	registry   = map[string]*sourceEntry{}
)

type sourceEntry struct {
	once sync.Once
	log  *eventlog.Log // nil if registration failed
}

func lookupOrRegister(source string) *eventlog.Log {
	registryMu.Lock()
	entry, ok := registry[source]
	if !ok {
		entry = &sourceEntry{}
		registry[source] = entry
	}
	registryMu.Unlock()

	entry.once.Do(func() {
		// Try to install the source with all three severities. Most
		// Windows environments require admin to install a new event
		// source; if the source already exists, Install returns an
		// "already exists" error which we treat as benign.
		_ = eventlog.InstallAsEventCreate(
			source,
			eventlog.Info|eventlog.Warning|eventlog.Error,
		)
		// Open returns a handle usable for Info/Warning/Error regardless
		// of whether we just installed it or it already existed.
		logHandle, openErr := eventlog.Open(source)
		if openErr != nil {
			return // entry.log stays nil; subsequent calls are no-ops
		}
		entry.log = logHandle
	})
	return entry.log
}

// Info writes an informational event to the Windows Application log.
func Info(source, message string) {
	if handle := lookupOrRegister(source); handle != nil {
		_ = handle.Info(eventIDInfo, message)
	}
}

// Warning writes a warning event.
func Warning(source, message string) {
	if handle := lookupOrRegister(source); handle != nil {
		_ = handle.Warning(eventIDWarning, message)
	}
}

// Error writes an error event.
func Error(source, message string) {
	if handle := lookupOrRegister(source); handle != nil {
		_ = handle.Error(eventIDError, message)
	}
}
