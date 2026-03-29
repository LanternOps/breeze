//go:build windows

package safemode

import (
	"fmt"
	"os"
	"os/exec"
)

// IsSafeMode returns true if Windows booted in any Safe Mode variant.
// Windows sets the SAFEBOOT_OPTION environment variable to "MINIMAL",
// "NETWORK", or "DSREPAIR" depending on the safe mode type.
func IsSafeMode() bool {
	return os.Getenv("SAFEBOOT_OPTION") != ""
}

// SetSafeBootNetwork configures the BCD store so the next boot enters
// Safe Mode with Networking. The flag persists until ClearSafeBootFlag
// is called — every subsequent reboot will enter safe mode.
func SetSafeBootNetwork() error {
	out, err := exec.Command("bcdedit", "/set", "{current}", "safeboot", "network").CombinedOutput()
	if err != nil {
		return fmt.Errorf("bcdedit set safeboot network failed: %w — output: %s", err, string(out))
	}
	return nil
}

// ClearSafeBootFlag removes the safeboot entry from the BCD store so
// the next reboot returns to normal mode.
func ClearSafeBootFlag() error {
	out, err := exec.Command("bcdedit", "/deletevalue", "{current}", "safeboot").CombinedOutput()
	if err != nil {
		return fmt.Errorf("bcdedit deletevalue safeboot failed: %w — output: %s", err, string(out))
	}
	return nil
}
