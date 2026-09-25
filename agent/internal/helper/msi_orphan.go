package helper

import "fmt"

// msiOps are the side effects of a Windows MSI helper install. installMSI takes
// them as arguments so its decisions are testable on any host.
type msiOps struct {
	binaryExists    func(path string) bool
	findProductCode func() (string, error)
	uninstall       func(productCode string) error
	install         func(msiPath string) error
}

// installMSI installs the helper MSI, first removing an orphaned registration.
//
// #6927 Lab Run C: with breeze-helper.exe deleted but the Breeze Helper product
// still registered, `msiexec /i` treats the package as a maintenance run of the
// registered product and fails with 1603 on every attempt. When the binary is
// missing and a product is registered, the registration is stale, so we
// uninstall it (`msiexec /x <ProductCode>`) and then install fresh. When the
// binary is present this is an in-place upgrade and nothing is uninstalled.
//
// A failed registry lookup does not block the install: the plain install is
// what ran before this fix, and the caller's failure budget bounds a retry.
// A failed uninstall does block it, because the install would hit the same
// stale registration.
func installMSI(msiPath, binaryPath string, ops msiOps) error {
	if !ops.binaryExists(binaryPath) {
		productCode, err := ops.findProductCode()
		switch {
		case err != nil:
			log.Warn("could not check for an orphaned helper MSI registration; installing anyway",
				"error", err.Error())
		case productCode != "":
			log.Warn("helper MSI product is registered but its binary is missing; uninstalling before a fresh install",
				"productCode", productCode, "binary", binaryPath)
			if err := ops.uninstall(productCode); err != nil {
				return fmt.Errorf("remove orphaned helper product %s: %w", productCode, err)
			}
		}
	}
	return ops.install(msiPath)
}
