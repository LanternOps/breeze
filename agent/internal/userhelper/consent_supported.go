//go:build !linux

package userhelper

// consentUISupported reports whether this platform can natively render the
// remote-session consent dialog. Windows uses MessageBoxTimeoutW and macOS
// uses osascript — both always present.
func consentUISupported() bool { return true }
