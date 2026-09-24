// winsystem.go — the Windows engine's OS-interaction seam (untagged
// interface; real implementation winsystem_windows.go, Task 12; off-Windows
// stub winsystem_other.go, this task; fake winsystem_fake_test.go, this
// task). Every Windows phase function (win_phases.go, win_preflight.go, ...)
// talks to the host ONLY through this interface — the Global Constraint
// "Two seams, never widened into each other."
package rebuild

import (
	"context"

	"github.com/breeze-rmm/agent/internal/backup/wingpt"
	"github.com/breeze-rmm/agent/internal/backup/winhive"
)

// WinGPTPartition is an alias for wingpt.Partition, not a second,
// field-identical struct: wingpt already owns the GPT partition shape (its
// codec reads/writes exactly this struct via IOCTL_DISK_{GET,SET}_DRIVE_
// LAYOUT_EX), and WriteGPT/ReadGPT below hand it straight to
// wingpt.WriteLayout/ReadLayout (Task 12) with no conversion step.
type WinGPTPartition = wingpt.Partition

// WinSystem is every Windows-host interaction the Windows engine phases
// need — the Windows twin of System (system.go).
type WinSystem interface {
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
	LookPath(name string) (string, error)
	// InWinPE reports whether this process is running inside Windows PE
	// (HKLM\SYSTEM\CurrentControlSet\Control\MiniNT exists) — gates disk:
	// targets (Global Constraint "Refuse before destructive work").
	InWinPE() bool
	// SystemDiskNumber is the disk holding %SystemRoot%'s volume, or -1
	// when %SystemRoot% is on a RAM disk (WinPE's X:).
	SystemDiskNumber() (int, error)
	// MediaDiskNumbers is the disk(s) holding the boot media in WinPE;
	// empty on a live Windows host.
	MediaDiskNumbers() ([]int, error)
	DiskInfo(diskNumber int) (WinDiskInfo, error)
	VolumesOnDisk(diskNumber int) ([]WinVolume, error)
	CreateVHDX(path string, sizeBytes int64, logicalSectorSize int) error
	// AttachVHDX attaches path with ATTACH_VIRTUAL_DISK_FLAG_NO_DRIVE_LETTER
	// and non-permanent lifetime (no PERMANENT_LIFETIME flag): the disk stays
	// attached while this process holds the virtual-disk handle and
	// detaches automatically when the handle closes (detach, or process
	// exit).
	AttachVHDX(path string) (diskNumber int, detach func() error, err error)
	// DetachVHDXByPath detaches a VHDX by path when it is currently
	// attached (by this process or another), reporting whether it was —
	// cleanupLeftovers (win_phases.go, Task 8) uses it when only the path
	// (from a stale state file) is known. A non-permanent attach dies with
	// its process; one held by another LIVE process cannot be detached from
	// outside (the real seam reports that as an error), while one held in
	// this process, or a PERMANENT_LIFETIME attach, is detached. Not
	// attached (or no such file) → (false, nil).
	DetachVHDXByPath(path string) (detached bool, err error)
	// WipeDisk locks+dismounts every existing volume on diskNumber, deletes
	// its drive layout, and zeroes the first and last MiB.
	WipeDisk(ctx context.Context, diskNumber int) error
	WriteGPT(diskNumber int, diskGUID string, parts []WinGPTPartition) error
	ReadGPT(diskNumber int) (diskGUID string, parts []WinGPTPartition, err error)
	// SetPartitionAttributes rewrites one partition's GPT attribute bits in
	// place — winValidate's "clear the no-drive-letter attribute" step;
	// provision's per-partition flags go through WriteGPT instead (it
	// already holds the whole table).
	SetPartitionAttributes(diskNumber, number int, attrs uint64) error
	WaitForVolumes(ctx context.Context, diskNumber int, want int) ([]WinVolume, error)
	// Format runs format.com <vol> /FS:<NTFS|FAT32> /Q /Y [/V:<label>].
	Format(ctx context.Context, volumeGUIDPath, filesystem, label string) error
	// MountVolume creates dir and mounts volumeGUIDPath at it
	// (SetVolumeMountPointW) — a folder mount point, never a drive letter.
	MountVolume(volumeGUIDPath, dir string) error
	UnmountVolume(dir string) error
	// AssignLetter is for the ESP only (bcdboot needs a volume letter, not
	// a folder mount point) — first free letter Z..D.
	AssignLetter(volumeGUIDPath string) (letter string, release func() error, err error)
	FlushVolume(volumeGUIDPath string) error
	FreeSpace(dir string) (int64, error)
	// LoadHive mounts hiveFile at HKLM\mountName under SeBackup/SeRestore
	// privilege — never the live registry (Global Constraint "Hives").
	LoadHive(hiveFile, mountName string) (winhive.Handle, error)
	// UnloadStaleHives unloads every HKLM subkey starting with prefix,
	// returning how many it found — cleanupLeftovers' leftover-mount sweep.
	UnloadStaleHives(prefix string) (int, error)
	HasWindowsTree(volumeGUIDPath string) (bool, error)
}

type WinDiskInfo struct {
	SizeBytes         int64
	LogicalSectorSize int
	ReadOnly, Offline bool
}

type WinVolume struct {
	// GUIDPath is a path that opens the volume root: the real seam
	// (Task 12) returns \\?\Volume{GUID}\ — no drive letter or folder
	// mount point involved, so securefs (which refuses every reparse point
	// below the volume root) can restore into it (Ruling B1); the test fake
	// returns the volume's backing directory.
	GUIDPath        string
	DiskNumber      int
	PartitionNumber int
	DriveLetter     string // "" when none
}
