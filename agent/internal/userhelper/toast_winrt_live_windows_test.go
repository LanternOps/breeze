//go:build windows

package userhelper

import (
	"errors"
	"os"
	"testing"
)

// TestShowToastWinRTLive raises a real toast through WinRT. It needs an
// interactive desktop and so is opt-in: BREEZE_LIVE_TOAST=1 go test -run
// TestShowToastWinRTLive ./internal/userhelper, or the cross-compiled test
// binary run from a logged-in session on a Windows lab VM.
//
// It is also the only test that can prove the disabled-notifications check
// works: the CI runner answers get_Setting with ERROR_NOT_FOUND, which the CI
// test has to accept. Here get_Setting must succeed and read a defined value.
// With notifications on, the toast must be shown; with them off for Breeze
// (Settings > System > Notifications), showToastWinRT must return
// errToastsDisabled so showNotificationOS reports the toast undelivered. Run it
// both ways.
func TestShowToastWinRTLive(t *testing.T) {
	if os.Getenv("BREEZE_LIVE_TOAST") == "" {
		t.Skip("set BREEZE_LIVE_TOAST=1 to raise a real toast")
	}
	notifyAumidOnce.Do(registerToastAUMID)
	settingReads := 0
	var settingErr error
	var setting int32
	prevHook := toastSettingReadHook
	toastSettingReadHook = func(s int32, err error) {
		settingReads++
		setting, settingErr = s, err
	}
	t.Cleanup(func() { toastSettingReadHook = prevHook })

	xml := buildToastXML("Breeze live test", "WinRT toast raised without a child process — ✓ émoji 🚀")
	err := showToastWinRT(notifyAUMID, xml)
	if settingReads != 1 {
		t.Fatalf("get_Setting check ran %d times, want 1 (showToastWinRT returned %v)", settingReads, err)
	}
	if settingErr != nil {
		t.Fatalf("IToastNotifier::get_Setting failed on a desktop: %v — the disabled-notifications check never runs here", settingErr)
	}
	if setting < 0 || setting > 4 {
		t.Fatalf("IToastNotifier::get_Setting returned undefined NotificationSetting %d — wrong vtable slot?", setting)
	}
	if setting == notificationSettingEnabled {
		if err != nil {
			t.Fatalf("notifications enabled, but showToastWinRT: %v", err)
		}
		t.Log("NotificationSetting=Enabled; toast shown")
		return
	}
	if !errors.Is(err, errToastsDisabled) {
		t.Fatalf("NotificationSetting=%d (disabled), but showToastWinRT returned %v, want errToastsDisabled", setting, err)
	}
	t.Logf("NotificationSetting=%d; toast refused as disabled (FallbackDialog path)", setting)
}
