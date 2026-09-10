package rebuild

import (
	"errors"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/layout"
)

func srcDisk() *layout.Disk {
	return &layout.Disk{Name: "/dev/sda", SizeBytes: 64 * GiB, SectorSize: 512, TableType: "gpt", IsSystem: true, Partitions: []layout.Partition{
		{Number: 1, Name: "/dev/sda1", TypeGUID: layout.GUIDEFISystem, PartUUID: "1111-aaaa", StartBytes: MiB, SizeBytes: 512 * MiB, Filesystem: "vfat", FSUUID: "ABCD-1234", MountPoint: "/boot/efi", Role: layout.RoleEFI, Encryption: layout.EncryptionNone},
		{Number: 2, Name: "/dev/sda2", TypeGUID: layout.GUIDLinuxFilesystem, PartUUID: "2222-bbbb", StartBytes: 513 * MiB, SizeBytes: 2 * GiB, Filesystem: "ext4", FSUUID: "boot-uuid", MountPoint: "/boot", Role: layout.RoleBoot, Encryption: layout.EncryptionNone},
		{Number: 3, Name: "/dev/sda3", TypeGUID: layout.GUIDLinuxFilesystem, PartUUID: "3333-cccc", StartBytes: (513 + 2048) * MiB, SizeBytes: 64*GiB - (513+2048)*MiB - MiB, UsedBytes: 8 * GiB, Filesystem: "ext4", FSUUID: "9f7a-root", Label: "rootfs", MountPoint: "/", Role: layout.RoleRoot, Encryption: layout.EncryptionNone},
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
