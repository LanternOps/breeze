package wingpt

import (
	"encoding/hex"
	"strings"
	"testing"
)

// TestCtlCode pins every IOCTL/FSCTL constant this package exports against
// the CTL_CODE macro from <devioctl.h> (deviceType<<16 | access<<14 |
// function<<2 | method), rather than trusting copied hex literals — a wrong
// device-type/function/access combination compiles and links fine and
// silently issues a DIFFERENT ioctl at runtime (the exact failure class the
// vssapi.dll vtable-index comment in agent/internal/backup/vss/vss_windows.go
// warns about for a different API surface).
func TestCtlCode(t *testing.T) {
	const (
		fileDeviceDisk        = 0x00000007
		fileDeviceMassStorage = 0x0000002D
		fileDeviceFileSystem  = 0x00000009
		methodBuffered        = 0
		fileAnyAccess         = 0
		fileReadAccess        = 1
		fileReadWriteAccess   = 3
	)
	tests := []struct {
		name                                 string
		deviceType, function, method, access uint32
		want                                 uint32
	}{
		{"IOCTL_DISK_GET_DRIVE_LAYOUT_EX", fileDeviceDisk, 0x14, methodBuffered, fileAnyAccess, 0x00070050},
		{"IOCTL_DISK_SET_DRIVE_LAYOUT_EX", fileDeviceDisk, 0x15, methodBuffered, fileReadWriteAccess, 0x0007C054},
		{"IOCTL_DISK_CREATE_DISK", fileDeviceDisk, 0x16, methodBuffered, fileReadWriteAccess, 0x0007C058},
		{"IOCTL_DISK_DELETE_DRIVE_LAYOUT", fileDeviceDisk, 0x40, methodBuffered, fileReadWriteAccess, 0x0007C100},
		{"IOCTL_DISK_UPDATE_PROPERTIES", fileDeviceDisk, 0x50, methodBuffered, fileAnyAccess, 0x00070140},
		{"IOCTL_DISK_GET_LENGTH_INFO", fileDeviceDisk, 0x17, methodBuffered, fileReadAccess, 0x0007405C},
		{"IOCTL_STORAGE_GET_DEVICE_NUMBER", fileDeviceMassStorage, 0x420, methodBuffered, fileAnyAccess, 0x002D1080},
		{"IOCTL_DISK_GET_DISK_ATTRIBUTES", fileDeviceDisk, 0x3C, methodBuffered, fileAnyAccess, 0x000700F0},
		{"FSCTL_LOCK_VOLUME", fileDeviceFileSystem, 6, methodBuffered, fileAnyAccess, 0x00090018},
		{"FSCTL_DISMOUNT_VOLUME", fileDeviceFileSystem, 8, methodBuffered, fileAnyAccess, 0x00090020},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := CtlCode(tt.deviceType, tt.function, tt.method, tt.access); got != tt.want {
				t.Errorf("CtlCode(%#x,%#x,%#x,%#x) = %#08x, want %#08x", tt.deviceType, tt.function, tt.method, tt.access, got, tt.want)
			}
		})
	}
	// The package's own exported constants must equal the same computation
	// — this is what actually protects the constants from silent hand-edit
	// drift, not the table above by itself.
	if IOCTLDiskGetDriveLayoutEx != 0x00070050 {
		t.Errorf("IOCTLDiskGetDriveLayoutEx = %#08x", IOCTLDiskGetDriveLayoutEx)
	}
	if IOCTLDiskSetDriveLayoutEx != 0x0007C054 {
		t.Errorf("IOCTLDiskSetDriveLayoutEx = %#08x", IOCTLDiskSetDriveLayoutEx)
	}
	if IOCTLDiskCreateDisk != 0x0007C058 {
		t.Errorf("IOCTLDiskCreateDisk = %#08x", IOCTLDiskCreateDisk)
	}
	if IOCTLDiskDeleteDriveLayout != 0x0007C100 {
		t.Errorf("IOCTLDiskDeleteDriveLayout = %#08x", IOCTLDiskDeleteDriveLayout)
	}
	if IOCTLDiskUpdateProperties != 0x00070140 {
		t.Errorf("IOCTLDiskUpdateProperties = %#08x", IOCTLDiskUpdateProperties)
	}
	if IOCTLDiskGetLengthInfo != 0x0007405C {
		t.Errorf("IOCTLDiskGetLengthInfo = %#08x", IOCTLDiskGetLengthInfo)
	}
	if IOCTLStorageGetDeviceNumber != 0x002D1080 {
		t.Errorf("IOCTLStorageGetDeviceNumber = %#08x", IOCTLStorageGetDeviceNumber)
	}
	if IOCTLDiskGetDiskAttributes != 0x000700F0 {
		t.Errorf("IOCTLDiskGetDiskAttributes = %#08x", IOCTLDiskGetDiskAttributes)
	}
	if FSCTLLockVolume != 0x00090018 {
		t.Errorf("FSCTLLockVolume = %#08x", FSCTLLockVolume)
	}
	if FSCTLDismountVolume != 0x00090020 {
		t.Errorf("FSCTLDismountVolume = %#08x", FSCTLDismountVolume)
	}
}

