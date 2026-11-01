package desktop

import (
	"errors"
	"strings"
	"syscall"
	"testing"
)

// No build tag: the SetThreadDesktop failure path only happens on a live
// secure desktop, so the error text is the diagnostic channel (#8434, #9558).
// Its construction is pure Go and asserted here on every platform.

func TestSetThreadDesktopErrorCarriesCodeAndDesktops(t *testing.T) {
	err := setThreadDesktopError("Default", "Winlogon", syscall.Errno(170))
	msg := err.Error()
	for _, want := range []string{"SetThreadDesktop", `"Default"`, `"Winlogon"`, "170", "0xAA", "windows or hooks"} {
		if !strings.Contains(msg, want) {
			t.Errorf("message %q does not contain %q", msg, want)
		}
	}
	if code, ok := win32ErrorCode(err); !ok || code != 170 {
		t.Errorf("win32ErrorCode = %d, %v; want 170, true", code, ok)
	}
	if !errors.Is(err, syscall.Errno(170)) {
		t.Errorf("errors.Is must reach the errno, got %v", err)
	}
}

func TestSetThreadDesktopErrorHints(t *testing.T) {
	for _, tc := range []struct {
		code uint32
		hint string
	}{
		{170, "windows or hooks"},
		{5, "access denied"},
		{6, "invalid desktop handle"},
		{87, "invalid parameter"},
	} {
		msg := setThreadDesktopError("A", "B", syscall.Errno(tc.code)).Error()
		if !strings.Contains(msg, tc.hint) {
			t.Errorf("code %d: message %q lacks hint %q", tc.code, msg, tc.hint)
		}
	}
	// An unrecognised code still reports the number and adds no guessed cause.
	msg := setThreadDesktopError("A", "B", syscall.Errno(1234)).Error()
	if !strings.Contains(msg, "1234") || strings.Contains(msg, "[") {
		t.Errorf("unknown code message = %q, want the code and no hint", msg)
	}
}

func TestSetThreadDesktopErrorZeroAndUnknownNames(t *testing.T) {
	msg := setThreadDesktopError("", "", syscall.Errno(0)).Error()
	if !strings.Contains(msg, "Win32 recorded no error code") {
		t.Errorf("zero errno must be reported as no code, got %q", msg)
	}
	if strings.Contains(msg, `""`) {
		t.Errorf("an unreadable desktop name must not render as an empty string, got %q", msg)
	}
	if !strings.Contains(msg, "unknown") {
		t.Errorf("an unreadable desktop name must say so, got %q", msg)
	}
}

// Only ERROR_BUSY (the thread already owns windows or hooks) is cured by moving
// to a different OS thread; recycling on access denied would just spin threads.
func TestShouldRecycleCaptureThread(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want bool
	}{
		{"busy", setThreadDesktopError("Default", "Winlogon", syscall.Errno(170)), true},
		{"access denied", setThreadDesktopError("Default", "Winlogon", syscall.Errno(5)), false},
		{"no code", setThreadDesktopError("Default", "Winlogon", syscall.Errno(0)), false},
		{"nil", nil, false},
		{"plain", errors.New("x"), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := shouldRecycleCaptureThread(tc.err); got != tc.want {
				t.Fatalf("shouldRecycleCaptureThread = %v, want %v", got, tc.want)
			}
		})
	}
}
