package layout

import (
	"reflect"
	"testing"
)

// util-linux ≥ 2.37 emits numbers/bools unquoted; older versions quote them.
const lsblkModern = `{"blockdevices": [
 {"name":"sda","path":"/dev/sda","type":"disk","size":68719476736,"model":"Virtual Disk","serial":"6000c29c","rm":false,"pttype":"gpt","parttype":null,"partuuid":null,"partflags":null,"fstype":null,"uuid":null,"label":null,"mountpoint":null,"fsused":null,"start":null,"log-sec":512,
  "children":[
   {"name":"sda1","path":"/dev/sda1","type":"part","size":536870912,"model":null,"serial":null,"rm":false,"pttype":"gpt","parttype":"c12a7328-f81f-11d2-ba4b-00a0c93ec93b","partuuid":"1111-aaaa","partflags":null,"fstype":"vfat","uuid":"ABCD-1234","label":null,"mountpoint":"/boot/efi","fsused":6291456,"start":2048,"log-sec":512},
   {"name":"sda2","path":"/dev/sda2","type":"part","size":68180508672,"model":null,"serial":null,"rm":false,"pttype":"gpt","parttype":"0fc63daf-8483-4772-8e79-3d69d8477de4","partuuid":"2222-bbbb","partflags":null,"fstype":"ext4","uuid":"9f7a-root","label":"cloudimg-rootfs","mountpoint":"/","fsused":8589934592,"start":1050624,"log-sec":512}
  ]},
 {"name":"sdb","path":"/dev/sdb","type":"disk","size":107374182400,"model":"Data","serial":"6000c2ff","rm":false,"pttype":"gpt","fstype":null,"mountpoint":null,"log-sec":512,
  "children":[
   {"name":"sdb1","path":"/dev/sdb1","type":"part","size":107372085248,"pttype":"gpt","parttype":"0fc63daf-8483-4772-8e79-3d69d8477de4","partuuid":"3333-cccc","fstype":"crypto_LUKS","uuid":"luks-uuid","mountpoint":null,"start":2048,"log-sec":512,
    "children":[{"name":"data_crypt","path":"/dev/mapper/data_crypt","type":"crypt","size":107355308032,"fstype":"ext4","uuid":"inner","mountpoint":"/srv/data","fsused":1024,"log-sec":512}]}
  ]},
 {"name":"sr0","path":"/dev/sr0","type":"rom","size":1073741824,"rm":true,"fstype":null,"mountpoint":null},
 {"name":"loop0","path":"/dev/loop0","type":"loop","size":4096,"fstype":"squashfs","mountpoint":"/snap/core/1"}
]}`

const lsblkLegacyQuoted = `{"blockdevices": [
 {"name":"nvme0n1","path":"/dev/nvme0n1","type":"disk","size":"512110190592","model":"Samsung","serial":"S4EV","rm":"0","pttype":"gpt","log-sec":"512",
  "children":[
   {"name":"nvme0n1p1","path":"/dev/nvme0n1p1","type":"part","size":"1073741824","pttype":"gpt","parttype":"c12a7328-f81f-11d2-ba4b-00a0c93ec93b","partuuid":"p1","fstype":"vfat","uuid":"EFI1","mountpoint":"/boot/efi","fsused":"1048576","start":"2048","log-sec":"512"},
   {"name":"nvme0n1p2","path":"/dev/nvme0n1p2","type":"part","size":"511035342848","pttype":"gpt","parttype":"0fc63daf-8483-4772-8e79-3d69d8477de4","partuuid":"p2","fstype":"xfs","uuid":"ROOT1","mountpoint":"/","fsused":"20000000000","start":"2099200","log-sec":"512"}
  ]}
]}`

