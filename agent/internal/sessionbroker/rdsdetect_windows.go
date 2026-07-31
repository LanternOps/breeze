//go:build windows

package sessionbroker

import "golang.org/x/sys/windows"

// detectRDSHost reports whether this host has the RD Session Host
// (multi-session Terminal Services) role. RtlGetVersion is used instead of
// GetVersionExW because the latter lies under compatibility shims;
// RtlGetVersion always succeeds and always reports the true version and
// suite mask, so there is no failure case to fail closed on here.
func detectRDSHost() bool {
	info := windows.RtlGetVersion()
	return isRDSSuiteMask(info.SuiteMask)
}
