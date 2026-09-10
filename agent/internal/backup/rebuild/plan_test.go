package rebuild

import (
	"errors"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/layout"
)

// Real-format UUIDs (see TestPlanPartitions_RefusesMalformedUUIDs / the
// review fix that added FSUUID format validation): mkfs itself rejects a
// non-UUID string like the old "boot-uuid"/"9f7a-root" placeholders
// ("could not parse UUID") — which used to surface only when the loopback
// test ran mkfs for real, well after sgdisk had already wiped the target.
const (
	testEFIPartUUID  = "11111111-2222-3333-4444-555555555555"
	testBootPartUUID = "66666666-7777-8888-9999-aaaaaaaaaaaa"
	testRootPartUUID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
	testEFIFSUUID    = "ABCD-1234" // vfat volume id: 4-4 hex
	testBootFSUUID   = "1b3c5d7e-9f01-4a2b-8c3d-4e5f6a7b8c9d"
	testRootFSUUID   = "9f7a2c41-6b3e-4d5f-8a9b-0c1d2e3f4a5b"
)

func srcDisk() *layout.Disk {
	return &layout.Disk{Name: "/dev/sda", SizeBytes: 64 * GiB, SectorSize: 512, TableType: "gpt", IsSystem: true, Partitions: []layout.Partition{
		{Number: 1, Name: "/dev/sda1", TypeGUID: layout.GUIDEFISystem, PartUUID: testEFIPartUUID, StartBytes: MiB, SizeBytes: 512 * MiB, Filesystem: "vfat", FSUUID: testEFIFSUUID, MountPoint: "/boot/efi", Role: layout.RoleEFI, Encryption: layout.EncryptionNone},
		{Number: 2, Name: "/dev/sda2", TypeGUID: layout.GUIDLinuxFilesystem, PartUUID: testBootPartUUID, StartBytes: 513 * MiB, SizeBytes: 2 * GiB, Filesystem: "ext4", FSUUID: testBootFSUUID, MountPoint: "/boot", Role: layout.RoleBoot, Encryption: layout.EncryptionNone},
		{Number: 3, Name: "/dev/sda3", TypeGUID: layout.GUIDLinuxFilesystem, PartUUID: testRootPartUUID, StartBytes: (513 + 2048) * MiB, SizeBytes: 64*GiB - (513+2048)*MiB - MiB, UsedBytes: 8 * GiB, Filesystem: "ext4", FSUUID: testRootFSUUID, Label: "rootfs", MountPoint: "/", Role: layout.RoleRoot, Encryption: layout.EncryptionNone},
	}}
}

func TestPlanPartitions_GrowsLastRootOnLargerTarget(t *testing.T) {
	p, err := PlanPartitions(srcDisk(), 100*GiB, 512)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Partitions) != 3 {
		t.Fatalf("partitions = %+v", p.Partitions)
	}
	efi, boot, root := p.Partitions[0], p.Partitions[1], p.Partitions[2]
	if efi.StartBytes != MiB || efi.SizeBytes != 512*MiB || efi.FSUUID != "ABCD-1234" || efi.Role != layout.RoleEFI {
		t.Errorf("efi = %+v", efi)
	}
	if boot.StartBytes != efi.StartBytes+efi.SizeBytes || boot.SizeBytes != 2*GiB {
		t.Errorf("boot = %+v", boot)
	}
	if !root.Grown || root.StartBytes != boot.StartBytes+boot.SizeBytes || root.StartBytes+root.SizeBytes != 100*GiB-MiB {
		t.Errorf("root = %+v (want grown to the end minus 1 MiB)", root)
	}
	if root.StartBytes%MiB != 0 || root.SizeBytes%MiB != 0 {
		t.Errorf("root not 1 MiB aligned: %+v", root)
	}
	usedRoot := int64(8 * GiB)
	if p.MinimumBytes != 512*MiB+2*GiB+int64(float64(usedRoot)*1.1)+2*MiB {
		t.Errorf("MinimumBytes = %d", p.MinimumBytes)
	}
}

