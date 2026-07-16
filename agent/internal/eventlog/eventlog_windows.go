//go:build windows

// Package eventlog writes informational, warning, and error events to
// the Windows Application Event Log. Registration is lazy: on first
// use per source, we attempt InstallAsEventCreate, and if that fails
// because the source already exists we fall back to Open. Both
// failures are silently swallowed by Info, Warning, and Error. WriteError
// exposes failures for bootstrap diagnostics that have no normal logger yet.
package eventlog

import (
	"errors"
	"fmt"
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
	registryMu             sync.Mutex
	registry               = map[string]*sourceEntry{}
	installAsEventCreateFn = eventlog.InstallAsEventCreate
	openEventLogFn         = eventlog.Open
	writeEventLogErrorFn   = func(handle *eventlog.Log, eventID uint32, message string) error {
		return handle.Error(eventID, message)
	}
)

type sourceEntry struct {
	once    sync.Once
	log     *eventlog.Log // nil if registration/open failed
	initErr error
}

func lookupOrRegister(source string) (*eventlog.Log, error) {
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
		installErr := installAsEventCreateFn(
			source,
			eventlog.Info|eventlog.Warning|eventlog.Error,
		)
		// Open returns a handle usable for Info/Warning/Error regardless
		// of whether we just installed it or it already existed.
		logHandle, openErr := openEventLogFn(source)
		if openErr != nil {
			entry.initErr = errors.Join(
				wrapEventLogInitError("register", source, installErr),
				fmt.Errorf("open Windows event source %q: %w", source, openErr),
			)
			return
		}
		entry.log = logHandle
	})
	return entry.log, entry.initErr
}

func wrapEventLogInitError(operation, source string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s Windows event source %q: %w", operation, source, err)
}

// Info writes an informational event to the Windows Application log.
func Info(source, message string) {
	if handle, _ := lookupOrRegister(source); handle != nil {
		_ = handle.Info(eventIDInfo, message)
	}
}

// Warning writes a warning event.
func Warning(source, message string) {
	if handle, _ := lookupOrRegister(source); handle != nil {
		_ = handle.Warning(eventIDWarning, message)
	}
}

// Error writes an error event.
func Error(source, message string) {
	_ = WriteError(source, message)
}

// WriteError writes an error event and reports source initialization or write
// failures to callers that need bootstrap-safe diagnostics.
func WriteError(source, message string) error {
	handle, err := lookupOrRegister(source)
	if err != nil {
		return err
	}
	return writeEventLogErrorFn(handle, eventIDError, message)
}
