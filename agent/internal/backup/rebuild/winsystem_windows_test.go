//go:build windows

package rebuild

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/backup/wingpt"
	"github.com/breeze-rmm/agent/internal/backup/winhive"
)

// requireElevatedForTest skips — loudly — when the process token is not
// elevated: raw disk handles, virtdisk attach and hive loads all need it,
// and every assertion below would otherwise be vacuous. Task 13's Windows
// gate lists every test calling this as must-not-skip, so a non-elevated
// runner is caught, not passed.
func requireElevatedForTest(t *testing.T) {
	t.Helper()
	if !windows.GetCurrentProcessToken().IsElevated() {
		t.Skip("process token is not elevated: real-WinSystem assertions would be vacuous — run elevated")
	}
}

// Live-syscall proof that FindFirstVolumeW + IOCTL_STORAGE_GET_DEVICE_NUMBER
// enumerate a real disk's volumes (an empty result must not read as a
// pass), that the %SystemRoot% volume is among them with the Ruling B1a
// path shape, and that HasWindowsTree sees the running Windows on it.
func TestWinSystem_VolumesOnDiskSystemDisk(t *testing.T) {
	requireElevatedForTest(t)
	sys := NewWinSystem()
	if sys == nil {
		t.Fatal("NewWinSystem() = nil on windows")
	}
	if sys.InWinPE() {
		t.Fatal("InWinPE() = true on a full Windows host")
	}
	if media, err := sys.MediaDiskNumbers(); err != nil || len(media) != 0 {
		t.Fatalf("MediaDiskNumbers() = %v, %v on a live host, want none", media, err)
	}
	n, err := sys.SystemDiskNumber()
	if err != nil || n < 0 {
		t.Fatalf("SystemDiskNumber() = %d, %v", n, err)
	}
	vols, err := sys.VolumesOnDisk(n)
	if err != nil {
		t.Fatal(err)
	}
	if len(vols) == 0 {
		t.Fatal("no volumes enumerated on the system disk")
	}
	winDir, err := windows.GetSystemWindowsDirectory()
	if err != nil {
		t.Fatal(err)
	}
	var sysVol *WinVolume
	for i, v := range vols {
		if !strings.HasPrefix(v.GUIDPath, `\\?\Volume{`) || !strings.HasSuffix(v.GUIDPath, `}\`) {
			t.Errorf("GUIDPath %q is not the \\\\?\\Volume{GUID}\\ form", v.GUIDPath)
		}
		if v.DiskNumber != n || v.PartitionNumber <= 0 {
			t.Errorf("volume %+v: want disk %d and a partition number > 0", v, n)
		}
		if strings.EqualFold(v.DriveLetter, winDir[:1]) {
			sysVol = &vols[i]
		}
	}
	if sysVol == nil {
		t.Fatalf("no volume on disk %d carries drive letter %s: %+v", n, winDir[:1], vols)
	}
	if has, err := sys.HasWindowsTree(sysVol.GUIDPath); err != nil || !has {
		t.Fatalf("HasWindowsTree(system volume %s) = %v, %v; want true", sysVol.GUIDPath, has, err)
	}
	info, err := sys.DiskInfo(n)
	if err != nil || info.SizeBytes <= 0 || (info.LogicalSectorSize != 512 && info.LogicalSectorSize != 4096) {
		t.Fatalf("DiskInfo(%d) = %+v, %v", n, info, err)
	}
}

func TestWinSystem_FreeSpaceWalksUpToAnExistingDir(t *testing.T) {
	free, err := NewWinSystem().FreeSpace(os.TempDir() + `\breeze-does-not-exist\out`)
	if err != nil || free <= 0 {
		t.Fatalf("FreeSpace = %d, %v", free, err)
	}
}

// attachTestVHDX creates and attaches a small dynamic VHDX under a temp dir
// and detaches it in Cleanup.
func attachTestVHDX(t *testing.T, sys WinSystem, sizeBytes int64, sector int) (path string, disk int, detach func() error) {
	t.Helper()
	path = filepath.Join(t.TempDir(), "vhdx", "test.vhdx") // parent does not exist yet: CreateVHDX makes it
	if err := sys.CreateVHDX(path, sizeBytes, sector); err != nil {
		t.Fatalf("CreateVHDX: %v", err)
	}
	disk, detach, err := sys.AttachVHDX(path)
	if err != nil {
		t.Fatalf("AttachVHDX: %v", err)
	}
	t.Cleanup(func() { _ = detach() })
	return path, disk, detach
}

// CreateVHDX honours the logical sector size (512 and 4096) and size, and
// the attached disk is online and writable (a SAN policy that leaves new
// disks offline would break provision later with a much vaguer error).
func TestWinSystem_CreateAttachVHDXSectorSizes(t *testing.T) {
	requireElevatedForTest(t)
	for _, sector := range []int{512, 4096} {
		t.Run(fmt.Sprint(sector), func(t *testing.T) {
			sys := NewWinSystem()
			const size = 64 * MiB
			_, disk, _ := attachTestVHDX(t, sys, size, sector)
			info, err := sys.DiskInfo(disk)
			if err != nil {
				t.Fatal(err)
			}
			if info.SizeBytes != size || info.LogicalSectorSize != sector {
				t.Fatalf("DiskInfo = %+v, want size %d sector %d", info, size, sector)
			}
			if info.Offline || info.ReadOnly {
				t.Fatalf("attached VHDX disk %d is offline=%v read-only=%v (host SAN policy?)", disk, info.Offline, info.ReadOnly)
			}
		})
	}
}

// The whole provision surface against a real attached VHDX: WriteGPT
// passes every GUID/name/attribute straight through, WaitForVolumes
// reports the partition numbers, format.com accepts the \\?\Volume{GUID}\
// path, MountVolume creates a not-yet-existing folder, the GUID path joins
// with filepath.Join into a usable file path (Ruling B1a), HasWindowsTree
// flips when the tree appears, AssignLetter/Flush work, SetPartitionAttributes
// rewrites one entry, WipeDisk removes the volumes and the table, and
// detach really detaches.
func TestWinSystem_VHDXProvisionRoundTrip(t *testing.T) {
	requireElevatedForTest(t)
	ctx := context.Background()
	sys := NewWinSystem()
	path, disk, detach := attachTestVHDX(t, sys, 128*MiB, 512)

	diskGUID, _ := wingpt.NewGUID()
	g1, _ := wingpt.NewGUID()
	g2, _ := wingpt.NewGUID()
	parts := []WinGPTPartition{
		{Number: 1, TypeGUID: layout.GUIDMicrosoftBasic, PartGUID: g1, Name: "Basic data partition", StartBytes: 1 * MiB, SizeBytes: 32 * MiB, Attributes: gptAttrNoDriveLetter},
		{Number: 2, TypeGUID: layout.GUIDMicrosoftBasic, PartGUID: g2, Name: "Second", StartBytes: 33 * MiB, SizeBytes: 64 * MiB, Attributes: gptAttrNoDriveLetter | 0x4},
	}
	if err := sys.WriteGPT(disk, diskGUID, parts); err != nil {
		t.Fatalf("WriteGPT: %v", err)
	}
	gotGUID, gotParts, err := sys.ReadGPT(disk)
	if err != nil {
		t.Fatalf("ReadGPT: %v", err)
	}
	if gotGUID != diskGUID || len(gotParts) != len(parts) {
		t.Fatalf("ReadGPT = %s %+v, want %s and %d partitions", gotGUID, gotParts, diskGUID, len(parts))
	}
	for i, p := range parts {
		g := gotParts[i]
		if g.Number != p.Number || g.PartGUID != p.PartGUID || g.TypeGUID != p.TypeGUID || g.Name != p.Name || g.StartBytes != p.StartBytes || g.SizeBytes != p.SizeBytes || g.Attributes != p.Attributes {
			t.Errorf("partition %d read back as %+v, want %+v", i, g, p)
		}
	}
	vols, err := sys.WaitForVolumes(ctx, disk, 2)
	if err != nil {
		t.Fatalf("WaitForVolumes: %v", err)
	}
	byNumber := map[int]WinVolume{}
	for _, v := range vols {
		byNumber[v.PartitionNumber] = v
		if v.DriveLetter != "" {
			t.Errorf("volume %s got drive letter %s despite NO_DRIVE_LETTER", v.GUIDPath, v.DriveLetter)
		}
	}
	v1, ok := byNumber[1]
	if !ok || byNumber[2].GUIDPath == "" {
		t.Fatalf("volumes by partition number = %+v, want 1 and 2", byNumber)
	}
	if has, err := sys.HasWindowsTree(v1.GUIDPath); err != nil || has {
		t.Fatalf("HasWindowsTree(RAW volume) = %v, %v; want false, nil", has, err)
	}
	if err := sys.Format(ctx, v1.GUIDPath, "ntfs", "BRZTEST"); err != nil {
		t.Fatalf("Format: %v", err)
	}
	// Format's temporary letter must be gone again (no letters during the run).
	if after, err := sys.VolumesOnDisk(disk); err != nil {
		t.Fatal(err)
	} else {
		for _, v := range after {
			if v.DriveLetter != "" {
				t.Fatalf("volume %s still has drive letter %s after Format", v.GUIDPath, v.DriveLetter)
			}
		}
	}

	mnt := filepath.Join(t.TempDir(), "mnt", "root") // does not exist yet
	if err := sys.MountVolume(v1.GUIDPath, mnt); err != nil {
		t.Fatalf("MountVolume: %v", err)
	}
	mounted := true
	defer func() {
		if mounted {
			_ = sys.UnmountVolume(mnt)
		}
	}()
	if err := os.WriteFile(filepath.Join(mnt, "hello.txt"), []byte("breeze"), 0o644); err != nil {
		t.Fatalf("write through folder mount: %v", err)
	}
	if b, err := os.ReadFile(filepath.Join(v1.GUIDPath, "hello.txt")); err != nil || string(b) != "breeze" {
		t.Fatalf("read via filepath.Join(%q, ...) = %q, %v (Ruling B1a: the GUID path must be usable as a directory base)", v1.GUIDPath, b, err)
	}
	if err := os.MkdirAll(filepath.Join(v1.GUIDPath, "Windows", "System32", "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(v1.GUIDPath, "Windows", "System32", "config", "SYSTEM"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if has, err := sys.HasWindowsTree(v1.GUIDPath); err != nil || !has {
		t.Fatalf("HasWindowsTree after creating the tree = %v, %v; want true", has, err)
	}
	if err := sys.FlushVolume(v1.GUIDPath); err != nil {
		t.Fatalf("FlushVolume: %v", err)
	}
	letter, release, err := sys.AssignLetter(v1.GUIDPath)
	if err != nil {
		t.Fatalf("AssignLetter: %v", err)
	}
	if b, err := os.ReadFile(letter + `:\hello.txt`); err != nil || string(b) != "breeze" {
		t.Errorf("read via assigned letter %s: = %q, %v", letter, b, err)
	}
	if err := release(); err != nil {
		t.Fatalf("release letter %s: %v", letter, err)
	}
	if err := sys.UnmountVolume(mnt); err != nil {
		t.Fatalf("UnmountVolume: %v", err)
	}
	mounted = false

	if err := sys.SetPartitionAttributes(disk, 2, 0); err != nil {
		t.Fatalf("SetPartitionAttributes: %v", err)
	}
	if _, after, err := sys.ReadGPT(disk); err != nil || len(after) != 2 || after[1].Attributes != 0 || after[0].Attributes != parts[0].Attributes || after[1].PartGUID != g2 {
		t.Fatalf("after SetPartitionAttributes(2, 0): %+v, %v", after, err)
	}

	if err := sys.WipeDisk(ctx, disk); err != nil {
		t.Fatalf("WipeDisk: %v", err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		left, err := sys.VolumesOnDisk(disk)
		if err != nil {
			t.Fatal(err)
		}
		if len(left) == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("volumes still present after WipeDisk: %+v", left)
		}
		time.Sleep(200 * time.Millisecond)
	}
	if _, left, err := sys.ReadGPT(disk); err == nil && len(left) > 0 {
		t.Fatalf("GPT still has partitions after WipeDisk: %+v", left)
	}

	if err := detach(); err != nil {
		t.Fatalf("detach: %v", err)
	}
	if detached, err := sys.DetachVHDXByPath(path); err != nil || detached {
		t.Fatalf("DetachVHDXByPath after detach = %v, %v; want false, nil", detached, err)
	}
}

// cleanupLeftovers' in-process case: a second WinSystem instance that only
// knows the path detaches a VHDX the first one attached (the attach
// registry is process-wide — a non-permanent attach can only be detached
// through its own handle), then reports not-attached and missing files as
// (false, nil).
func TestWinSystem_DetachVHDXByPathFromAnotherInstance(t *testing.T) {
	requireElevatedForTest(t)
	holder := NewWinSystem()
	path, _, _ := attachTestVHDX(t, holder, 64*MiB, 512)
	other := NewWinSystem()
	detached, err := other.DetachVHDXByPath(path)
	if err != nil || !detached {
		t.Fatalf("DetachVHDXByPath(attached by another instance) = %v, %v; want true, nil", detached, err)
	}
	if detached, err := other.DetachVHDXByPath(path); err != nil || detached {
		t.Fatalf("second DetachVHDXByPath = %v, %v; want false, nil", detached, err)
	}
	if detached, err := other.DetachVHDXByPath(filepath.Join(t.TempDir(), "absent.vhdx")); err != nil || detached {
		t.Fatalf("DetachVHDXByPath(missing file) = %v, %v; want false, nil", detached, err)
	}
}

// rawAttachForTest attaches path through a virtual-disk handle the
// WinSystem registry knows nothing about — standing in for another
// process — optionally with PERMANENT_LIFETIME.
func rawAttachForTest(t *testing.T, path string, permanent bool) windows.Handle {
	t.Helper()
	h, err := openVHDX(path)
	if err != nil {
		t.Fatal(err)
	}
	flags := uintptr(attachFlagNoDriveLetter)
	if permanent {
		flags |= 0x4 // ATTACH_VIRTUAL_DISK_FLAG_PERMANENT_LIFETIME
	}
	params := attachVirtualDiskParametersV2{Version: attachVirtualDiskVersion2}
	if r1, _, _ := procAttachVirtualDisk.Call(uintptr(h), 0, flags, 0, uintptr(unsafe.Pointer(&params)), 0); r1 != 0 {
		_ = windows.CloseHandle(h)
		t.Fatalf("AttachVirtualDisk: %v", windows.Errno(r1))
	}
	return h
}

// Foreign attaches: a PERMANENT_LIFETIME attach whose holder is gone is
// detached by path; a non-permanent attach whose holder is still alive
// cannot be (ERROR_NOT_READY) and is reported as an error, with the disk
// left attached — never as (false, nil), which would read as "not
// attached".
func TestWinSystem_DetachVHDXByPathForeignAttaches(t *testing.T) {
	requireElevatedForTest(t)
	sys := NewWinSystem()
	dir := t.TempDir()

	perm := filepath.Join(dir, "perm.vhdx")
	if err := sys.CreateVHDX(perm, 64*MiB, 512); err != nil {
		t.Fatal(err)
	}
	h := rawAttachForTest(t, perm, true)
	_ = windows.CloseHandle(h) // the "other process" exits; the permanent attach stays
	t.Cleanup(func() { _, _ = sys.DetachVHDXByPath(perm) })
	if detached, err := sys.DetachVHDXByPath(perm); err != nil || !detached {
		t.Fatalf("DetachVHDXByPath(permanent foreign attach) = %v, %v; want true, nil", detached, err)
	}
	if detached, err := sys.DetachVHDXByPath(perm); err != nil || detached {
		t.Fatalf("second DetachVHDXByPath(perm) = %v, %v; want false, nil", detached, err)
	}

	live := filepath.Join(dir, "live.vhdx")
	if err := sys.CreateVHDX(live, 64*MiB, 512); err != nil {
		t.Fatal(err)
	}
	holder := rawAttachForTest(t, live, false)
	t.Cleanup(func() { _ = windows.CloseHandle(holder) }) // closing a non-permanent holder detaches
	detached, err := sys.DetachVHDXByPath(live)
	if err == nil || detached || !strings.Contains(err.Error(), "another live process") {
		t.Fatalf("DetachVHDXByPath(non-permanent foreign attach) = %v, %v; want false and the live-holder error", detached, err)
	}
	if _, err := physicalPath(holder); err != nil {
		t.Fatalf("holder's attach was lost: %v", err)
	}
}

var procRegSaveKeyExW = windows.NewLazySystemDLL("advapi32.dll").NewProc("RegSaveKeyExW")

// saveTestHive writes a fresh hive file containing one value, via
// RegSaveKeyExW of a temporary HKCU key (under SeBackupPrivilege).
func saveTestHive(t *testing.T) string {
	t.Helper()
	keyPath := fmt.Sprintf(`Software\BreezeRebuildTest-%d`, time.Now().UnixNano())
	k, _, err := registry.CreateKey(registry.CURRENT_USER, keyPath, registry.ALL_ACCESS)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = k.Close()
		_ = registry.DeleteKey(registry.CURRENT_USER, keyPath)
	}()
	if err := k.SetStringValue("Seed", "from-test"); err != nil {
		t.Fatal(err)
	}
	release, err := backup.AcquireHivePrivileges()
	if err != nil {
		t.Fatalf("AcquireHivePrivileges: %v", err)
	}
	defer release()
	file := filepath.Join(t.TempDir(), "TESTHIVE")
	fileP, _ := windows.UTF16PtrFromString(file)
	const regLatestFormat = 2
	if r1, _, _ := procRegSaveKeyExW.Call(uintptr(k), uintptr(unsafe.Pointer(fileP)), 0, regLatestFormat); r1 != 0 {
		t.Fatalf("RegSaveKeyExW: %v", windows.Errno(r1))
	}
	return file
}

func hklmKeyExists(name string) bool {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, name, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	_ = k.Close()
	return true
}

// LoadHive → edit → Close really loads the file at HKLM\<mount>, round-trips
// a value, and unloads it (Close must unload BEFORE releasing the
// privileges, or RegUnLoadKeyW fails and the mount is stranded).
// UnloadStaleHives then sweeps a mount left loaded on purpose.
func TestWinSystem_LoadHiveRoundTripAndStaleSweep(t *testing.T) {
	requireElevatedForTest(t)
	sys := NewWinSystem()
	file := saveTestHive(t)
	prefix := fmt.Sprintf("BRZ_rebuildtest_%d_", time.Now().UnixNano())
	mount := prefix + "live"
	// Backstop: never strand a test mount on the host if an assertion fails.
	t.Cleanup(func() { _, _ = sys.UnloadStaleHives(prefix) })
	h, err := sys.LoadHive(file, mount)
	if err != nil {
		t.Fatalf("LoadHive: %v", err)
	}
	if !hklmKeyExists(mount) {
		_ = h.Close()
		t.Fatalf("HKLM\\%s missing after LoadHive", mount)
	}
	root := h.Root()
	if v, err := root.GetString("Seed"); err != nil || v != "from-test" {
		t.Errorf("GetString(Seed) = %q, %v", v, err)
	}
	sub, err := root.CreateKey(`A\B`)
	if err != nil {
		t.Errorf("CreateKey: %v", err)
	} else {
		if err := sub.SetDWORD("N", 7); err != nil {
			t.Errorf("SetDWORD: %v", err)
		}
		_ = sub.Close()
	}
	if _, err := root.OpenKey("Missing"); !errors.Is(err, winhive.ErrNotExist) {
		t.Errorf("OpenKey(Missing) = %v, want ErrNotExist", err)
	}
	if err := h.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := h.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	if hklmKeyExists(mount) {
		t.Fatalf("HKLM\\%s still loaded after Close", mount)
	}

	// The edit persisted to the file: reload it at a second mount name and
	// read it back.
	stale := prefix + "stale"
	h2, err := sys.LoadHive(file, stale)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if k, err := h2.Root().OpenKey(`A\B`); err != nil {
		t.Errorf("reloaded hive lacks A\\B: %v", err)
	} else {
		if n, err := k.GetDWORD("N"); err != nil || n != 7 {
			t.Errorf("reloaded N = %d, %v", n, err)
		}
		_ = k.Close()
	}
	// Abandon h2 the way a crashed run would: its root handle and its
	// privilege scope go away, the HKLM mount stays. UnloadStaleHives must
	// then acquire the privileges itself and sweep exactly that mount.
	_ = h2.Root().Close()
	h2.(*hiveWithRelease).release()
	if !hklmKeyExists(stale) {
		t.Fatalf("HKLM\\%s missing before the sweep", stale)
	}
	n, err := sys.UnloadStaleHives(prefix)
	if err != nil || n != 1 {
		t.Fatalf("UnloadStaleHives(%q) = %d, %v; want 1, nil", prefix, n, err)
	}
	if hklmKeyExists(stale) {
		t.Fatalf("HKLM\\%s still loaded after UnloadStaleHives", stale)
	}
}
