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

// hrElementNotFound is HRESULT_FROM_WIN32(ERROR_NOT_FOUND).
const hrElementNotFound = 0x80070490

// isSettingUnavailable reports whether err is exactly the get_Setting failure
// seen on the windows-latest runner: ERROR_NOT_FOUND from the get_Setting slot.
// The expected text is built with the same formatter comCall uses, so the same
// HRESULT from another slot, or another HRESULT from this one, does not match.
func isSettingUnavailable(err error) bool {
	want := hresultError(fmt.Sprintf("vtable[%d]", methIToastNotifierGetSetting), hrElementNotFound)
	return err != nil && err.Error() == want.Error()
}

// winRTSequenceVerdict judges one real run of showToastWinRT. err is its
// return; settingErr and setting are what get_Setting reported (setting counts
// only when settingErr is nil). It returns nil for an accepted outcome and the
// reason otherwise.
//
// Accepted:
//   - Show succeeded after get_Setting read Enabled.
//   - Show succeeded after get_Setting failed with ERROR_NOT_FOUND
//     (0x80070490). windows-latest runner (CI run 39156151658): the HKCU
//     AppUserModelId key for the test host is written, yet the notification
//     platform has no setting for it, so get_Setting returns ERROR_NOT_FOUND
//     while Show() returns S_OK. Production logs that and attempts the toast,
//     which is right: the setting is unknown, not disabled. Any other
//     get_Setting failure next to a successful Show stays red.
//   - Show failed (no notification platform in this session). Any get_Setting
//     failure alongside it is tolerated: neither call could be answered.
//   - errToastsDisabled, after get_Setting read a Disabled* value.
//
// Rejected: a failure before Show (a wrong IID, class name or vtable slot), a
// Disabled* read that did not return errToastsDisabled, and errToastsDisabled
// without a Disabled* read.
func winRTSequenceVerdict(err, settingErr error, setting int32) error {
	settingDisabled := settingErr == nil && setting != notificationSettingEnabled
	switch {
	case errors.Is(err, errToastsDisabled):
		if !settingDisabled {
			return fmt.Errorf("errToastsDisabled without get_Setting reading a Disabled value (setting=%d, get_Setting error=%v): %w", setting, settingErr, err)
		}
		return nil
	case settingDisabled:
		return fmt.Errorf("get_Setting read NotificationSetting=%d but the toast was still attempted (showToastWinRT returned %v)", setting, err)
	case err == nil:
		if settingErr != nil && !isSettingUnavailable(settingErr) {
			return fmt.Errorf("Show() succeeded but get_Setting failed with an unexpected error (%v); only ERROR_NOT_FOUND from the get_Setting slot is accepted", settingErr)
		}
		return nil
	case strings.HasPrefix(err.Error(), "IToastNotifier::Show:"):
		return nil
	default:
		return fmt.Errorf("showToastWinRT failed before IToastNotifier::Show — a WinRT IID, class name or vtable slot is wrong: %w", err)
	}
}

// TestWinRTSequenceVerdict pins the acceptance rule the real-WinRT test below
// applies, with synthetic results, so every branch runs whatever the CI host's
// notification platform does.
func TestWinRTSequenceVerdict(t *testing.T) {
	settingSlot := fmt.Sprintf("vtable[%d]", methIToastNotifierGetSetting)
	notFound := hresultError(settingSlot, hrElementNotFound)
	disabled := notificationSettingError(2)
	showFailed := fmt.Errorf("IToastNotifier::Show: %w", hresultError(fmt.Sprintf("vtable[%d]", methIToastNotifierShow), 0x80070005))
	cases := []struct {
		name       string
		err        error
		settingErr error
		setting    int32
		wantOK     bool
	}{
		{name: "ShowSucceededSettingEnabled", wantOK: true},
		{name: "ShowSucceededSettingNotFound", settingErr: notFound, wantOK: true},
		{name: "ShowSucceededSettingOtherHRESULT", settingErr: hresultError(settingSlot, 0x80004005), wantOK: false},
		{name: "ShowSucceededNotFoundFromAnotherSlot", settingErr: hresultError(fmt.Sprintf("vtable[%d]", methIToastNotifierGetSetting-1), hrElementNotFound), wantOK: false},
		{name: "ShowFailedSettingFailed", err: showFailed, settingErr: hresultError(settingSlot, 0x80004005), wantOK: true},
		{name: "DisabledAfterDisabledRead", err: disabled, setting: 2, wantOK: true},
		{name: "DisabledWithoutDisabledRead", err: disabled, settingErr: notFound, wantOK: false},
		{name: "DisabledReadButToastAttempted", setting: 2, wantOK: false},
		{name: "FailedBeforeShow", err: errors.New("IToastNotificationManagerStatics::CreateToastNotifierWithId: boom"), wantOK: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := winRTSequenceVerdict(tc.err, tc.settingErr, tc.setting)
			if (got == nil) != tc.wantOK {
				t.Fatalf("winRTSequenceVerdict(%v, %v, %d) = %v, want accepted=%v", tc.err, tc.settingErr, tc.setting, got, tc.wantOK)
			}
		})
	}
}

// TestShowToastWinRTFailsNoEarlierThanShow drives the real WinRT sequence on a
// Windows host with no interactive desktop (the CI runner). Delivery cannot be
// asserted there, but every step BEFORE Show can: a wrong IID, runtime class or
// vtable slot for activation, LoadXml, CreateToastNotification or
// CreateToastNotifierWithId fails at that step, and the error names it. The
// accepted outcomes are listed on winRTSequenceVerdict. It must never be
// skipped.
//
// The get_Setting check is observed directly: it must run exactly once on the
// path to Show, and a value it reads must be a defined NotificationSetting
// (0..4). Where the host answers get_Setting with ERROR_NOT_FOUND (the
// windows-latest runner), this test cannot prove the slot reads a setting;
// TestShowToastWinRTLive on a real desktop has to.
func TestShowToastWinRTFailsNoEarlierThanShow(t *testing.T) {
	notifyAumidOnce.Do(registerToastAUMID)
	settingReads := 0
	var settingErr error
	var settingValue int32
	prevHook := toastSettingReadHook
	toastSettingReadHook = func(setting int32, err error) {
		settingReads++
		settingErr, settingValue = err, setting
		switch {
		case isSettingUnavailable(err):
			t.Logf("IToastNotifier::get_Setting: no setting for this AUMID on this host: %v", err)
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
		t.Fatalf("get_Setting check ran %d times, want 1 — the disabled-notifications check is not on the WinRT path (showToastWinRT returned %v)", settingReads, err)
	}
	if verr := winRTSequenceVerdict(err, settingErr, settingValue); verr != nil {
		t.Fatal(verr)
	}
	t.Logf("showToastWinRT returned %v (accepted)", err)
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
