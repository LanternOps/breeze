//go:build !windows

package heartbeat

import "os"

// startSupportSelfDelete removes the Quick Support executable. Unix unlinks by
// name and the running process keeps its open inode, so no trampoline is
// needed — the counterpart of the Windows implementation's cmd /C dance.
func startSupportSelfDelete(exePath, workDir string) error {
	// Unix removes open files, so supportCleanup has already removed workDir
	// in process; this removes whatever was written to it since.
	if workDir != "" {
		_ = os.RemoveAll(workDir)
	}
	if err := os.Remove(exePath); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
