//go:build windows

package userhelper

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	modKernel32Locale            = windows.NewLazySystemDLL("kernel32.dll")
	procGetUserDefaultUILanguage = modKernel32Locale.NewProc("GetUserDefaultUILanguage")
	procLCIDToLocaleName         = modKernel32Locale.NewProc("LCIDToLocaleName")
)

// localeNameMaxLength is LOCALE_NAME_MAX_LENGTH (85 WCHARs incl. NUL).
const localeNameMaxLength = 85

// probeUILocaleOS returns the user's UI language: GetUserDefaultUILanguage
// (a LANGID) -> LCIDToLocaleName ("de-DE").
func probeUILocaleOS() string {
	if procGetUserDefaultUILanguage.Find() != nil || procLCIDToLocaleName.Find() != nil {
		return ""
	}
	langID, _, _ := procGetUserDefaultUILanguage.Call()
	if langID == 0 {
		return ""
	}
	// MAKELCID(langId, SORT_DEFAULT) == langId.
	var buf [localeNameMaxLength]uint16
	n, _, _ := procLCIDToLocaleName.Call(langID&0xffff, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), 0)
	if n == 0 {
		return ""
	}
	return windows.UTF16ToString(buf[:])
}
