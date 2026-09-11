package recoveryconsole

import (
	"reflect"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/layout"
)

func TestCandidateDisks_ExcludesSystemAndRemovableAndMedia(t *testing.T) {
	lay := &layout.Manifest{
		Disks: []layout.Disk{
			{Name: "/dev/sda", Model: "System Disk", Serial: "SYS1", SizeBytes: 100 << 30, IsSystem: true},
			{Name: "/dev/sdb", Model: "Data Disk", Serial: "DATA1", SizeBytes: 500 << 30},
			{Name: "/dev/sdc", Model: "USB Stick", Serial: "USB1", SizeBytes: 16 << 30, Removable: true},
		},
	}

	got := CandidateDisks(lay, []string{"/dev/sdc1"})
	want := []DiskChoice{{Path: "/dev/sdb", Model: "Data Disk", Serial: "DATA1", SizeBytes: 500 << 30}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("CandidateDisks = %+v, want %+v", got, want)
	}
}

func TestCandidateDisks_LiveMediaCase(t *testing.T) {
	// On the live recovery media itself, no disk carries IsSystem (the
	// running "/" is the squashfs overlay, not a mount on any of the
	// target machine's disks) and the media is an optical device
	// (/dev/sr0) that never appears in Disks at all.
	lay := &layout.Manifest{
		Disks: []layout.Disk{
			{Name: "/dev/sdb", Model: "Second Disk", Serial: "B", SizeBytes: 200 << 30},
			{Name: "/dev/sda", Model: "First Disk", Serial: "A", SizeBytes: 100 << 30},
		},
	}

	got := CandidateDisks(lay, []string{"/dev/sr0"})
	want := []DiskChoice{
		{Path: "/dev/sda", Model: "First Disk", Serial: "A", SizeBytes: 100 << 30},
		{Path: "/dev/sdb", Model: "Second Disk", Serial: "B", SizeBytes: 200 << 30},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("CandidateDisks = %+v, want %+v", got, want)
	}
}

func TestCandidateDisks_NilManifest(t *testing.T) {
	if got := CandidateDisks(nil, nil); got != nil {
		t.Errorf("CandidateDisks(nil, nil) = %+v, want nil", got)
	}
}
