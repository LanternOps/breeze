package layout

import (
	"fmt"

	"github.com/breeze-rmm/agent/internal/backup/wingpt"
)

// fillGPTDetailsWith is fillGPTDetails (collect_windows.go) with the IOCTL
// read injected, so the merge and skip rules are testable on every GOOS.
//
// Only disks whose TableType is "gpt" are read: an MBR disk (a USB stick, a
// legacy data disk) or a raw one has no disk GUID or GPT attributes to add,
// and reading it would only turn a normal machine into a spurious
// "gpt_attributes" Incomplete marker. A GPT disk this process cannot read
// (permissions, a disk that vanished between collection steps) leaves
// GUID/Attributes at their zero value and records ONE "gpt_attributes"
// marker for the whole manifest. The FIRST read error is returned, naming
// its disk, so the caller can log why rather than drop it.
func fillGPTDetailsWith(m *Manifest, read func(diskNumber int) (wingpt.Layout, error)) error {
	var firstErr error
	for i := range m.Disks {
		d := &m.Disks[i]
		if d.TableType != "gpt" {
			continue
		}
		num, ok := diskNumberFromName(d.Name)
		if !ok {
			continue
		}
		l, err := read(num)
		if err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("disk %d: %w", num, err)
			}
			continue
		}
		applyGPTDetails(d, l)
	}
	if firstErr != nil {
		m.Incomplete = append(m.Incomplete, "gpt_attributes")
	}
	return firstErr
}

// applyGPTDetails merges one disk's live GPT table into its manifest entry:
// the disk GUID, and each partition's attributes matched by partition
// NUMBER. A partition number the manifest does not already list is ignored —
// this step enriches the PowerShell inventory, it never adds to it.
func applyGPTDetails(d *Disk, l wingpt.Layout) {
	d.GUID = l.DiskGUID
	byNumber := make(map[int]uint64, len(l.Partitions))
	for _, p := range l.Partitions {
		byNumber[p.Number] = p.Attributes
	}
	for j := range d.Partitions {
		if attrs, ok := byNumber[d.Partitions[j].Number]; ok {
			d.Partitions[j].Attributes = attrs
		}
	}
}
