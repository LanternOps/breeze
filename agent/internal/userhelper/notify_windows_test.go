//go:build windows

package userhelper

import (
	"errors"
	"strings"
	"testing"

	"golang.org/x/sys/windows"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func swapToastSeams(t *testing.T, winrtErr error, psResult bool) (winrtCalls, psCalls *int, psXML *string) {
	t.Helper()
	var wc, pc int
	var xml string
	prevW, prevP := toastWinRTFn, toastPowerShellFn
	toastWinRTFn = func(aumid, toastXML string) error {
		wc++
		if aumid != notifyAUMID {
			t.Errorf("WinRT toast raised under AUMID %q, want %q", aumid, notifyAUMID)
		}
		return winrtErr
	}
	toastPowerShellFn = func(toastXML string) bool {
		pc++
		xml = toastXML
		return psResult
	}
	t.Cleanup(func() { toastWinRTFn, toastPowerShellFn = prevW, prevP })
	return &wc, &pc, &xml
}

// The WinRT path is the primary one: when it succeeds no child process is
// spawned at all, which is what removes the console flash on the user's
// desktop during remote-session connect/disconnect.
func TestShowNotificationOSUsesWinRTWithoutPowerShell(t *testing.T) {
	winrt, ps, _ := swapToastSeams(t, nil, false)
	if !showNotificationOS(ipc.NotifyRequest{Title: "Breeze", Body: "connected"}) {
		t.Fatal("showNotificationOS = false although WinRT succeeded")
	}
	if *winrt != 1 || *ps != 0 {
		t.Fatalf("winrt calls = %d, powershell calls = %d; want 1 and 0", *winrt, *ps)
	}
}

func TestShowNotificationOSFallsBackToPowerShellWhenWinRTFails(t *testing.T) {
	winrt, ps, psXML := swapToastSeams(t, errors.New("RoGetActivationFactory: HRESULT 0x80040154"), true)
	if !showNotificationOS(ipc.NotifyRequest{Title: "Breeze", Body: "a & b"}) {
		t.Fatal("showNotificationOS = false although the PowerShell fallback delivered")
	}
	if *winrt != 1 || *ps != 1 {
		t.Fatalf("winrt calls = %d, powershell calls = %d; want 1 and 1", *winrt, *ps)
	}
	if !strings.Contains(*psXML, "a &amp; b") {
		t.Errorf("fallback received unescaped/other XML: %s", *psXML)
	}
}

func TestShowNotificationOSReportsUndeliveredWhenBothPathsFail(t *testing.T) {
	swapToastSeams(t, errors.New("boom"), false)
	if showNotificationOS(ipc.NotifyRequest{Title: "Breeze", Body: "x"}) {
		t.Fatal("showNotificationOS = true although both toast paths failed")
	}
}

// The fallback must never flash a console either: the user-helper is a GUI
// subsystem binary, so a bare powershell.exe child gets a fresh console.
func TestToastPowerShellCommandIsHidden(t *testing.T) {
	cmd := newToastPowerShellCmd(`<toast/>`)
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.HideWindow {
		t.Fatal("PowerShell toast command does not set HideWindow")
	}
	if cmd.SysProcAttr.CreationFlags&windows.CREATE_NO_WINDOW == 0 {
		t.Errorf("CREATE_NO_WINDOW not set; CreationFlags=0x%x", cmd.SysProcAttr.CreationFlags)
	}
	found := false
	for _, kv := range cmd.Env {
		if kv == "BREEZE_TOAST_XML=<toast/>" {
			found = true
		}
	}
	if !found {
		t.Error("toast XML not passed through BREEZE_TOAST_XML")
	}
	joined := strings.Join(cmd.Args, " ")
	for _, flag := range []string{"-NoProfile", "-NonInteractive"} {
		if !strings.Contains(joined, flag) {
			t.Errorf("PowerShell invocation lacks %s: %s", flag, joined)
		}
	}
}
