package recoveryconsole

import (
	"sort"
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
// "/dev/sr0"). Results are sorted by Path so the numbered prompt is stable.
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

	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

// backsMedia reports whether any mediaSources entry is diskName itself, or
// a partition of it (diskName + digits, or diskName + "p" + digits for the
// nvme-style naming scheme).
func backsMedia(diskName string, mediaSources []string) bool {
	for _, src := range mediaSources {
		if src == diskName {
			return true
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
