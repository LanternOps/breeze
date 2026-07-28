//go:build windows

package sessionbroker

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	modNtdll          = windows.NewLazySystemDLL("ntdll.dll")
	procRtlGetVersion = modNtdll.NewProc("RtlGetVersion")
)

// rtlOSVersionInfoExW mirrors RTL_OSVERSIONINFOEXW (winternl.h /
// wdm.h). RtlGetVersion is used instead of GetVersionExW because the latter
// lies under compatibility shims; RtlGetVersion always reports the true
// version and suite mask.
type rtlOSVersionInfoExW struct {
	osVersionInfoSize uint32
	majorVersion      uint32
	minorVersion      uint32
	buildNumber       uint32
	platformID        uint32
	csdVersion        [128]uint16
	servicePackMajor  uint16
	servicePackMinor  uint16
	suiteMask         uint16
	productType       byte
	reserved          byte
}

// detectRDSHost reports whether this host has the RD Session Host
// (multi-session Terminal Services) role. Fails closed to false — a failed
// syscall leaves the lifecycle in always-on, the historical behavior.
func detectRDSHost() bool {
	var info rtlOSVersionInfoExW
	info.osVersionInfoSize = uint32(unsafe.Sizeof(info))
	ret, _, _ := procRtlGetVersion.Call(uintptr(unsafe.Pointer(&info)))
	if ret != 0 { // NTSTATUS: 0 == STATUS_SUCCESS
		return false
	}
	return isRDSSuiteMask(info.suiteMask)
}
