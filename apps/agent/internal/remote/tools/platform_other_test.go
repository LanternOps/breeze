//go:build !windows

package tools

import (
	"errors"
	"runtime"
	"testing"
)

func assertUnsupportedError(t *testing.T, err error, operation string) {
	t.Helper()

	if err == nil {
		t.Fatalf("expected %s to return an error", operation)
	}
	if !errors.Is(err, ErrNotSupported) {
		t.Fatalf("expected %s error to match ErrNotSupported, got: %v", operation, err)
	}

	var platformErr *PlatformError
	if !errors.As(err, &platformErr) {
		t.Fatalf("expected %s error to be PlatformError, got: %T", operation, err)
	}
	if platformErr.Operation != operation {
		t.Fatalf("expected operation %q, got %q", operation, platformErr.Operation)
	}
	if platformErr.Platform != runtime.GOOS {
		t.Fatalf("expected platform %q, got %q", runtime.GOOS, platformErr.Platform)
	}
}

func TestServiceManager_NonWindowsMethodsReturnUnsupported(t *testing.T) {
	sm := NewServiceManager()

	_, err := sm.ListServices()
	assertUnsupportedError(t, err, "ListServices")

	_, err = sm.GetService("Spooler")
	assertUnsupportedError(t, err, "GetService")

	err = sm.StartService("Spooler")
	assertUnsupportedError(t, err, "StartService")

	err = sm.StopService("Spooler")
	assertUnsupportedError(t, err, "StopService")

	err = sm.RestartService("Spooler")
	assertUnsupportedError(t, err, "RestartService")

	err = sm.SetStartupType("Spooler", StartupTypeAutomatic)
	assertUnsupportedError(t, err, "SetStartupType")
}

func TestTaskSchedulerManager_NonWindowsMethodsReturnUnsupported(t *testing.T) {
	m := NewTaskSchedulerManager()

	if m.IsSupported() {
		t.Fatal("expected task scheduler to be unsupported on non-Windows platforms")
	}

	_, err := m.ListTasks("\\")
	assertUnsupportedError(t, err, "ListTasks")

	_, err = m.GetTask("\\Microsoft\\Windows\\Defender\\Windows Defender Scheduled Scan")
	assertUnsupportedError(t, err, "GetTask")

	err = m.RunTask("\\Microsoft\\Windows\\Defender\\Windows Defender Scheduled Scan")
	assertUnsupportedError(t, err, "RunTask")

	err = m.EnableTask("\\Microsoft\\Windows\\Defender\\Windows Defender Scheduled Scan")
	assertUnsupportedError(t, err, "EnableTask")

	err = m.DisableTask("\\Microsoft\\Windows\\Defender\\Windows Defender Scheduled Scan")
	assertUnsupportedError(t, err, "DisableTask")

	_, err = m.GetTaskHistory("\\Microsoft\\Windows\\Defender\\Windows Defender Scheduled Scan", 10)
	assertUnsupportedError(t, err, "GetTaskHistory")
}
