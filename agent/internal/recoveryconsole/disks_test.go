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

func choicePaths(cs []DiskChoice) []string {
	out := make([]string, 0, len(cs))
	for _, c := range cs {
		out = append(out, c.Path)
	}
	return out
}

// Windows (WinPE) media sources are whole-disk \\.\PhysicalDrive<n> paths:
// media on PhysicalDrive10 must hide only PhysicalDrive10, never
// PhysicalDrive1 via the Linux partition-suffix rule.
func TestCandidateDisks_WindowsMediaOnDrive10DoesNotHideDrive1(t *testing.T) {
	lay := &layout.Manifest{Disks: []layout.Disk{
		{Name: `\\.\PhysicalDrive0`}, {Name: `\\.\PhysicalDrive1`}, {Name: `\\.\PhysicalDrive10`},
	}}
	got := choicePaths(CandidateDisks(lay, []string{`\\.\PhysicalDrive10`}))
	want := []string{`\\.\PhysicalDrive0`, `\\.\PhysicalDrive1`}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("CandidateDisks = %v, want %v", got, want)
	}
}

func TestCandidateDisks_WindowsMediaMatchIsExactCaseInsensitive(t *testing.T) {
	lay := &layout.Manifest{Disks: []layout.Disk{{Name: `\\.\PhysicalDrive1`}, {Name: `\\.\PhysicalDrive2`}}}
	got := choicePaths(CandidateDisks(lay, []string{`\\.\PHYSICALDRIVE2`, `\\.\PhysicalDrive1p1`}))
	want := []string{`\\.\PhysicalDrive1`}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("CandidateDisks = %v, want %v", got, want)
	}
}

func TestCandidateDisks_WindowsOrderingIsNumeric(t *testing.T) {
	lay := &layout.Manifest{Disks: []layout.Disk{
		{Name: `\\.\PhysicalDrive10`}, {Name: `\\.\PhysicalDrive2`}, {Name: `\\.\PhysicalDrive1`}, {Name: `\\.\PhysicalDrive0`},
	}}
	got := choicePaths(CandidateDisks(lay, nil))
	want := []string{`\\.\PhysicalDrive0`, `\\.\PhysicalDrive1`, `\\.\PhysicalDrive2`, `\\.\PhysicalDrive10`}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("CandidateDisks = %v, want %v", got, want)
	}
}

// Linux partition-suffix matching and lexical ordering are unchanged.
func TestCandidateDisks_LinuxPartitionSuffixesStillHide(t *testing.T) {
	lay := &layout.Manifest{Disks: []layout.Disk{
		{Name: "/dev/sdb"}, {Name: "/dev/nvme1n1"}, {Name: "/dev/sda"}, {Name: "/dev/nvme0n1"},
		{Name: "/dev/nvme10n1"},
	}}
	got := choicePaths(CandidateDisks(lay, []string{"/dev/nvme0n1p2", "/dev/sda1"}))
	want := []string{"/dev/nvme10n1", "/dev/nvme1n1", "/dev/sdb"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("CandidateDisks = %v, want %v", got, want)
	}
}

func TestCandidateDisks_NilManifest(t *testing.T) {
	if got := CandidateDisks(nil, nil); got != nil {
		t.Errorf("CandidateDisks(nil, nil) = %+v, want nil", got)
	}
}
