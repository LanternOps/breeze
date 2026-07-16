//go:build !windows

package pamactuator

// MaybeRunSessionLaunchHelper is a no-op on non-Windows. The two-stage
// SYSTEM-into-session launch helper (see tokenlaunch_windows.go) exists only on
// Windows, where UAC, the secure desktop, and session tokens live. This stub
// lets the cross-platform agent main() call it unconditionally at startup
// without a build-tagged call site.
func MaybeRunSessionLaunchHelper() {}