// TestGUIDToBytesKnownVector pins the mixed-endian encoding against the
// EFI System Partition type GUID's well-known byte representation, exactly
// as it appears on the wire in a live PARTITION_INFORMATION_GPT.PartitionType
// field on any Windows host: 28 73 2A C1 1F F8 D2 11 BA 4B 00 A0 C9 3E C9 3B.
func TestGUIDToBytesKnownVector(t *testing.T) {
	const want = "28732ac11ff8d211ba4b00a0c93ec93b"
	got, err := GUIDToBytes("c12a7328-f81f-11d2-ba4b-00a0c93ec93b")
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(got[:]) != want {
		t.Errorf("GUIDToBytes = %x, want %s", got, want)
	}
}

func TestGUIDBytesRoundTrip(t *testing.T) {
	guids := []string{
		"c12a7328-f81f-11d2-ba4b-00a0c93ec93b",
		"e3c9e316-0b5c-4db8-817d-f92df00215ae",
		"00000000-0000-0000-0000-000000000000",
		"ffffffff-ffff-ffff-ffff-ffffffffffff",
	}
	for _, g := range guids {
		b, err := GUIDToBytes(g)
		if err != nil {
			t.Fatalf("GUIDToBytes(%s): %v", g, err)
		}
		if got := BytesToGUID(b); got != g {
			t.Errorf("BytesToGUID(GUIDToBytes(%s)) = %s, want %s", g, got, g)
		}
	}
}

func TestGUIDToBytesRejectsMalformed(t *testing.T) {
	for _, bad := range []string{"", "not-a-guid", "c12a7328-f81f-11d2-ba4b", "{c12a7328-f81f-11d2-ba4b-00a0c93ec93bXX}"} {
		if _, err := GUIDToBytes(bad); err == nil {
			t.Errorf("GUIDToBytes(%q) = nil error, want error", bad)
		}
	}
}

