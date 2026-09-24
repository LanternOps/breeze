package rebuild

import (
	"encoding/binary"
	"errors"
	"fmt"
	"testing"
	"unsafe"

	"github.com/breeze-rmm/agent/internal/backup/wingpt"
	"github.com/breeze-rmm/agent/internal/backup/winhive"
)

func TestLetterCandidates_DescendsZToD(t *testing.T) {
	got := letterCandidates()
	if len(got) != 23 || got[0] != 'Z' || got[len(got)-1] != 'D' {
		t.Fatalf("letterCandidates = %q, want Z..D", string(got))
	}
	for i := 1; i < len(got); i++ {
		if got[i] != got[i-1]-1 {
			t.Fatalf("not strictly descending at %d: %q", i, string(got))
		}
	}
}

// format.com argument order: <volume> /FS:<fs> /Q /Y [/V:<label>].
func TestFormatComArgs(t *testing.T) {
	check := func(got, want []string) {
		t.Helper()
		if len(got) != len(want) {
			t.Fatalf("args = %q, want %q", got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("args = %q, want %q", got, want)
			}
		}
	}
	check(formatComArgs(`\\?\Volume{x}\`, "ntfs", "WINDOWS"), []string{`\\?\Volume{x}\`, "/FS:NTFS", "/Q", "/Y", "/V:WINDOWS"})
	check(formatComArgs(`\\?\Volume{y}\`, "fat32", ""), []string{`\\?\Volume{y}\`, "/FS:FAT32", "/Q", "/Y"})
	check(formatComArgs(`\\?\Volume{z}\`, "vfat", "SYSTEM"), []string{`\\?\Volume{z}\`, "/FS:FAT32", "/Q", "/Y", "/V:SYSTEM"})
}

func TestVolumeDevicePath(t *testing.T) {
	if got := volumeDevicePath(`\\?\Volume{3f2504e0-4f89-11d3-9a0c-0305e82c3301}\`); got != `\\.\Volume{3f2504e0-4f89-11d3-9a0c-0305e82c3301}` {
		t.Fatalf("volumeDevicePath = %q", got)
	}
}

// GetVirtualDiskPhysicalPath returns \\.\PhysicalDriveN; accept its case
// and \\?\ variants, reject anything else.
func TestPhysicalDriveNumber(t *testing.T) {
	for in, want := range map[string]int{`\\.\PhysicalDrive3`: 3, `\\.\PHYSICALDRIVE12`: 12, `\\?\PhysicalDrive0`: 0} {
		if got, err := physicalDriveNumber(in); err != nil || got != want {
			t.Errorf("physicalDriveNumber(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	for _, bad := range []string{`\\.\PhysicalDrive`, `\\.\CdRom0`, `/dev/sdb`, `\\.\PhysicalDrive1x`} {
		if _, err := physicalDriveNumber(bad); err == nil {
			t.Errorf("physicalDriveNumber(%q) = nil error", bad)
		}
	}
}

func TestDriveGeometryIoctl(t *testing.T) {
	if ioctlDiskGetDriveGeometryEx != wingpt.CtlCode(7, 0x28, 0, 0) || ioctlDiskGetDriveGeometryEx != 0x000700A0 {
		t.Fatalf("IOCTL_DISK_GET_DRIVE_GEOMETRY_EX = %#x, want 0x700A0", ioctlDiskGetDriveGeometryEx)
	}
}

// The virtdisk.h structs cross the syscall boundary as raw memory; a layout
// drift is ERROR_INVALID_PARAMETER at runtime, not a compile error. Offsets
// are for 64-bit Windows (amd64/arm64), the only Windows agent targets.
func TestVirtdiskStructLayouts(t *testing.T) {
	if unsafe.Sizeof(uintptr(0)) != 8 {
		t.Skip("layouts pinned for 64-bit targets")
	}
	var c createVirtualDiskParametersV2
	for name, got := range map[string]uintptr{
		"UniqueID": unsafe.Offsetof(c.UniqueID), "MaximumSize": unsafe.Offsetof(c.MaximumSize),
		"BlockSizeInBytes": unsafe.Offsetof(c.BlockSizeInBytes), "SectorSizeInBytes": unsafe.Offsetof(c.SectorSizeInBytes),
		"PhysicalSectorSizeInBytes": unsafe.Offsetof(c.PhysicalSectorSizeInBytes), "ParentPath": unsafe.Offsetof(c.ParentPath),
		"SourcePath": unsafe.Offsetof(c.SourcePath), "OpenFlags": unsafe.Offsetof(c.OpenFlags),
		"ParentVirtualStorageType": unsafe.Offsetof(c.ParentVirtualStorageType), "SourceVirtualStorageType": unsafe.Offsetof(c.SourceVirtualStorageType),
		"ResiliencyGUID": unsafe.Offsetof(c.ResiliencyGUID),
	} {
		want := map[string]uintptr{"UniqueID": 8, "MaximumSize": 24, "BlockSizeInBytes": 32, "SectorSizeInBytes": 36,
			"PhysicalSectorSizeInBytes": 40, "ParentPath": 48, "SourcePath": 56, "OpenFlags": 64,
			"ParentVirtualStorageType": 68, "SourceVirtualStorageType": 88, "ResiliencyGUID": 108}[name]
		if got != want {
			t.Errorf("CREATE_VIRTUAL_DISK_PARAMETERS.Version2.%s @%d, want @%d", name, got, want)
		}
	}
	if s := unsafe.Sizeof(c); s != 128 {
		t.Errorf("sizeof(createVirtualDiskParametersV2) = %d, want 128", s)
	}
	if s := unsafe.Sizeof(virtualStorageType{}); s != 20 {
		t.Errorf("sizeof(VIRTUAL_STORAGE_TYPE) = %d, want 20", s)
	}
	var o openVirtualDiskParametersV2
	if unsafe.Offsetof(o.GetInfoOnly) != 4 || unsafe.Offsetof(o.ReadOnly) != 8 || unsafe.Offsetof(o.ResiliencyGUID) != 12 || unsafe.Sizeof(o) != 28 {
		t.Errorf("OPEN_VIRTUAL_DISK_PARAMETERS V2 layout: %d/%d/%d size %d, want 4/8/12 size 28",
			unsafe.Offsetof(o.GetInfoOnly), unsafe.Offsetof(o.ReadOnly), unsafe.Offsetof(o.ResiliencyGUID), unsafe.Sizeof(o))
	}
	var a attachVirtualDiskParametersV2
	if unsafe.Offsetof(a.RestrictedOffset) != 8 || unsafe.Offsetof(a.RestrictedLength) != 16 || unsafe.Sizeof(a) != 24 {
		t.Errorf("ATTACH_VIRTUAL_DISK_PARAMETERS V2 layout wrong: size %d", unsafe.Sizeof(a))
	}
	// VIRTUAL_STORAGE_TYPE_VENDOR_MICROSOFT {EC984AEC-A0F9-47E9-901F-71415A66345B}, mixed-endian.
	if virtualStorageTypeVHDX.DeviceID != 3 || wingpt.BytesToGUID(virtualStorageTypeVHDX.VendorID) != "ec984aec-a0f9-47e9-901f-71415a66345b" {
		t.Errorf("virtualStorageTypeVHDX = %+v", virtualStorageTypeVHDX)
	}
}

// IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS = CTL_CODE(IOCTL_VOLUME_BASE=0x56, 0,
// METHOD_BUFFERED, FILE_ANY_ACCESS) — SystemDiskNumber's source.
func TestVolumeDiskExtentsIoctl(t *testing.T) {
	if ioctlVolumeGetVolumeDiskExtents != wingpt.CtlCode(0x56, 0, 0, 0) || ioctlVolumeGetVolumeDiskExtents != 0x00560000 {
		t.Fatalf("IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS = %#x, want 0x560000", ioctlVolumeGetVolumeDiskExtents)
	}
}

// VOLUME_DISK_EXTENTS: NumberOfDiskExtents u32@0 (+4 pad), then 24-byte
// DISK_EXTENTs {DiskNumber u32@0 (+4 pad), StartingOffset i64@8,
// ExtentLength i64@16} from offset 8.
func TestParseVolumeDiskExtents(t *testing.T) {
	buf := make([]byte, 8+2*24)
	binary.LittleEndian.PutUint32(buf[0:4], 2)
	binary.LittleEndian.PutUint32(buf[8:12], 3)
	binary.LittleEndian.PutUint64(buf[16:24], 1<<20)
	binary.LittleEndian.PutUint32(buf[32:36], 5)
	got, err := parseVolumeDiskExtents(buf)
	if err != nil || len(got) != 2 || got[0] != 3 || got[1] != 5 {
		t.Fatalf("parseVolumeDiskExtents = %v, %v; want [3 5]", got, err)
	}
	if _, err := parseVolumeDiskExtents(buf[:4]); err == nil {
		t.Error("short header accepted")
	}
	if _, err := parseVolumeDiskExtents(buf[:8+24]); err == nil {
		t.Error("count 2 with room for 1 extent accepted")
	}
	zero := make([]byte, 8)
	if got, err := parseVolumeDiskExtents(zero); err != nil || len(got) != 0 {
		t.Errorf("zero extents = %v, %v", got, err)
	}
}

type recordingHandle struct {
	log      *[]string
	closeErr error
}

func (h recordingHandle) Root() winhive.Key { return nil }
func (h recordingHandle) Close() error {
	*h.log = append(*h.log, "unload")
	return h.closeErr
}

// LoadHive's privilege scope must outlive the hive: Close unloads FIRST
// (RegUnLoadKeyW needs SeBackup+SeRestore) and releases after — once, even
// when the unload fails or Close is called again (winTeardown's backstop
// after validateOSState's explicit Close).
func TestHiveWithRelease_UnloadsThenReleasesOnce(t *testing.T) {
	for _, unloadErr := range []error{nil, errors.New("RegUnLoadKeyW: access denied")} {
		var log []string
		h := &hiveWithRelease{Handle: recordingHandle{log: &log, closeErr: unloadErr}, release: func() { log = append(log, "release") }}
		if err := h.Close(); !errors.Is(err, unloadErr) {
			t.Fatalf("Close = %v, want %v", err, unloadErr)
		}
		if err := h.Close(); err != nil {
			t.Fatalf("second Close = %v, want nil", err)
		}
		if len(log) != 2 || log[0] != "unload" || log[1] != "release" {
			t.Fatalf("call order = %v, want [unload release]", log)
		}
	}
}

// R1: VolumesOnDisk must never silently drop a volume that has an extent on
// the target disk. The device-number answer is used when it exists; when
// the IOCTL fails (dynamic-disk simple/spanned/mirrored volumes) the disk
// extents decide, and an extent on the target is an error — the preflight
// Windows-tree guard and WipeDisk's lock/dismount would otherwise never see
// that volume. Only a device that is provably elsewhere, or that answers
// both IOCTLs with a definite "not supported" (errNotADiskDevice), is
// skipped; an unopenable device or any other IOCTL failure is an error.
func TestClassifyVolume(t *testing.T) {
	failed := errors.New("ioctl failed")
	for _, tc := range []struct {
		name    string
		dn      storageDeviceNumberResult
		dnErr   error
		extents []int
		extErr  error
		include bool
		part    int
		wantErr bool
	}{
		{"basic volume on target", storageDeviceNumberResult{fileDeviceDisk, 2, 3}, nil, nil, nil, true, 3, false},
		{"basic volume elsewhere", storageDeviceNumberResult{fileDeviceDisk, 0, 1}, nil, nil, nil, false, 0, false},
		{"cd-rom", storageDeviceNumberResult{0x2, 2, 0}, nil, nil, nil, false, 0, false},
		{"dynamic volume with an extent on target", storageDeviceNumberResult{}, failed, []int{0, 2}, nil, false, 0, true},
		{"dynamic volume only elsewhere", storageDeviceNumberResult{}, failed, []int{0, 1}, nil, false, 0, false},
		{"not a disk at all (both IOCTLs unsupported)", storageDeviceNumberResult{}, fmt.Errorf("x: %w", errNotADiskDevice), nil, fmt.Errorf("y: %w", errNotADiskDevice), false, 0, false},
		{"device number unsupported, extents fail otherwise", storageDeviceNumberResult{}, fmt.Errorf("x: %w", errNotADiskDevice), nil, failed, false, 0, true},
		{"both IOCTLs fail for another reason", storageDeviceNumberResult{}, failed, nil, failed, false, 0, true},
		{"device cannot be opened", storageDeviceNumberResult{}, errors.New("open \\\\.\\Volume{x}: access denied"), nil, errors.New("open: access denied"), false, 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			include, part, err := classifyVolume(`\\?\Volume{x}\`, 2, tc.dn, tc.dnErr, func() ([]int, error) { return tc.extents, tc.extErr })
			if include != tc.include || part != tc.part || (err != nil) != tc.wantErr {
				t.Fatalf("classifyVolume = %v, %d, %v; want %v, %d, err=%v", include, part, err, tc.include, tc.part, tc.wantErr)
			}
		})
	}
}

// R3: GET_DISK_ATTRIBUTES is 16 bytes; anything shorter is unknown and
// must not read as "online and writable".
func TestParseDiskAttributes(t *testing.T) {
	buf := make([]byte, 16)
	binary.LittleEndian.PutUint64(buf[8:16], 0x3)
	if off, ro, err := parseDiskAttributes(buf); err != nil || !off || !ro {
		t.Fatalf("parseDiskAttributes(0x3) = %v, %v, %v", off, ro, err)
	}
	binary.LittleEndian.PutUint64(buf[8:16], 0)
	if off, ro, err := parseDiskAttributes(buf); err != nil || off || ro {
		t.Fatalf("parseDiskAttributes(0) = %v, %v, %v", off, ro, err)
	}
	if _, _, err := parseDiskAttributes(buf[:8]); err == nil {
		t.Fatal("short GET_DISK_ATTRIBUTES output accepted")
	}
}

// R4: the VHDX virtual size must be a multiple of its logical sector size.
func TestVHDXGeometry(t *testing.T) {
	for _, tc := range []struct {
		size       int64
		sector     int
		wantSize   uint64
		wantSector uint32
	}{
		{64 * MiB, 512, 64 << 20, 512},
		{64*MiB + 1, 512, 64<<20 + 512, 512},
		{64*MiB + 1, 4096, 64<<20 + 4096, 4096},
		{1000, 0, 1024, 512},
		{4096, 520, 4096, 512},
	} {
		size, sector := vhdxGeometry(tc.size, tc.sector)
		if size != tc.wantSize || sector != tc.wantSector {
			t.Errorf("vhdxGeometry(%d, %d) = %d, %d; want %d, %d", tc.size, tc.sector, size, sector, tc.wantSize, tc.wantSector)
		}
	}
}

// A just-arrived RAW volume answers GetFileAttributes with
// ERROR_INVALID_PARAMETER for well under 100 ms before settling (lab,
// Server 2022: 4 of 10 VHDX round trips) — retryTransient absorbs that
// window and still surfaces an error that persists, or any other error at
// once.
func TestRetryTransient(t *testing.T) {
	errTransient, errOther := errors.New("transient"), errors.New("other")
	isTransient := func(err error) bool { return errors.Is(err, errTransient) }

	calls := 0
	err := retryTransient(5, 0, isTransient, func() error {
		calls++
		if calls < 3 {
			return errTransient
		}
		return nil
	})
	if err != nil || calls != 3 {
		t.Fatalf("settling error: err=%v calls=%d, want nil after 3", err, calls)
	}

	calls = 0
	err = retryTransient(5, 0, isTransient, func() error { calls++; return errTransient })
	if !errors.Is(err, errTransient) || calls != 5 {
		t.Fatalf("persistent transient error: err=%v calls=%d, want errTransient after 5", err, calls)
	}

	calls = 0
	err = retryTransient(5, 0, isTransient, func() error { calls++; return errOther })
	if !errors.Is(err, errOther) || calls != 1 {
		t.Fatalf("non-transient error: err=%v calls=%d, want errOther after 1", err, calls)
	}
}

// Final-review Imp 7: Format's temporary letter is released on every path,
// and a release failure is joined to — never dropped behind — the
// format.com error.
func TestWithTemporaryLetter_JoinsReleaseError(t *testing.T) {
	formatErr, releaseErr := errors.New("format.com failed"), errors.New("DeleteVolumeMountPointW failed")
	released := 0
	assign := func(string) (string, func() error, error) {
		return "Q", func() error { released++; return releaseErr }, nil
	}
	err := withTemporaryLetter(`\\?\Volume{x}\`, assign, func(letter string) error {
		if letter != "Q" {
			t.Fatalf("letter = %q", letter)
		}
		return formatErr
	})
	if !errors.Is(err, formatErr) || !errors.Is(err, releaseErr) || released != 1 {
		t.Fatalf("err = %v (released %d), want both the format and the release error", err, released)
	}
	// Success path: a release failure alone still fails the call.
	if err := withTemporaryLetter(`\\?\Volume{x}\`, assign, func(string) error { return nil }); !errors.Is(err, releaseErr) {
		t.Fatalf("err = %v, want the release error", err)
	}
	// No letter, no call.
	called := false
	err = withTemporaryLetter(`\\?\Volume{x}\`, func(string) (string, func() error, error) { return "", nil, errors.New("no free letter") },
		func(string) error { called = true; return nil })
	if err == nil || called {
		t.Fatalf("err = %v called = %v, want an error and no format call", err, called)
	}
}
