package rebuild

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/layout"
)

// winPlanSrcDisk mirrors testLayoutWindows' shape but stays local to this
// file (self-contained per this task's own red-first cycle): ESP, MSR, C:
// (root, NOT last — Review Focus 3), Recovery.
func winPlanSrcDisk() *layout.Disk {
	return &layout.Disk{Name: `\\.\PHYSICALDRIVE0`, SizeBytes: 64 * GiB, SectorSize: 512, TableType: "gpt", IsSystem: true, Partitions: []layout.Partition{
		{Number: 1, Name: "ESP", TypeGUID: layout.GUIDEFISystem, PartUUID: "1111", StartBytes: MiB, SizeBytes: 100 * MiB, Filesystem: "fat32", FSUUID: "ABCD-1234", Role: layout.RoleEFI, Attributes: 0x1},
		{Number: 2, Name: "MSR", TypeGUID: layout.GUIDMicrosoftMSR, PartUUID: "2222", StartBytes: 101 * MiB, SizeBytes: 16 * MiB, Role: layout.RoleMSR, Attributes: 0x1},
		{Number: 3, Name: "root", TypeGUID: layout.GUIDMicrosoftBasic, PartUUID: "3333", StartBytes: 117 * MiB, SizeBytes: 40 * GiB, UsedBytes: 8 * GiB, Filesystem: "ntfs", Label: "Windows", Role: layout.RoleRoot},
		{Number: 4, Name: "Recovery", TypeGUID: layout.GUIDWindowsRecovery, PartUUID: "4444", StartBytes: 40*GiB + 117*MiB, SizeBytes: 600 * MiB, Filesystem: "ntfs", Label: "Recovery", Role: layout.RoleRecovery, Attributes: 0x8000000000000001},
	}}
}

// Review Focus 3: C: is not the last partition — it must still be the one
// that grows, and Recovery must keep its fixed size and sit after it.
func TestPlanWindows_GrowsRootBeforeRecovery(t *testing.T) {
	p, err := PlanPartitionsWindows(winPlanSrcDisk(), 100*GiB, 512, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Partitions) != 4 {
		t.Fatalf("partitions = %+v", p.Partitions)
	}
	esp, msr, root, recovery := p.Partitions[0], p.Partitions[1], p.Partitions[2], p.Partitions[3]
	if esp.SizeBytes != 100*MiB || msr.SizeBytes != 16*MiB {
		t.Fatalf("esp/msr = %+v %+v", esp, msr)
	}
	if !root.Grown || root.StartBytes != msr.StartBytes+msr.SizeBytes {
		t.Fatalf("root = %+v (want grown, starting right after MSR)", root)
	}
	if recovery.Grown || recovery.SizeBytes != 600*MiB || recovery.StartBytes != root.StartBytes+root.SizeBytes {
		t.Fatalf("recovery = %+v (want fixed size, immediately after root)", recovery)
	}
	if recovery.StartBytes+recovery.SizeBytes != 100*GiB-MiB {
		t.Fatalf("recovery does not end at the disk's usable end: %+v", recovery)
	}
	if recovery.Attributes != 0x8000000000000001 {
		t.Fatalf("recovery.Attributes = %#x, want the source's recorded attributes preserved", recovery.Attributes)
	}
}

