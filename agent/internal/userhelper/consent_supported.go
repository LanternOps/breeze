//go:build !linux

package userhelper

// consentUISupported reports whether this platform can natively render the
// remote-session consent dialog. Windows uses MessageBoxTimeoutW and macOS
// uses osascript — both always present. Unlike Linux (consent_supported_linux.go),
// macOS has no clean no-cgo way to pre-check for an active Aqua session, so it
// doesn't gate advertisement on display availability here; instead
// showConsentDialogOS's own error handling distinguishes a genuine user
// decision from an osascript infra failure (e.g. a headless Mac with no
// window server), falling through to the onTimeout/unavailable policy in the
// latter case. See consent_dialog_darwin.go.
func consentUISupported() bool { return true }
