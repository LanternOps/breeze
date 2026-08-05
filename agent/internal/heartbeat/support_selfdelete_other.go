//go:build !windows

package heartbeat

import "os"

// startSupportSelfDelete removes the Quick Support executable. Unix unlinks by
// name and the running process keeps its open inode, so no trampoline is
// needed — the counterpart of the Windows implementation's cmd /C dance.
func startSupportSelfDelete(exePath string) error {
	if err := os.Remove(exePath); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