func TestPlanPartitions_SmallerTargetShrinksRootToUsedPlusMargin(t *testing.T) {
	p, err := PlanPartitions(srcDisk(), 12*GiB, 512)
	if err != nil {
		t.Fatal(err)
	}
	root := p.Partitions[2]
	usedRoot := int64(8 * GiB)
	if root.SizeBytes < int64(float64(usedRoot)*1.1) || root.StartBytes+root.SizeBytes > 12*GiB-MiB {
		t.Errorf("root = %+v", root)
	}
}

func TestPlanPartitions_RefusesTooSmall(t *testing.T) {
	_, err := PlanPartitions(srcDisk(), 10*GiB, 512)
	var ref *RefusalError
	if err == nil || !errors.As(err, &ref) || !strings.Contains(ref.Reason, "target is too small") {
		t.Fatalf("err = %v", err)
	}
}

func TestPlanPartitions_RefusesUnsupportedFilesystem(t *testing.T) {
	d := srcDisk()
	d.Partitions[1].Filesystem = "btrfs"
	_, err := PlanPartitions(d, 100*GiB, 512)
	if err == nil || !strings.Contains(err.Error(), "partition 2 filesystem \"btrfs\"") {
		t.Fatalf("err = %v", err)
	}
}

func TestPlanPartitions_SkipsNonPartitionChildren(t *testing.T) {
	d := srcDisk()
	d.Partitions = append(d.Partitions, layout.Partition{Kind: "crypt", Name: "/dev/mapper/x", Filesystem: "ext4"})
	p, err := PlanPartitions(d, 100*GiB, 512)
	if err != nil || len(p.Partitions) != 3 {
		t.Fatalf("p=%+v err=%v", p, err)
	}
}

// TestPlanPartitions_RefusesMalformedUUIDs proves the review fix: mkfs
// itself rejects a non-UUID FSUUID string ("could not parse UUID") — which
// used to surface only mid-provision, well after sgdisk had already wiped
// the target's partition table. PlanPartitions now refuses up front, before
// any write, for both the ext4/xfs/swap UUID shape and the vfat volume-id
// shape.
func TestPlanPartitions_RefusesMalformedUUIDs(t *testing.T) {
	for _, tt := range []struct {
		name    string
		mutate  func(d *layout.Disk)
		wantErr string // substring of RefusalError.Reason; "" means no error expected
	}{
		{"malformed ext4 UUID (the old placeholder fixture value)", func(d *layout.Disk) { d.Partitions[1].FSUUID = "boot-uuid" }, `partition 2 filesystem UUID "boot-uuid" is not a valid ext4 UUID`},
		{"malformed vfat UUID", func(d *layout.Disk) { d.Partitions[0].FSUUID = "ZZZZ-1234" }, `partition 1 filesystem UUID "ZZZZ-1234" is not a valid vfat UUID`},
		{"valid UUIDs pass unchanged", func(d *layout.Disk) {}, ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			d := srcDisk()
			tt.mutate(d)
			_, err := PlanPartitions(d, 100*GiB, 512)
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			var ref *RefusalError
			if err == nil || !errors.As(err, &ref) || !strings.Contains(ref.Reason, tt.wantErr) {
				t.Fatalf("err = %v, want a RefusalError containing %q", err, tt.wantErr)
			}
		})
	}
}

// TestPlanPartitions_EmptyFSUUID_WarnsButDoesNotRefuse proves an empty
// FSUUID (mkfs will generate a fresh one) is allowed, not refused — but
// produces a warning, since the restored fstab's UUID= entry for that
// partition then won't resolve to anything on the rebuilt disk.
func TestPlanPartitions_EmptyFSUUID_WarnsButDoesNotRefuse(t *testing.T) {
	d := srcDisk()
	d.Partitions[2].FSUUID = ""
	p, err := PlanPartitions(d, 100*GiB, 512)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	found := false
	for _, w := range p.Warnings {
		if strings.Contains(w, "partition 3 has no recorded UUID") {
			found = true
		}
	}
	if !found {
		t.Fatalf("warnings = %v, want a 'no recorded UUID' warning for partition 3", p.Warnings)
	}
}
