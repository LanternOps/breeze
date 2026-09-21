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
		return
	}
	defer f.Close()
	// The error is not actionable here: settleVolumes' retry loop is the
	// fallback if the commit hasn't landed by the time this returns.
	_ = unix.Syncfs(int(f.Fd()))
}
