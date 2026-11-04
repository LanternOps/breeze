//go:build windows

package security

import "golang.org/x/sys/windows"

// readWindowsProductType returns wProductType from RtlGetVersion, which
// cannot fail and is not subject to the manifest-based GetVersionEx shim.
func readWindowsProductType() uint8 {
	return windows.RtlGetVersion().ProductType
}
