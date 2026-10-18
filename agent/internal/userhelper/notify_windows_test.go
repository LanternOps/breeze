//go:build windows

package userhelper

import (
	"errors"
	"fmt"
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

// TestShowNotificationOS pins the routing between the two toast backends.
// WinRT is primary: when it succeeds no child process is spawned at all, which
// is what removes the console flash on the user's desktop during
// remote-session connect/disconnect. A WinRT failure falls back to PowerShell —
// except when WinRT reports toasts disabled: PowerShell would raise the same
// toast through the same notifier, the OS would drop it just as silently, and
// it would report success, so the caller's FallbackDialog (#6864) never fired.
func TestShowNotificationOS(t *testing.T) {
	disabled := fmt.Errorf("%w (NotificationSetting=2)", errToastsDisabled)
	cases := []struct {
		name          string
		winrtErr      error
		psResult      bool
		body          string
		wantDelivered bool
		wantPSCalls   int
		wantPSXML     string // substring the fallback must receive, when it runs
	}{
		{name: "UsesWinRTWithoutPowerShell", winrtErr: nil, psResult: false, body: "connected", wantDelivered: true, wantPSCalls: 0},
		{name: "FallsBackToPowerShellWhenWinRTFails", winrtErr: errors.New("RoGetActivationFactory: HRESULT 0x80040154"), psResult: true, body: "a & b", wantDelivered: true, wantPSCalls: 1, wantPSXML: "a &amp; b"},
		{name: "ReportsUndeliveredWhenBothPathsFail", winrtErr: errors.New("boom"), psResult: false, body: "x", wantDelivered: false, wantPSCalls: 1},
		// psResult true: a PowerShell retry WOULD claim delivery, so only the
		// no-retry rule can make this case report undelivered.
		{name: "ReportsUndeliveredWithoutPowerShellWhenToastsDisabled", winrtErr: disabled, psResult: true, body: "x", wantDelivered: false, wantPSCalls: 0},
		{name: "DisabledIsRecognisedThroughWrapping", winrtErr: fmt.Errorf("toast: %w", disabled), psResult: true, body: "x", wantDelivered: false, wantPSCalls: 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			winrt, ps, psXML := swapToastSeams(t, tc.winrtErr, tc.psResult)
			got := showNotificationOS(ipc.NotifyRequest{Title: "Breeze", Body: tc.body})
			if got != tc.wantDelivered {
				t.Fatalf("showNotificationOS = %v, want %v", got, tc.wantDelivered)
			}
			if *winrt != 1 || *ps != tc.wantPSCalls {
				t.Fatalf("winrt calls = %d, powershell calls = %d; want 1 and %d", *winrt, *ps, tc.wantPSCalls)
			}
			if tc.wantPSXML != "" && !strings.Contains(*psXML, tc.wantPSXML) {
				t.Errorf("fallback received unescaped/other XML: %s", *psXML)
			}
		})
	}
}

// TestNotificationSettingError maps every Windows.UI.Notifications
// NotificationSetting value: only Enabled (0) lets the toast through; every
// disabled reason is errToastsDisabled so showNotificationOS reports the toast
// undelivered instead of retrying it through PowerShell.
func TestNotificationSettingError(t *testing.T) {
	cases := []struct {
		name         string
		setting      int32
		wantDisabled bool
	}{
		{"Enabled", 0, false},
		{"DisabledForApplication", 1, true},
		{"DisabledForUser", 2, true},
		{"DisabledByGroupPolicy", 3, true},
		{"DisabledByManifest", 4, true},
		{"UnknownFutureValue", 99, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := notificationSettingError(tc.setting)
			if got := errors.Is(err, errToastsDisabled); got != tc.wantDisabled {
				t.Fatalf("notificationSettingError(%d) = %v; errors.Is(errToastsDisabled) = %v, want %v", tc.setting, err, got, tc.wantDisabled)
			}
			if !tc.wantDisabled && err != nil {
				t.Fatalf("notificationSettingError(Enabled) = %v, want nil", err)
			}
		})
	}
}