// Ruling B7: GPT partition names written into PlannedPartition are ROLE
// defaults, never the source layout.Partition.Name — the Windows collector
// stores \\.\PHYSICALDRIVEn#m device paths there, which are not valid GPT
// partition names.
func TestPlanWindows_PartitionNamesAreRoleDefaults(t *testing.T) {
	d := winPlanSrcDisk()
	d.Partitions[0].Name = `\\.\PHYSICALDRIVE0#1`
	d.Partitions[1].Name = `\\.\PHYSICALDRIVE0#2`
	d.Partitions[2].Name = `\\.\PHYSICALDRIVE0#3`
	d.Partitions[3].Name = `\\.\PHYSICALDRIVE0#4`
	p, err := PlanPartitionsWindows(d, 100*GiB, 512, 0)
	if err != nil {
		t.Fatal(err)
	}
	esp, msr, root, recovery := p.Partitions[0], p.Partitions[1], p.Partitions[2], p.Partitions[3]
	if esp.Name != "EFI system partition" {
		t.Fatalf("esp.Name = %q, want %q", esp.Name, "EFI system partition")
	}
	if msr.Name != "Microsoft reserved partition" {
		t.Fatalf("msr.Name = %q, want %q", msr.Name, "Microsoft reserved partition")
	}
	if root.Name != "Basic data partition" {
		t.Fatalf("root.Name = %q, want %q", root.Name, "Basic data partition")
	}
	if recovery.Name != "" {
		t.Fatalf("recovery.Name = %q, want empty", recovery.Name)
	}
}

// R11: the minimum comes from the manifest total, not UsedBytes, when the
// manifest is larger. Ruling B12: MinimumBytes must match the exact
// arithmetic (fixed partitions + int64(manifestBytes*1.1) + 2 MiB GPT
// reserve) — a `got < wantMin` check on the grown root's SizeBytes cannot
// fail on a 100 GiB target, since the grown partition's SizeBytes is sized
// from the target's free space, not from MinimumBytes.
func TestPlanWindows_MinimumFromManifestBytes(t *testing.T) {
	small, err := PlanPartitionsWindows(winPlanSrcDisk(), 100*GiB, 512, 0)
	if err != nil {
		t.Fatal(err)
	}
	withManifest, err := PlanPartitionsWindows(winPlanSrcDisk(), 100*GiB, 512, 30*GiB)
	if err != nil {
		t.Fatal(err)
	}
	if withManifest.MinimumBytes <= small.MinimumBytes {
		t.Fatalf("MinimumBytes with a 30 GiB manifest (%d) should exceed the 8 GiB UsedBytes case (%d)", withManifest.MinimumBytes, small.MinimumBytes)
	}
	wantGrowMin := int64(float64(30*GiB) * 1.1)
	wantFixed := (100 + 16 + 600) * MiB // ESP + MSR + Recovery, all already MiB-aligned
	wantMinimumBytes := wantFixed + wantGrowMin + 2*MiB
	if withManifest.MinimumBytes != wantMinimumBytes {
		t.Fatalf("MinimumBytes = %d, want %d (fixed %d + grow %d + 2 MiB reserve)", withManifest.MinimumBytes, wantMinimumBytes, wantFixed, wantGrowMin)
	}
	if got := withManifest.Partitions[2].SizeBytes; got < wantGrowMin {
		t.Fatalf("root size %d is smaller than manifestBytes*1.1 (%d)", got, wantGrowMin)
	}
}

// R9: an unsupported filesystem (exfat) is refused by name.
func TestPlanWindows_RefusesUnsupportedFilesystem(t *testing.T) {
	d := winPlanSrcDisk()
	d.Partitions[2].Filesystem = "exfat"
	_, err := PlanPartitionsWindows(d, 100*GiB, 512, 0)
	if err == nil || !strings.Contains(err.Error(), `partition 3 filesystem "exfat" is not supported by the Windows engine (ntfs, fat32)`) {
		t.Fatalf("err = %v", err)
	}
}

func TestPlanWindows_RefusesTooSmall(t *testing.T) {
	_, err := PlanPartitionsWindows(winPlanSrcDisk(), 5*GiB, 512, 0)
	if err == nil || !strings.Contains(err.Error(), "target is too small") {
		t.Fatalf("err = %v", err)
	}
}

func TestPlanWindows_RefusesNoRootPartition(t *testing.T) {
	d := winPlanSrcDisk()
	d.Partitions[2].Role = layout.RoleData // no RoleRoot left
	_, err := PlanPartitionsWindows(d, 100*GiB, 512, 0)
	if err == nil || !strings.Contains(err.Error(), "no root (C:) partition") {
		t.Fatalf("err = %v", err)
	}
}
