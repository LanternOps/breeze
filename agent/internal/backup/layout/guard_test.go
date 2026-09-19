package layout

import (
	"reflect"
	"testing"
)

func uefiGPT(extra ...Partition) *Manifest {
	parts := []Partition{
		{Number: 1, Name: "/dev/sda1", TypeGUID: "c12a7328-f81f-11d2-ba4b-00a0c93ec93b", Filesystem: "vfat", MountPoint: "/boot/efi", SizeBytes: 512 << 20, Role: RoleEFI, Encryption: EncryptionNone},
		{Number: 2, Name: "/dev/sda2", TypeGUID: "0fc63daf-8483-4772-8e79-3d69d8477de4", Filesystem: "ext4", MountPoint: "/", SizeBytes: 40 << 30, Role: RoleRoot, Encryption: EncryptionNone},
	}
	parts = append(parts, extra...)
	return &Manifest{
		SchemaVersion: SchemaVersion, Platform: "linux", BootMode: BootModeUEFI,
		Disks: []Disk{{Name: "/dev/sda", TableType: "gpt", SizeBytes: 64 << 30, IsSystem: true, Partitions: parts}},
	}
}

func TestAssess(t *testing.T) {
	tests := []struct {
		name string
		m    *Manifest
		want Restorability
	}{
		{name: "nil manifest", m: nil, want: Restorability{Restorable: false, Reasons: []string{ReasonNilManifest}}},
		{name: "uefi gpt ext4 single disk", m: uefiGPT(), want: Restorability{Restorable: true, Reasons: []string{}}},
		{name: "xfs root ok", m: func() *Manifest { m := uefiGPT(); m.Disks[0].Partitions[1].Filesystem = "xfs"; return m }(), want: Restorability{Restorable: true, Reasons: []string{}}},
		{name: "bios boot", m: func() *Manifest { m := uefiGPT(); m.BootMode = BootModeBIOS; return m }(), want: Restorability{Reasons: []string{ReasonBIOSBoot}}},
		{name: "mbr table", m: func() *Manifest { m := uefiGPT(); m.Disks[0].TableType = "mbr"; return m }(), want: Restorability{Reasons: []string{ReasonNotGPT}}},
		{name: "no efi partition", m: func() *Manifest { m := uefiGPT(); m.Disks[0].Partitions = m.Disks[0].Partitions[1:]; return m }(), want: Restorability{Reasons: []string{ReasonNoEFIPartition}}},
		{name: "no root", m: func() *Manifest {
			m := uefiGPT()
			m.Disks[0].Partitions = m.Disks[0].Partitions[:1]
			m.Disks[0].IsSystem = false
			return m
		}(), want: Restorability{Reasons: []string{ReasonNoSystemDisk}}},
		{name: "btrfs root", m: func() *Manifest { m := uefiGPT(); m.Disks[0].Partitions[1].Filesystem = "btrfs"; return m }(), want: Restorability{Reasons: []string{ReasonUnsupportedRootFS("btrfs"), ReasonBtrfs}}},
		{name: "lvm on system disk", m: uefiGPT(Partition{Number: 3, Name: "/dev/sda3", Filesystem: "LVM2_member", Role: RoleUnknown, Encryption: EncryptionNone}), want: Restorability{Reasons: []string{ReasonLVM}}},
		{name: "luks on system disk", m: uefiGPT(Partition{Number: 3, Name: "/dev/sda3", Filesystem: "crypto_LUKS", Encryption: EncryptionLUKS, Role: RoleUnknown}), want: Restorability{Reasons: []string{ReasonLUKS}}},
		{name: "raid member on system disk", m: uefiGPT(Partition{Number: 3, Name: "/dev/sda3", Filesystem: "linux_raid_member", Role: RoleUnknown, Encryption: EncryptionNone}), want: Restorability{Reasons: []string{ReasonRAID}}},
		{name: "zfs member on system disk", m: uefiGPT(Partition{Number: 3, Name: "/dev/sda3", Filesystem: "zfs_member", Role: RoleUnknown, Encryption: EncryptionNone}), want: Restorability{Reasons: []string{ReasonZFS}}},
		{name: "second disk mounted at /var is multi-disk", m: func() *Manifest {
			m := uefiGPT()
			m.Disks = append(m.Disks, Disk{Name: "/dev/sdb", TableType: "gpt", SizeBytes: 100 << 30, Partitions: []Partition{{Number: 1, Name: "/dev/sdb1", Filesystem: "ext4", MountPoint: "/var", Role: RoleData, Encryption: EncryptionNone}}})
			return m
		}(), want: Restorability{Reasons: []string{ReasonMultiDisk}}},
		{name: "second disk mounted at /srv/media is data, not multi-disk", m: func() *Manifest {
			m := uefiGPT()
			m.Disks = append(m.Disks, Disk{Name: "/dev/sdb", TableType: "gpt", SizeBytes: 100 << 30, Partitions: []Partition{{Number: 1, Name: "/dev/sdb1", Filesystem: "ext4", MountPoint: "/srv/media", Role: RoleData, Encryption: EncryptionNone}}})
			return m
		}(), want: Restorability{Restorable: true, Reasons: []string{}}},
		{name: "removable second disk ignored", m: func() *Manifest {
			m := uefiGPT()
			m.Disks = append(m.Disks, Disk{Name: "/dev/sdc", Removable: true, TableType: "mbr", Partitions: []Partition{{Number: 1, Name: "/dev/sdc1", Filesystem: "vfat", MountPoint: "/media/usb", Role: RoleData, Encryption: EncryptionNone}}})
			return m
		}(), want: Restorability{Restorable: true, Reasons: []string{}}},
		{name: "windows ntfs root with bitlocker is restorable", m: &Manifest{
			SchemaVersion: SchemaVersion, Platform: "windows", BootMode: BootModeUEFI,
			Disks: []Disk{{Name: `\\.\PHYSICALDRIVE0`, TableType: "gpt", IsSystem: true, Partitions: []Partition{
				{Number: 1, TypeGUID: "c12a7328-f81f-11d2-ba4b-00a0c93ec93b", Filesystem: "fat32", Role: RoleEFI, Encryption: EncryptionNone},
				{Number: 2, TypeGUID: "e3c9e316-0b5c-4db8-817d-f92df00215ae", Role: RoleMSR, Encryption: EncryptionNone},
				{Number: 3, TypeGUID: "ebd0a0a2-b9e5-4433-87c0-68b6b72699c7", Filesystem: "ntfs", MountPoint: `C:\`, Role: RoleRoot, Encryption: EncryptionBitLocker},
			}}},
		}, want: Restorability{Restorable: true, Reasons: []string{}}},
		{name: "reasons accumulate in fixed order", m: func() *Manifest {
			m := uefiGPT(Partition{Number: 3, Name: "/dev/sda3", Filesystem: "crypto_LUKS", Encryption: EncryptionLUKS, Role: RoleUnknown})
			m.BootMode = BootModeBIOS
			m.Disks[0].TableType = "mbr"
			return m
		}(), want: Restorability{Reasons: []string{ReasonBIOSBoot, ReasonNotGPT, ReasonLUKS}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Assess(tt.m)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("Assess() = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestSystemDisk(t *testing.T) {
	m := uefiGPT()
	if d := m.SystemDisk(); d == nil || d.Name != "/dev/sda" {
		t.Fatalf("SystemDisk() = %+v, want /dev/sda", d)
	}
	m.Disks[0].IsSystem = false
	if d := m.SystemDisk(); d == nil || d.Name != "/dev/sda" {
		t.Fatalf("SystemDisk() should fall back to the disk holding the root mount, got %+v", d)
	}
	m.Disks[0].Partitions[1].MountPoint = ""
	if d := m.SystemDisk(); d != nil {
		t.Fatalf("SystemDisk() = %+v, want nil when nothing is mounted at /", d)
	}
}
