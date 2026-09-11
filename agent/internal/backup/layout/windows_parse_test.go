package layout

import "testing"

const windowsLayoutJSON = `{"firmware":"UEFI","os":"Microsoft Windows Server 2022 Standard","hostname":"WIN-A",
"disks":[{"Number":0,"FriendlyName":"Msft Virtual Disk","SerialNumber":"6002248","Size":137438953472,"PartitionStyle":"GPT","IsSystem":true,"IsBoot":true,"LogicalSectorSize":512,"BusType":"SAS"},
         {"Number":1,"FriendlyName":"USB Flash","SerialNumber":"USB1","Size":32000000000,"PartitionStyle":"MBR","IsSystem":false,"IsBoot":false,"LogicalSectorSize":512,"BusType":"USB"}],
"partitions":[
 {"DiskNumber":0,"PartitionNumber":1,"Guid":"{aaaa-1}","GptType":"{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}","Offset":1048576,"Size":104857600,"DriveLetter":"\u0000","IsSystem":true,"IsBoot":false,"IsActive":false,"IsHidden":true,"Type":"System","AccessPaths":["\\\\?\\Volume{efi-guid}\\"]},
 {"DiskNumber":0,"PartitionNumber":2,"Guid":"{aaaa-2}","GptType":"{e3c9e316-0b5c-4db8-817d-f92df00215ae}","Offset":105906176,"Size":16777216,"DriveLetter":"\u0000","IsSystem":false,"IsBoot":false,"IsActive":false,"IsHidden":true,"Type":"Reserved","AccessPaths":null},
 {"DiskNumber":0,"PartitionNumber":3,"Guid":"{aaaa-3}","GptType":"{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}","Offset":122683392,"Size":136700000000,"DriveLetter":"C","IsSystem":false,"IsBoot":true,"IsActive":false,"IsHidden":false,"Type":"Basic","AccessPaths":["C:\\","\\\\?\\Volume{c-guid}\\"]},
 {"DiskNumber":0,"PartitionNumber":4,"Guid":"{aaaa-4}","GptType":"{de94bba4-06d1-4d40-a16a-bfd50179d6ac}","Offset":136822683392,"Size":600000000,"DriveLetter":"\u0000","IsSystem":false,"IsBoot":false,"IsActive":false,"IsHidden":true,"Type":"Recovery","AccessPaths":["\\\\?\\Volume{rec-guid}\\"]},
 {"DiskNumber":1,"PartitionNumber":1,"Guid":null,"GptType":null,"Offset":1048576,"Size":31000000000,"DriveLetter":"E","IsSystem":false,"IsBoot":false,"IsActive":true,"IsHidden":false,"Type":"IFS","AccessPaths":["E:\\"]}],
"volumes":[
 {"DriveLetter":"C","Path":"\\\\?\\Volume{c-guid}\\","UniqueId":"\\\\?\\Volume{c-guid}\\","FileSystem":"NTFS","FileSystemLabel":"OS","Size":136700000000,"SizeRemaining":90000000000},
 {"DriveLetter":null,"Path":"\\\\?\\Volume{efi-guid}\\","UniqueId":"\\\\?\\Volume{efi-guid}\\","FileSystem":"FAT32","FileSystemLabel":"SYSTEM","Size":104857600,"SizeRemaining":70000000},
 {"DriveLetter":"E","Path":"\\\\?\\Volume{e-guid}\\","UniqueId":"\\\\?\\Volume{e-guid}\\","FileSystem":"exFAT","FileSystemLabel":"USB","Size":31000000000,"SizeRemaining":1000}],
"bitlocker":[{"MountPoint":"C:","ProtectionStatus":1}]}`

func TestParseWindowsLayout(t *testing.T) {
	m, err := parseWindowsLayout([]byte(windowsLayoutJSON))
	if err != nil {
		t.Fatal(err)
	}
	if m.Platform != "windows" || m.BootMode != BootModeUEFI || m.OSRelease != "Microsoft Windows Server 2022 Standard" || m.Hostname != "WIN-A" {
		t.Fatalf("header = %+v", m)
	}
	if len(m.Disks) != 2 {
		t.Fatalf("disks = %+v", m.Disks)
	}
	d0 := m.Disks[0]
	if d0.Name != `\\.\PHYSICALDRIVE0` || d0.TableType != "gpt" || !d0.IsSystem || d0.Serial != "6002248" || d0.SectorSize != 512 || d0.Removable {
		t.Fatalf("disk0 = %+v", d0)
	}
	if m.Disks[1].TableType != "mbr" || !m.Disks[1].Removable || m.Disks[1].IsSystem {
		t.Errorf("disk1 = %+v", m.Disks[1])
	}
	p := d0.Partitions
	if len(p) != 4 {
		t.Fatalf("disk0 partitions = %+v", p)
	}
	if p[0].Role != RoleEFI || p[0].TypeGUID != GUIDEFISystem || p[0].Filesystem != "fat32" || p[0].PartUUID != "aaaa-1" || p[0].StartBytes != 1048576 || p[0].UsedBytes != 104857600-70000000 {
		t.Errorf("efi = %+v", p[0])
	}
	if p[1].Role != RoleMSR || p[1].Filesystem != "" {
		t.Errorf("msr = %+v", p[1])
	}
	if p[2].Role != RoleRoot || p[2].MountPoint != `C:\` || p[2].Filesystem != "ntfs" || p[2].Label != "OS" || p[2].Encryption != EncryptionBitLocker || p[2].UsedBytes != 136700000000-90000000000 {
		t.Errorf("C: = %+v", p[2])
	}
	if p[3].Role != RoleRecovery {
		t.Errorf("recovery = %+v", p[3])
	}
	if v := Assess(m); !v.Restorable {
		t.Errorf("verdict = %+v", v)
	}
}

func TestParseWindowsLayoutLegacyFirmwareAndNoBitLockerModule(t *testing.T) {
	m, err := parseWindowsLayout([]byte(`{"firmware":"Legacy","os":"Windows 10 Pro","hostname":"PC","disks":[{"Number":0,"FriendlyName":"X","SerialNumber":"","Size":1,"PartitionStyle":"MBR","IsSystem":true,"IsBoot":true,"LogicalSectorSize":512,"BusType":"SATA"}],"partitions":[],"volumes":[],"bitlocker":null}`))
	if err != nil {
		t.Fatal(err)
	}
	if m.BootMode != BootModeBIOS || len(m.Incomplete) != 1 || m.Incomplete[0] != "bitlocker" {
		t.Errorf("m = %+v", m)
	}
}