func TestParseLsblkModern(t *testing.T) {
	disks, err := parseLsblk([]byte(lsblkModern))
	if err != nil {
		t.Fatal(err)
	}
	if len(disks) != 2 {
		t.Fatalf("got %d disks (%+v), want 2 (rom/loop skipped)", len(disks), disks)
	}
	sda := disks[0]
	if sda.Name != "/dev/sda" || sda.TableType != "gpt" || sda.Model != "Virtual Disk" || sda.Serial != "6000c29c" || sda.SectorSize != 512 || !sda.IsSystem {
		t.Fatalf("sda = %+v", sda)
	}
	want1 := Partition{Number: 1, Name: "/dev/sda1", TypeGUID: GUIDEFISystem, PartUUID: "1111-aaaa", StartBytes: 2048 * 512, SizeBytes: 536870912, UsedBytes: 6291456, Filesystem: "vfat", FSUUID: "ABCD-1234", MountPoint: "/boot/efi", Encryption: EncryptionNone, Role: RoleEFI}
	if !reflect.DeepEqual(sda.Partitions[0], want1) {
		t.Errorf("sda1 = %+v\nwant %+v", sda.Partitions[0], want1)
	}
	if sda.Partitions[1].Role != RoleRoot || sda.Partitions[1].Label != "cloudimg-rootfs" || sda.Partitions[1].StartBytes != 1050624*512 {
		t.Errorf("sda2 = %+v", sda.Partitions[1])
	}
	sdb := disks[1]
	if sdb.IsSystem {
		t.Errorf("sdb must not be the system disk")
	}
	if got := sdb.Partitions[0]; got.Filesystem != "crypto_LUKS" || got.Encryption != EncryptionLUKS {
		t.Errorf("sdb1 = %+v, want LUKS", got)
	}
	// The dm-crypt child is reported as a Kind="crypt" entry under the same disk.
	if len(sdb.Partitions) != 2 || sdb.Partitions[1].Kind != "crypt" || sdb.Partitions[1].MountPoint != "/srv/data" || sdb.Partitions[1].Number != 0 {
		t.Errorf("sdb children = %+v", sdb.Partitions)
	}
}

func TestParseLsblkLegacyQuotedNumbers(t *testing.T) {
	disks, err := parseLsblk([]byte(lsblkLegacyQuoted))
	if err != nil {
		t.Fatal(err)
	}
	if len(disks) != 1 || disks[0].SizeBytes != 512110190592 || disks[0].Removable {
		t.Fatalf("disks = %+v", disks)
	}
	p := disks[0].Partitions
	if p[0].Number != 1 || p[1].Number != 2 {
		t.Errorf("nvme partition numbers = %d,%d want 1,2", p[0].Number, p[1].Number)
	}
	if p[1].Filesystem != "xfs" || p[1].Role != RoleRoot || p[1].UsedBytes != 20000000000 {
		t.Errorf("p2 = %+v", p[1])
	}
}

func TestParseLsblkRejectsGarbage(t *testing.T) {
	if _, err := parseLsblk([]byte("not json")); err == nil {
		t.Fatal("expected error")
	}
}

func TestPartitionNumberFromName(t *testing.T) {
	for name, want := range map[string]int{"sda1": 1, "sda12": 12, "nvme0n1p3": 3, "mmcblk0p2": 2, "sda": 0, "data_crypt": 0} {
		if got := partitionNumberFromName(name); got != want {
			t.Errorf("%s: got %d want %d", name, got, want)
		}
	}
}

func TestParseEFIBootMgr(t *testing.T) {
	out := "BootCurrent: 0001\nTimeout: 1 seconds\nBootOrder: 0001,0000,0002\n" +
		"Boot0000* UiApp\tFvVol(7cb8bdc9-f8eb-4f34-aaea-3ee4af6516a1)/FvFile(462caa21-7614-4503-836e-8ab6f4662331)\n" +
		"Boot0001* ubuntu\tHD(1,GPT,1111-aaaa,0x800,0x100000)/File(\\EFI\\ubuntu\\shimx64.efi)\n" +
		"Boot0002  Windows Boot Manager\tHD(1,GPT,abcd,0x800,0x100000)/File(\\EFI\\Microsoft\\Boot\\bootmgfw.efi)\n"
	got := parseEFIBootMgr(out)
	want := []EFIEntry{
		{BootNum: "0000", Label: "UiApp", Path: "FvVol(7cb8bdc9-f8eb-4f34-aaea-3ee4af6516a1)/FvFile(462caa21-7614-4503-836e-8ab6f4662331)", Active: true},
		{BootNum: "0001", Label: "ubuntu", Path: `HD(1,GPT,1111-aaaa,0x800,0x100000)/File(\EFI\ubuntu\shimx64.efi)`, Active: true, Current: true},
		{BootNum: "0002", Label: "Windows Boot Manager", Path: `HD(1,GPT,abcd,0x800,0x100000)/File(\EFI\Microsoft\Boot\bootmgfw.efi)`, Active: false},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v\nwant %+v", got, want)
	}
}

func TestParseOSRelease(t *testing.T) {
	s := "NAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\nID=ubuntu\n"
	if got := parseOSRelease(s); got != "Ubuntu 24.04.1 LTS" {
		t.Errorf("got %q", got)
	}
	if got := parseOSRelease("ID=alpine\nNAME=Alpine\n"); got != "Alpine" {
		t.Errorf("fallback to NAME, got %q", got)
	}
}
