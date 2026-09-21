//go:build linux

package syscleanup

import (
	"os"

	"golang.org/x/sys/unix"
)

// syncMount commits mount's pending filesystem transactions so a just-freed
// extent's space accounting is visible to the next disk.Usage read (issue
// #6484): btrfs releases extents lazily on delete and only updates available
// space once its transaction commits, which without a forced sync can lag
// behind the cleaner process exiting.
func syncMount(mount string) {
	f, err := os.Open(mount)
	if err != nil {
		log.Debug("could not open mount to sync during cleanup settle", "mount", mount, "error", err.Error())
		return
	}
	defer f.Close()
	// Not fatal — settleVolumes' retry loop is the fallback if the commit
	// hasn't landed by the time this returns — but a syncfs that fails
	// systematically (sandboxed agent, seccomp, degraded array) would
	// otherwise silently reduce this fix to bare retry-and-hope with no way
	// to tell why freedBytes is still off (issue #6484).
	if err := unix.Syncfs(int(f.Fd())); err != nil {
		log.Debug("syncfs failed during cleanup settle", "mount", mount, "error", err.Error())
	}
}
