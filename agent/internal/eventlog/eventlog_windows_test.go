//go:build windows

package eventlog

import (
	"errors"
	"reflect"
	"testing"

	windowseventlog "golang.org/x/sys/windows/svc/eventlog"
)

func TestWriteErrorRegistersMissingSourceBeforeOpen(t *testing.T) {
	resetEventLogTestState(t)

	var calls []string
	handle := &windowseventlog.Log{}
	installAsEventCreateFn = func(source string, supported uint32) error {
		calls = append(calls, "install")
		if source != "BreezeAgent" {
			t.Fatalf("install source = %q", source)
		}
		want := uint32(windowseventlog.Info | windowseventlog.Warning | windowseventlog.Error)
		if supported != want {
			t.Fatalf("supported events = %d, want %d", supported, want)
		}
		return nil
	}
	openEventLogFn = func(source string) (*windowseventlog.Log, error) {
		calls = append(calls, "open")
		return handle, nil
	}
	writeEventLogErrorFn = func(got *windowseventlog.Log, eventID uint32, message string) error {
		calls = append(calls, "write")
		if got != handle || eventID != eventIDError || message != "guard failure" {
			t.Fatalf("write = (%p, %d, %q)", got, eventID, message)
		}
		return nil
	}

	if err := WriteError("BreezeAgent", "guard failure"); err != nil {
		t.Fatalf("WriteError() error = %v", err)
	}
	if want := []string{"install", "open", "write"}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("call order = %v, want %v", calls, want)
	}
}

func TestWriteErrorAlreadyRegisteredStillOpens(t *testing.T) {
	resetEventLogTestState(t)

	var calls []string
	installAsEventCreateFn = func(string, uint32) error {
		calls = append(calls, "install")
		return errors.New("event source registry key already exists")
	}
	openEventLogFn = func(string) (*windowseventlog.Log, error) {
		calls = append(calls, "open")
		return &windowseventlog.Log{}, nil
	}
	writeEventLogErrorFn = func(*windowseventlog.Log, uint32, string) error {
		calls = append(calls, "write")
		return nil
	}

	if err := WriteError("BreezeAgent", "guard failure"); err != nil {
		t.Fatalf("WriteError() error = %v", err)
	}
	if want := []string{"install", "open", "write"}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("call order = %v, want %v", calls, want)
	}
}

func TestWriteErrorReturnsRegistrationOpenFailure(t *testing.T) {
	resetEventLogTestState(t)

	installErr := errors.New("registration denied")
	openErr := errors.New("open denied")
	installCalls, openCalls, writeCalls := 0, 0, 0
	installAsEventCreateFn = func(string, uint32) error {
		installCalls++
		return installErr
	}
	openEventLogFn = func(string) (*windowseventlog.Log, error) {
		openCalls++
		return nil, openErr
	}
	writeEventLogErrorFn = func(*windowseventlog.Log, uint32, string) error {
		writeCalls++
		return nil
	}

	for i := 0; i < 2; i++ {
		err := WriteError("BreezeAgent", "guard failure")
		if !errors.Is(err, installErr) || !errors.Is(err, openErr) {
			t.Fatalf("WriteError() error = %v, want registration and open errors", err)
		}
	}
	if installCalls != 1 || openCalls != 1 || writeCalls != 0 {
		t.Fatalf("calls: install=%d open=%d write=%d", installCalls, openCalls, writeCalls)
	}
}

func TestWriteErrorReturnsWriteFailure(t *testing.T) {
	resetEventLogTestState(t)

	writeErr := errors.New("write denied")
	installAsEventCreateFn = func(string, uint32) error { return nil }
	openEventLogFn = func(string) (*windowseventlog.Log, error) { return &windowseventlog.Log{}, nil }
	writeEventLogErrorFn = func(*windowseventlog.Log, uint32, string) error { return writeErr }

	if err := WriteError("BreezeAgent", "guard failure"); !errors.Is(err, writeErr) {
		t.Fatalf("WriteError() error = %v, want %v", err, writeErr)
	}
}

