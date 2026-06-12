//go:build !windows && !linux

package patching

// DetectPendingReboot is a no-op on macOS — there is no reliable cheap
// pending-reboot signal short of querying softwareupdate.
func DetectPendingReboot() (bool, []string) {
	return false, nil
}