// TestShowToastWinRTFailsNoEarlierThanShow drives the real WinRT sequence on a
// Windows host with no interactive desktop (the CI runner). Delivery cannot be
// asserted there — Show() returns E_ACCESSDENIED outside an interactive
// session — but every step BEFORE Show can: a wrong IID, runtime class or
// vtable slot for activation, LoadXml, CreateToastNotification or
// CreateToastNotifierWithId fails at that step, and the error names it. So the
// only accepted outcomes are success, a failure at Show itself, or the toast
// setting reporting disabled (which needs get_Setting to have succeeded on a
// real notifier). It must never be skipped.
//
// The get_Setting check is observed directly: it must run on every path that
// reaches the notifier, and a value it reads must be a defined
// NotificationSetting (0..4). Production tolerates a get_Setting failure (logs
// it and shows the toast). Here that is tolerated only when Show then fails
// too, i.e. this session has no notification platform to answer either call
// (a desktop-less runner). If Show succeeds while get_Setting failed, the
// disabled-notifications check is dead on a host that can show toasts: red.
func TestShowToastWinRTFailsNoEarlierThanShow(t *testing.T) {
	notifyAumidOnce.Do(registerToastAUMID)
	settingReads := 0
	var settingErr error
	prevHook := toastSettingReadHook
	toastSettingReadHook = func(setting int32, err error) {
		settingReads++
		settingErr = err
		switch {
		case err != nil:
			t.Logf("IToastNotifier::get_Setting failed: %v", err)
		case setting < 0 || setting > 4:
			t.Errorf("IToastNotifier::get_Setting returned undefined NotificationSetting %d — wrong vtable slot?", setting)
		default:
			t.Logf("IToastNotifier::get_Setting = %d", setting)
		}
	}
	t.Cleanup(func() { toastSettingReadHook = prevHook })

	err := showToastWinRT(notifyAUMID, buildToastXML("Breeze CI", "WinRT sequence check"))
	if settingReads != 1 {
		t.Errorf("get_Setting check ran %d times, want 1 — the disabled-notifications check is not on the WinRT path", settingReads)
	}
	switch {
	case err == nil && settingErr != nil:
		t.Fatalf("Show() succeeded but get_Setting failed (%v) — the disabled-notifications check never runs on a host that can show toasts", settingErr)
	case err == nil:
		t.Log("showToastWinRT: Show() reported success")
	case errors.Is(err, errToastsDisabled):
		t.Logf("showToastWinRT: toasts disabled on this host (accepted): %v", err)
	case strings.HasPrefix(err.Error(), "IToastNotifier::Show:"):
		t.Logf("showToastWinRT: failed at Show (accepted without a desktop): %v", err)
	default:
		t.Fatalf("showToastWinRT failed before IToastNotifier::Show — a WinRT IID, class name or vtable slot is wrong: %v", err)
	}
}

// The PowerShell fallback is reached when WinRT fails before its own setting
// check (activation, apartment). On a host with toasts disabled its Show()
// would return success and drop the toast, so the script must read the
// notifier's Setting and exit non-zero, which showToastPowerShell reports as
// undelivered. A Setting read that throws is tolerated, as on the WinRT path.
func TestToastPowerShellScriptRefusesDisabledNotifier(t *testing.T) {
	args := newToastPowerShellCmd(`<toast/>`).Args
	script := args[len(args)-1]
	checkAt := strings.Index(script, "$setting -ne [Windows.UI.Notifications.NotificationSetting]::Enabled")
	showAt := strings.Index(script, "$notifier.Show($toast)")
	if checkAt < 0 || showAt < 0 {
		t.Fatalf("script lacks the Setting check or the notifier Show:\n%s", script)
	}
	if checkAt > showAt {
		t.Fatal("Setting is checked after Show; a disabled toast would already be dropped")
	}
	if !strings.Contains(script[checkAt:showAt], "exit 3") {
		t.Error("disabled Setting does not exit non-zero before Show")
	}
	if !strings.Contains(script, "try { $setting = $notifier.Setting } catch { }") {
		t.Error("a throwing Setting read is not tolerated; it would turn every fallback toast into a failure")
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