// TestEncodeDecodeDriveLayoutExRoundTrip and TestEncodeDriveLayoutExByteOffsets
// pin the exact byte layout of DRIVE_LAYOUT_INFORMATION_EX / PARTITION_INFORMATION_EX
// on x64: header 48 bytes (PartitionStyle u32@0, PartitionCount u32@4, GPT.DiskId
// GUID@8, StartingUsableOffset i64@24, UsableLength i64@32, MaxPartitionCount
// u32@40, 4 bytes pad@44), then one 144-byte PARTITION_INFORMATION_EX per
// partition: PartitionStyle u32@0, StartingOffset i64@8, PartitionLength i64@16,
// PartitionNumber u32@24, RewritePartition u8@28, IsServicePartition u8@29,
// GPT.PartitionType GUID@32, GPT.PartitionId GUID@48, GPT.Attributes u64@64,
// GPT.Name [36]u16@72.
func TestEncodeDecodeDriveLayoutExRoundTrip(t *testing.T) {
	l := Layout{
		DiskGUID: "11111111-2222-3333-4444-555555555555",
		Partitions: []Partition{
			{
				Number:     1,
				TypeGUID:   "c12a7328-f81f-11d2-ba4b-00a0c93ec93b",
				PartGUID:   "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
				Name:       "EFI system partition",
				StartBytes: 1048576,
				SizeBytes:  104857600,
				Attributes: 0x0000000000000001, // GPT_ATTRIBUTE_PLATFORM_REQUIRED
			},
			{
				Number:     2,
				TypeGUID:   "ebd0a0a2-b9e5-4433-87c0-68b6b72699c7",
				PartGUID:   "12121212-3434-5656-7878-909090909090",
				Name:       "Basic data partition",
				StartBytes: 105906176,
				SizeBytes:  136700000000,
				Attributes: 0x8000000000000000, // GPT_BASIC_DATA_ATTRIBUTE_NO_DRIVE_LETTER
			},
		},
	}
	encoded, err := EncodeDriveLayoutEx(l)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeDriveLayoutEx(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.DiskGUID != l.DiskGUID {
		t.Errorf("DiskGUID = %s, want %s", decoded.DiskGUID, l.DiskGUID)
	}
	if len(decoded.Partitions) != len(l.Partitions) {
		t.Fatalf("Partitions = %d, want %d", len(decoded.Partitions), len(l.Partitions))
	}
	for i, want := range l.Partitions {
		got := decoded.Partitions[i]
		if got.Number != want.Number || got.TypeGUID != want.TypeGUID || got.PartGUID != want.PartGUID ||
			got.Name != want.Name || got.StartBytes != want.StartBytes || got.SizeBytes != want.SizeBytes || got.Attributes != want.Attributes {
			t.Errorf("partition %d = %+v, want %+v", i, got, want)
		}
	}
}

func TestEncodeDriveLayoutExByteOffsets(t *testing.T) {
	l := Layout{
		DiskGUID: "c12a7328-f81f-11d2-ba4b-00a0c93ec93b",
		Partitions: []Partition{{
			Number:     7,
			TypeGUID:   "ebd0a0a2-b9e5-4433-87c0-68b6b72699c7",
			PartGUID:   "e3c9e316-0b5c-4db8-817d-f92df00215ae",
			Name:       "data",
			StartBytes: 0x1122334455,
			SizeBytes:  0x6677889900,
			Attributes: 0x8000000000000000,
		}},
	}
	b, err := EncodeDriveLayoutEx(l)
	if err != nil {
		t.Fatal(err)
	}
	const headerSize = 48
	const entrySize = 144
	if len(b) != headerSize+entrySize {
		t.Fatalf("len = %d, want %d", len(b), headerSize+entrySize)
	}
	// Header.
	if got := le32(b[0:4]); got != 1 { // PARTITION_STYLE_GPT
		t.Errorf("header PartitionStyle@0 = %d, want 1", got)
	}
	if got := le32(b[4:8]); got != 1 {
		t.Errorf("header PartitionCount@4 = %d, want 1", got)
	}
	diskGUID, _ := GUIDToBytes(l.DiskGUID)
	if !bytesEqual(b[8:24], diskGUID[:]) {
		t.Errorf("header GPT.DiskId@8 mismatch")
	}
	// Partition entry at offset 48.
	e := b[headerSize:]
	if got := le32(e[0:4]); got != 1 {
		t.Errorf("entry PartitionStyle@0 = %d, want 1", got)
	}
	if got := le64(e[8:16]); got != uint64(l.Partitions[0].StartBytes) {
		t.Errorf("entry StartingOffset@8 = %#x, want %#x", got, l.Partitions[0].StartBytes)
	}
	if got := le64(e[16:24]); got != uint64(l.Partitions[0].SizeBytes) {
		t.Errorf("entry PartitionLength@16 = %#x, want %#x", got, l.Partitions[0].SizeBytes)
	}
	if got := le32(e[24:28]); got != 7 {
		t.Errorf("entry PartitionNumber@24 = %d, want 7", got)
	}
	if e[28] != 1 { // RewritePartition must be TRUE on every entry of a SET_DRIVE_LAYOUT_EX, or Windows ignores the entry
		t.Errorf("entry RewritePartition@28 = %d, want 1", e[28])
	}
	if e[29] != 0 {
		t.Errorf("entry IsServicePartition@29 = %d, want 0", e[29])
	}
	typeGUID, _ := GUIDToBytes(l.Partitions[0].TypeGUID)
	if !bytesEqual(e[32:48], typeGUID[:]) {
		t.Errorf("entry GPT.PartitionType@32 mismatch")
	}
	partGUID, _ := GUIDToBytes(l.Partitions[0].PartGUID)
	if !bytesEqual(e[48:64], partGUID[:]) {
		t.Errorf("entry GPT.PartitionId@48 mismatch")
	}
	if got := le64(e[64:72]); got != l.Partitions[0].Attributes {
		t.Errorf("entry GPT.Attributes@64 = %#x, want %#x", got, l.Partitions[0].Attributes)
	}
	// Name@72 is UTF-16LE, 36 code units wide, NUL-padded.
	wantName := make([]byte, 72) // 36 * 2
	for i, r := range l.Partitions[0].Name {
		wantName[i*2] = byte(r) // ASCII name: low byte = code unit, high byte = 0
	}
	if !bytesEqual(e[72:144], wantName) {
		t.Errorf("entry GPT.Name@72 = %x, want %x", e[72:144], wantName)
	}
}

// TestEncodeDriveLayoutExRejectsMissingPartGUID: Windows does NOT invent a
// PartitionId for a GPT entry whose GUID is zero — it writes the zero GUID.
// The encoder therefore refuses an empty PartGUID; the caller (winProvision,
// W06b Task 11) fills it with NewGUID() when the layout recorded none.
func TestEncodeDriveLayoutExRejectsMissingPartGUID(t *testing.T) {
	l := Layout{DiskGUID: "c12a7328-f81f-11d2-ba4b-00a0c93ec93b", Partitions: []Partition{{
		Number: 1, TypeGUID: "ebd0a0a2-b9e5-4433-87c0-68b6b72699c7", SizeBytes: 100,
	}}}
	if _, err := EncodeDriveLayoutEx(l); err == nil {
		t.Error("expected an error for a partition with no PartGUID")
	}
}

// TestGUIDToBytesMixedEndianVector is the plan-wide GUID byte-order pin
// (also used for MountedDevices DMIO:ID values in W06c).
func TestGUIDToBytesMixedEndianVector(t *testing.T) {
	got, err := GUIDToBytes("{12345678-1234-5678-9abc-def012345678}")
	if err != nil {
		t.Fatal(err)
	}
	const want = "78563412341278569abcdef012345678"
	if hex.EncodeToString(got[:]) != want {
		t.Errorf("GUIDToBytes = %x, want %s", got, want)
	}
}

func TestNewGUIDIsLowerCaseV4(t *testing.T) {
	g, err := NewGUID()
	if err != nil {
		t.Fatal(err)
	}
	if len(g) != 36 || g[14] != '4' || strings.ToLower(g) != g {
		t.Fatalf("NewGUID() = %q, want a lower-case version-4 GUID", g)
	}
	if _, err := GUIDToBytes(g); err != nil {
		t.Fatalf("NewGUID() output does not round-trip: %v", err)
	}
}

// TestEncodeCreateDiskGPT pins CREATE_DISK (GPT variant) on x64:
// PartitionStyle u32@0, CREATE_DISK_GPT.DiskId GUID@4,
// CREATE_DISK_GPT.MaxPartitionCount u32@20, sizeof = 24.
func TestEncodeCreateDiskGPT(t *testing.T) {
	b, err := EncodeCreateDiskGPT("12345678-1234-5678-9abc-def012345678")
	if err != nil {
		t.Fatal(err)
	}
	if len(b) != 24 {
		t.Fatalf("len = %d, want 24", len(b))
	}
	if le32(b[0:4]) != 1 {
		t.Errorf("PartitionStyle@0 = %d, want 1 (GPT)", le32(b[0:4]))
	}
	if hex.EncodeToString(b[4:20]) != "78563412341278569abcdef012345678" {
		t.Errorf("DiskId@4 = %x", b[4:20])
	}
	if le32(b[20:24]) != 128 {
		t.Errorf("MaxPartitionCount@20 = %d, want 128", le32(b[20:24]))
	}
}

// TestCopyUsableRange pins the header bytes WriteLayout carries over from
// the disk's current layout (StartingUsableOffset@24, UsableLength@32,
// MaxPartitionCount@40): Windows computes them at CREATE_DISK time and a
// SET_DRIVE_LAYOUT_EX that zeroes them is rejected with
// ERROR_INVALID_PARAMETER on some builds.
func TestCopyUsableRange(t *testing.T) {
	dst := make([]byte, 48)
	cur := make([]byte, 48)
	for i := range cur {
		cur[i] = byte(i)
	}
	if err := CopyUsableRange(dst, cur); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 48; i++ {
		inRange := i >= 24 && i < 44
		if inRange && dst[i] != byte(i) {
			t.Errorf("byte %d = %d, want copied %d", i, dst[i], i)
		}
		if !inRange && dst[i] != 0 {
			t.Errorf("byte %d = %d, want untouched 0", i, dst[i])
		}
	}
	if err := CopyUsableRange(dst, make([]byte, 10)); err == nil {
		t.Error("expected an error for a truncated current layout")
	}
}

func TestEncodeDriveLayoutExRejectsNameOver36UTF16Units(t *testing.T) {
	name := ""
	for i := 0; i < 37; i++ {
		name += "x"
	}
	l := Layout{DiskGUID: "c12a7328-f81f-11d2-ba4b-00a0c93ec93b", Partitions: []Partition{{
		Number: 1, TypeGUID: "ebd0a0a2-b9e5-4433-87c0-68b6b72699c7", PartGUID: "e3c9e316-0b5c-4db8-817d-f92df00215ae", Name: name, SizeBytes: 100,
	}}}
	if _, err := EncodeDriveLayoutEx(l); err == nil || !strings.Contains(err.Error(), "36 UTF-16") {
		t.Errorf("err = %v, want the 36-code-unit name error", err)
	}
}

func le32(b []byte) uint32 {
	return uint32(b[0]) | uint32(b[1])<<8 | uint32(b[2])<<16 | uint32(b[3])<<24
}
func le64(b []byte) uint64 {
	var v uint64
	for i := 7; i >= 0; i-- {
		v = v<<8 | uint64(b[i])
	}
	return v
}
func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
