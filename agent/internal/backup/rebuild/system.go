package rebuild

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// ErrUnsupportedHost is returned by Run when this host has no engine for
// the snapshot: hostPlatform() is "" (neither Linux nor Windows), or the
// resolved platform's seam is nil — no System on a Linux run (NewSystem
// returns nil off Linux) or no WinSystem on a Windows run.
var ErrUnsupportedHost = errors.New("the rebuild engine has no implementation for this host platform")

// System is every interaction with the machine the engine needs. The real
// implementation (system_linux.go) shells out; tests use fakeSystem
// (system_fake_test.go).
type System interface {
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
	// Chroot returns a runner that executes inside root (via `chroot root name args…`).
	Chroot(root string) func(ctx context.Context, name string, args ...string) ([]byte, error)
	BlockDeviceSize(path string) (int64, error) // blockdev --getsize64
	// AttachImage creates a sparse file if missing, then attaches it via
	// losetup --find --show --partscan, returning the loop device and a
	// detach func.
	AttachImage(path string, sizeBytes int64) (device string, detach func() error, err error)
	PartitionDevice(disk string, number int) string // /dev/sda1, /dev/nvme0n1p1, /dev/loop0p1
	Rescan(ctx context.Context, disk string) error  // partprobe + udevadm settle
	// Exists reports whether path exists on the filesystem — used to poll
	// for a partition device node to actually appear after Rescan, since
	// sgdisk/partprobe telling the kernel about a new partition table and
	// udev materializing the corresponding /dev entry are two separate,
	// asynchronous steps.
	Exists(path string) bool
	MountedSources() ([]string, error) // every SOURCE in /proc/self/mounts
	RootSources() ([]string, error)    // devices backing / and /run/live/medium (findmnt -no SOURCE)
	Mount(ctx context.Context, device, dir, fstype string, opts ...string) error
	BindMount(ctx context.Context, src, dir string) error
	Unmount(ctx context.Context, dir string) error
	Sync(ctx context.Context) error
	Arch() string // runtime.GOARCH
	// LookPath resolves an executable on PATH (exec.LookPath) — preflight
	// uses it to refuse a vhdx target before anything is written when
	// qemu-img is missing.
	LookPath(name string) (string, error)
	// FreeSpace reports the bytes available to this process on the
	// filesystem holding dir (statfs bavail*bsize).
	FreeSpace(dir string) (int64, error)
}

func partitionDevice(disk string, number int) string {
	if len(disk) > 0 && disk[len(disk)-1] >= '0' && disk[len(disk)-1] <= '9' {
		return fmt.Sprintf("%sp%d", disk, number)
	}
	return fmt.Sprintf("%s%d", disk, number)
}

func parseMountSources(procMounts string) []string {
	var out []string
	for _, line := range strings.Split(procMounts, "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 {
			out = append(out, f[0])
		}
	}
	return out
}
