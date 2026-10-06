package recoveryconsole

import (
	"sort"
	"strconv"
	"strings"

	"github.com/breeze-rmm/agent/internal/backup/layout"
)

// DiskChoice is one disk the operator may pick as the rebuild target.
type DiskChoice struct {
	Path      string
	Model     string
	Serial    string
	SizeBytes int64
}

// CandidateDisks returns the disks eligible as a rebuild target: not
// removable, not holding the running system's "/" (layout.Disk.IsSystem —
// meaningful when Collect ran against a normal host; on the recovery media
// itself no disk carries this flag, since "/" is the live squashfs
// overlay), and not backing the recovery media itself (mediaSources, from
// rebuild's System.RootSources — device paths such as "/dev/sdc1" or
// "/dev/sr0"; on WinPE, whole-disk \\.\PhysicalDrive<n> paths). Results are
// sorted by Path so the numbered prompt is stable — lexically, except that
// two \\.\PhysicalDrive<n> names order by disk number (2 before 10).
func CandidateDisks(lay *layout.Manifest, mediaSources []string) []DiskChoice {
	if lay == nil {
		return nil
	}

	var out []DiskChoice
	for _, d := range lay.Disks {
		if d.Removable || d.IsSystem {
			continue
		}
		if backsMedia(d.Name, mediaSources) {
			continue
		}
		out = append(out, DiskChoice{Path: d.Name, Model: d.Model, Serial: d.Serial, SizeBytes: d.SizeBytes})
	}

	sort.Slice(out, func(i, j int) bool { return lessDiskPath(out[i].Path, out[j].Path) })
	return out
}

// windowsDiskPrefix is the Win32 whole-disk device namespace the WinPE host
// reports both disks and media sources in.
const windowsDiskPrefix = `\\.\PhysicalDrive`

// isWindowsDiskPath reports whether p is in the \\.\PhysicalDrive namespace
// (case-insensitive, as Win32 device paths are).
func isWindowsDiskPath(p string) bool {
	return len(p) >= len(windowsDiskPrefix) && strings.EqualFold(p[:len(windowsDiskPrefix)], windowsDiskPrefix)
}

// physicalDriveNumber parses a \\.\PhysicalDrive<n> path (prefix matched
// case-insensitively).
func physicalDriveNumber(p string) (uint64, bool) {
	if !isWindowsDiskPath(p) {
		return 0, false
	}
	n, err := strconv.ParseUint(p[len(windowsDiskPrefix):], 10, 32)
	return n, err == nil
}

// lessDiskPath orders two \\.\PhysicalDrive<n> paths by disk number and
// everything else lexically.
func lessDiskPath(a, b string) bool {
	na, oka := physicalDriveNumber(a)
	nb, okb := physicalDriveNumber(b)
	if oka && okb && na != nb {
		return na < nb
	}
	return a < b
}

// backsMedia reports whether any mediaSources entry is diskName itself, or
// a partition of it (diskName + digits, or diskName + "p" + digits for the
// nvme-style naming scheme). A \\.\PhysicalDrive<n> disk names a whole
// disk with no partition-suffix scheme, so it matches only exactly
// (case-insensitively) — otherwise media on PhysicalDrive10 would hide
// PhysicalDrive1.
func backsMedia(diskName string, mediaSources []string) bool {
	windows := isWindowsDiskPath(diskName)
	for _, src := range mediaSources {
		if src == diskName || (windows && strings.EqualFold(src, diskName)) {
			return true
		}
		if windows {
			continue
		}
		if !strings.HasPrefix(src, diskName) {
			continue
		}
		rest := strings.TrimPrefix(src[len(diskName):], "p")
		if rest == "" || !isDigits(rest) {
			continue
		}
		return true
	}
	return false
}

func isDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