func TestEventWritesUnderCallerSuppliedIDAndLevel(t *testing.T) {
	resetEventLogTestState(t)

	handle := &windowseventlog.Log{}
	installAsEventCreateFn = func(string, uint32) error { return nil }
	openEventLogFn = func(string) (*windowseventlog.Log, error) { return handle, nil }

	var infoCalls, warningCalls, errorCalls []struct {
		handle  *windowseventlog.Log
		eventID uint32
		message string
	}
	writeEventLogInfoFn = func(h *windowseventlog.Log, id uint32, m string) error {
		infoCalls = append(infoCalls, struct {
			handle  *windowseventlog.Log
			eventID uint32
			message string
		}{h, id, m})
		return nil
	}
	writeEventLogWarningFn = func(h *windowseventlog.Log, id uint32, m string) error {
		warningCalls = append(warningCalls, struct {
			handle  *windowseventlog.Log
			eventID uint32
			message string
		}{h, id, m})
		return nil
	}
	writeEventLogErrorFn = func(h *windowseventlog.Log, id uint32, m string) error {
		errorCalls = append(errorCalls, struct {
			handle  *windowseventlog.Log
			eventID uint32
			message string
		}{h, id, m})
		return nil
	}

	Event("Breeze-PAM", 1004, LevelInfo, "info body")
	Event("Breeze-PAM", 1008, LevelWarning, "warning body")
	Event("Breeze-PAM", 9999, LevelError, "error body")

	if len(infoCalls) != 1 || infoCalls[0].eventID != 1004 || infoCalls[0].message != "info body" || infoCalls[0].handle != handle {
		t.Fatalf("Info call = %+v", infoCalls)
	}
	if len(warningCalls) != 1 || warningCalls[0].eventID != 1008 || warningCalls[0].message != "warning body" {
		t.Fatalf("Warning call = %+v", warningCalls)
	}
	if len(errorCalls) != 1 || errorCalls[0].eventID != 9999 || errorCalls[0].message != "error body" {
		t.Fatalf("Error call = %+v", errorCalls)
	}
}

func TestEventDefaultsToInfoForUnknownLevel(t *testing.T) {
	resetEventLogTestState(t)

	handle := &windowseventlog.Log{}
	installAsEventCreateFn = func(string, uint32) error { return nil }
	openEventLogFn = func(string) (*windowseventlog.Log, error) { return handle, nil }

	var infoCalled bool
	writeEventLogInfoFn = func(*windowseventlog.Log, uint32, string) error {
		infoCalled = true
		return nil
	}
	writeEventLogWarningFn = func(*windowseventlog.Log, uint32, string) error {
		t.Fatal("Warning should not be called for an unknown level")
		return nil
	}
	writeEventLogErrorFn = func(*windowseventlog.Log, uint32, string) error {
		t.Fatal("Error should not be called for an unknown level")
		return nil
	}

	Event("Breeze-PAM", 1004, Level(99), "body")

	if !infoCalled {
		t.Fatal("expected Event to default to Info for an unrecognized level")
	}
}

func TestEventSwallowsRegistrationFailure(t *testing.T) {
	resetEventLogTestState(t)

	installAsEventCreateFn = func(string, uint32) error { return errors.New("registration denied") }
	openEventLogFn = func(string) (*windowseventlog.Log, error) { return nil, errors.New("open denied") }
	writeEventLogInfoFn = func(*windowseventlog.Log, uint32, string) error {
		t.Fatal("should never reach a write when registration failed")
		return nil
	}

	// Must not panic despite the handle being unavailable.
	Event("Breeze-PAM", 1004, LevelInfo, "body")
}

func resetEventLogTestState(t *testing.T) {
	t.Helper()

	origInstall := installAsEventCreateFn
	origOpen := openEventLogFn
	origWriteInfo := writeEventLogInfoFn
	origWriteWarning := writeEventLogWarningFn
	origWriteError := writeEventLogErrorFn
	registryMu.Lock()
	origRegistry := registry
	registry = map[string]*sourceEntry{}
	registryMu.Unlock()
	t.Cleanup(func() {
		installAsEventCreateFn = origInstall
		openEventLogFn = origOpen
		writeEventLogInfoFn = origWriteInfo
		writeEventLogWarningFn = origWriteWarning
		writeEventLogErrorFn = origWriteError
		registryMu.Lock()
		registry = origRegistry
		registryMu.Unlock()
	})
}
