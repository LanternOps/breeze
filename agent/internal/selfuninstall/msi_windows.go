//go:build windows

package selfuninstall

import (
	"fmt"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	modMsi                    = windows.NewLazySystemDLL("msi.dll")
	procMsiEnumRelatedProduct = modMsi.NewProc("MsiEnumRelatedProductsW")
)

// relatedProducts returns the installed ProductCodes for the UpgradeCodes,
// through MsiEnumRelatedProductsW: the Windows Installer's own answer, not a
// registry walk keyed on a display name an edition can change.
func relatedProducts(upgradeCodes []string) ([]string, error) {
	if err := procMsiEnumRelatedProduct.Find(); err != nil {
		return nil, fmt.Errorf("load the Windows Installer API: %w", err)
	}
	var products []string
	for _, code := range upgradeCodes {
		upgrade, err := windows.UTF16PtrFromString(code)
		if err != nil {
			return nil, err
		}
		for index := uint32(0); ; index++ {
			var buf [39]uint16 // a GUID in braces plus the terminator
			r, _, _ := procMsiEnumRelatedProduct.Call(
				uintptr(unsafe.Pointer(upgrade)), 0, uintptr(index), uintptr(unsafe.Pointer(&buf[0])))
			if syscall.Errno(r) == windows.ERROR_NO_MORE_ITEMS {
				break
			}
			if r != 0 {
				return nil, fmt.Errorf("enumerate the products of UpgradeCode %s (MsiEnumRelatedProducts): %w", code, syscall.Errno(r))
			}
			products = append(products, windows.UTF16ToString(buf[:]))
		}
	}
	return products, nil
}
