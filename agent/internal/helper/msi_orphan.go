package helper

import (
	"errors"
	"fmt"
	"strings"
)

// msiProduct is the registered Breeze Helper MSI product: its ProductCode and
// the DisplayVersion Windows Installer recorded for it.
type msiProduct struct {
	code    string
	version string
}

// errMSIProductNotInstalled marks a repair whose package's product is not the
// one registered (msiexec exit 1605, ERROR_UNKNOWN_PRODUCT).
var errMSIProductNotInstalled = errors.New("msi package product is not installed")

// msiExitUnknownProduct is ERROR_UNKNOWN_PRODUCT: the package's ProductCode
// is not the registered one.
const msiExitUnknownProduct = 1605

// msiReinstallExitError maps a failed `msiexec /f` exit to installMSI's
// contract: 3010 (reboot required) is success, 1605 is
// errMSIProductNotInstalled, anything else is a failure wrapping cause.
func msiReinstallExitError(exitCode int, cause error, output string) error {
	switch exitCode {
	case 3010:
		return nil
	case msiExitUnknownProduct:
		return fmt.Errorf("msiexec /f: %w (output: %s)", errMSIProductNotInstalled, strings.TrimSpace(output))
	}
	return fmt.Errorf("msiexec /f: %w (output: %s)", cause, strings.TrimSpace(output))
}

// msiOps are the side effects of a Windows MSI helper install. installMSI takes
// them as arguments so its decisions are testable on any host.
type msiOps struct {
	binaryExists func(path string) bool
	findProduct  func() (msiProduct, error)
	uninstall    func(productCode string) error
	install      func(msiPath string) error
	reinstall    func(msiPath string) error
}

// installMSI installs the helper MSI for targetVersion, choosing the msiexec
// mode that will actually lay the files down.
//
// Orphaned registration (#6927 Lab Run C): with breeze-helper.exe deleted but
// the Breeze Helper product still registered, `msiexec /i` treats the package
// as a maintenance run of the registered product and fails with 1603 on every
// attempt. When the binary is missing and a product is registered, the
// registration is stale, so we uninstall it (`msiexec /x <ProductCode>`) and
// then install fresh.
//
// Registered at the target already (#6868): the product is registered at
// targetVersion but the binary is still being replaced, so the on-disk exe is
// not the target. A 3010 install whose file replacement was deferred to
// reboot leaves the host this way, and so does applyPendingUpdate's file-level
// rollback after an msiexec that succeeded. `msiexec /i` of the same package
// is again a maintenance run that replaces no files and exits 1603, so we
// force a file reinstall of the package instead. If the package turns out to
// be a different product than the registered one (a rebuilt package with the
// same version), the repair reports it as not installed and a plain install
// is correct.
//
// Otherwise this is a fresh install or an in-place upgrade: plain `/i`.
//
// A failed registry lookup does not block the install: the plain install is
// what ran before these fixes, and the caller's failure budget bounds a retry.
// A failed uninstall does block it, because the install would hit the same
// stale registration.
func installMSI(msiPath, binaryPath, targetVersion string, ops msiOps) error {
	binaryPresent := ops.binaryExists(binaryPath)
	product, err := ops.findProduct()
	if err != nil {
		log.Warn("could not read the helper MSI registration; installing anyway",
			"error", err.Error())
		return ops.install(msiPath)
	}
	if product.code == "" {
		return ops.install(msiPath)
	}

	if !binaryPresent {
		log.Warn("helper MSI product is registered but its binary is missing; uninstalling before a fresh install",
			"productCode", product.code, "binary", binaryPath)
		if err := ops.uninstall(product.code); err != nil {
			return fmt.Errorf("remove orphaned helper product %s: %w", product.code, err)
		}
		return ops.install(msiPath)
	}

	if msiVersionMatches(product.version, targetVersion) {
		log.Warn("helper MSI product is already registered at the target version but the binary is not; forcing a file reinstall",
			"productCode", product.code, "registeredVersion", product.version,
			"targetVersion", targetVersion, "binary", binaryPath)
		err := ops.reinstall(msiPath)
		if errors.Is(err, errMSIProductNotInstalled) {
			log.Warn("helper MSI package is not the registered product; installing it instead",
				"productCode", product.code, "error", err.Error())
			return ops.install(msiPath)
		}
		if err != nil {
			return fmt.Errorf("reinstall helper product %s at %s: %w", product.code, targetVersion, err)
		}
		return nil
	}

	return ops.install(msiPath)
}

// msiVersionMatches reports whether a registered MSI DisplayVersion is the
// target helper version. Windows Installer ignores the fourth version field,
// so a four-part "X.Y.Z.B" registration is compared as X.Y.Z.
func msiVersionMatches(registered, target string) bool {
	v := strings.TrimSpace(registered)
	if parts := strings.Split(v, "."); len(parts) == 4 {
		v = strings.Join(parts[:3], ".")
	}
	return helperVersionsMatch(v, target)
}
