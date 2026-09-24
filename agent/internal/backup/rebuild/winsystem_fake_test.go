package rebuild

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/backup/winhive"
)

func TestFakeWinSystem_WriteGPTCreatesVolumeDirsSkipsMSR(t *testing.T) {
	dir := t.TempDir()
	f := newFakeWinSystem(dir)
	parts := []WinGPTPartition{
		{Number: 1, TypeGUID: layout.GUIDEFISystem, PartGUID: "1111", SizeBytes: 100 * MiB},
		{Number: 2, TypeGUID: layout.GUIDMicrosoftMSR, PartGUID: "2222", SizeBytes: 16 * MiB},
		{Number: 3, TypeGUID: layout.GUIDMicrosoftBasic, PartGUID: "3333", SizeBytes: 60 * GiB},
	}
	if err := f.WriteGPT(1, "disk-guid", parts); err != nil {
		t.Fatal(err)
	}
	if len(f.volumes) != 2 {
		t.Fatalf("volumes = %+v, want 2 (MSR excluded)", f.volumes)
	}
	for _, v := range f.volumes {
		if _, err := os.Stat(v.dir); err != nil {
			t.Fatalf("volume dir %s not created: %v", v.dir, err)
		}
	}
}

func TestFakeWinSystem_MountVolumeCreatesMountDirAndAssignLetterReturnsZ(t *testing.T) {
	dir := t.TempDir()
	f := newFakeWinSystem(dir)
	_ = f.WriteGPT(1, "disk-guid", []WinGPTPartition{{Number: 1, TypeGUID: layout.GUIDMicrosoftBasic, PartGUID: "aaaa", SizeBytes: GiB}})
	guidPath := f.volumes[0].guidPath
	mnt := filepath.Join(dir, "mnt", "root")
	if err := f.MountVolume(guidPath, mnt); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(mnt); err != nil {
		t.Fatalf("mount dir not created: %v", err)
	}
	letter, release, err := f.AssignLetter(guidPath)
	if err != nil || letter != "Z" {
		t.Fatalf("letter = %q, err = %v", letter, err)
	}
	if err := release(); err != nil {
		t.Fatal(err)
	}
}

func TestFakeWinSystem_LoadHiveReturnsPreseededOrFreshFake(t *testing.T) {
	dir := t.TempDir()
	f := newFakeWinSystem(dir)
	preseeded := winhive.NewFake()
	f.hives["SYSTEM"] = preseeded
	hivePath := filepath.Join(dir, "registry", "SYSTEM")
	h, err := f.LoadHive(hivePath, "BRZ_x_SYSTEM")
	if err != nil {
		t.Fatal(err)
	}
	if h.Root() != preseeded.Root() {
		t.Fatalf("LoadHive did not return the preseeded fake")
	}
	h2, err := f.LoadHive(filepath.Join(dir, "registry", "SOFTWARE"), "BRZ_x_SOFTWARE")
	if err != nil || h2 == nil {
		t.Fatalf("LoadHive should auto-create an empty fake when not preseeded: h2=%v err=%v", h2, err)
	}
}

func TestFakeWinSystem_RunRecordsAndFailPrefixWorks(t *testing.T) {
	dir := t.TempDir()
	f := newFakeWinSystem(dir)
	f.fail["dism.exe /Image"] = context.DeadlineExceeded
	if _, err := f.Run(context.Background(), "dism.exe", "/Image:x", "/Add-Driver"); err == nil {
		t.Fatal("expected the configured failure")
	}
	if !f.has("dism.exe /Image") {
		t.Fatalf("command not recorded: %v", f.cmds)
	}
}

// fakeVolume is fakeWinSystem's stand-in for one provisioned partition's
// volume: dir is a real, on-disk directory (created by WriteGPT) that
// answers HasWindowsTree/inspection queries. guidPath is the WinVolume.
// GUIDPath the fake hands out — for WriteGPT-created volumes it IS dir
// (Ruling B1a: GUIDPath is "a path that opens the volume root"; the real
// seam's is \\?\Volume{GUID}\), so the engine's restore into the root
// volume lands in a real directory on every test host. Tests may still
// append hand-made volumes with an informational \\?\Volume{...}\ path
// and no dir. MountVolume creates a SEPARATE
// real directory (the staging mount point restored files actually land
// under) and does not alias it to dir — mirroring how the real WinSystem's
// MountVolume (SetVolumeMountPointW) attaches an independent volume to a
// folder, and matching fakeSystem.Mount's own "just MkdirAll(dir)" Linux
// twin (system_fake_test.go).
type fakeVolume struct {
	guidPath        string
	dir             string
	diskNumber      int
	partitionNumber int
}

// fakeDisk is one disk's current GPT, as fakeWinSystem tracks it.
type fakeDisk struct {
	guid      string
	parts     []WinGPTPartition
	sizeBytes int64
	sector    int
}

// fakeWinSystem is WinSystem's test double — the Windows twin of
// fakeSystem (system_fake_test.go).
type fakeWinSystem struct {
	mu  sync.Mutex
	dir string // temp root; volume dirs live under dir/vol-<partGUID>

	cmds        []string
	fail        map[string]error // command prefix -> error (Run only)
	failTimes   map[string]*failTimesEntry
	lookPathErr map[string]error

	inWinPE          bool
	systemDiskNumber int // -1 = none / RAM disk; default -1
	mediaDiskNumbers []int
	diskInfo         map[int]WinDiskInfo // preset by the test before calling winPreflight
	freeSpace        int64

	disks          map[int]*fakeDisk
	nextDiskNumber int

	volumes []fakeVolume

	mountLog []string // "guidPath dir"
	unmounts []string
	letters  map[string]string // guidPath -> assigned letter

	hives        map[string]*winhive.Fake // hive file base name -> pre-seeded fake
	hiveCloseErr error                    // when set, every LoadHive handle's Close returns it (a failed RegUnLoadKeyW)

	// hideVolumesCalls makes the next N VolumesOnDisk calls report no
	// volumes — a freshly attached VHDX whose volumes the host has not
	// surfaced yet. WaitForVolumes polls through it.
	hideVolumesCalls int

	staleHiveCount     int // preset by a test to simulate leftover mounts
	staleHivesUnloaded []string
	detachedVHDXPaths  []string
	attachedVHDX       map[string]int // path -> disk number, while attached
	vhdxDiskNumber     map[string]int // path -> the disk number it got on first attach (reused on re-attach, like a real host)
	vhdxFiles          map[string]struct {
		sizeBytes int64
		sector    int
	}

	hasWindowsTree map[string]bool // guidPath -> preset answer, default false
}

func newFakeWinSystem(dir string) *fakeWinSystem {
	return &fakeWinSystem{
		dir: dir, fail: map[string]error{}, failTimes: map[string]*failTimesEntry{}, lookPathErr: map[string]error{},
		systemDiskNumber: -1, diskInfo: map[int]WinDiskInfo{}, freeSpace: 1 << 50,
		disks: map[int]*fakeDisk{}, nextDiskNumber: 1, letters: map[string]string{},
		hives: map[string]*winhive.Fake{}, attachedVHDX: map[string]int{}, vhdxDiskNumber: map[string]int{},
		vhdxFiles: map[string]struct {
			sizeBytes int64
			sector    int
		}{},
		hasWindowsTree: map[string]bool{},
	}
}

var _ WinSystem = (*fakeWinSystem)(nil)

func (f *fakeWinSystem) record(name string, args ...string) ([]byte, error) {
	line := strings.TrimSpace(name + " " + strings.Join(args, " "))
	f.mu.Lock()
	f.cmds = append(f.cmds, line)
	for prefix, entry := range f.failTimes {
		if strings.HasPrefix(line, prefix) && entry.remaining > 0 {
			entry.remaining--
			f.mu.Unlock()
			return entry.out, entry.err
		}
	}
	f.mu.Unlock()
	for prefix, err := range f.fail {
		if strings.HasPrefix(line, prefix) {
			return []byte("simulated failure"), err
		}
	}
	return nil, nil
}

func (f *fakeWinSystem) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	out, err := f.record(name, args...)
	if err != nil || !strings.EqualFold(name[strings.LastIndexAny(name, `\/`)+1:], "bcdboot.exe") {
		return out, err
	}
	return out, f.simulateBcdboot(args)
}

// fakeDefaultBootEntry is the BCD element validate asserts (Global "ESP and
// boot"): the boot manager's default entry.
const fakeDefaultBootEntry = `Objects\{9dea862c-5cdd-4e70-acc1-f32b344d4795}\Elements\23000003`

// simulateBcdboot is what bcdboot /s <L>: leaves on the ESP (ruling C7):
// EFI\Microsoft\Boot\{BCD,bootmgfw.efi} under the backing dir of the volume
// that holds letter L, plus a fake-loadable BCD hive (keyed "BCD", as
// LoadHive expects) with the default boot-manager entry — unless a test
// pre-seeded one. EFI\Boot\bootx64.efi is deliberately NOT written, so
// winBoot's ensureBootx64 copy is exercised.
func (f *fakeWinSystem) simulateBcdboot(args []string) error {
	letter := ""
	for i := 0; i+1 < len(args); i++ {
		if strings.EqualFold(args[i], "/s") {
			letter = strings.TrimSuffix(args[i+1], ":")
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	dir := ""
	for _, v := range f.volumes {
		if letter != "" && f.letters[v.guidPath] == letter {
			dir = v.dir
		}
	}
	if dir == "" {
		return fmt.Errorf("fakeWinSystem: bcdboot /s %q: no volume holds that drive letter", letter)
	}
	boot := filepath.Join(dir, "EFI", "Microsoft", "Boot")
	if err := os.MkdirAll(boot, 0o755); err != nil {
		return err
	}
	for name, body := range map[string]string{"BCD": "fake-bcd-hive", "bootmgfw.efi": "fake-bootmgr"} {
		if err := os.WriteFile(filepath.Join(boot, name), []byte(body), 0o644); err != nil {
			return err
		}
	}
	if _, ok := f.hives["BCD"]; !ok {
		bcd := winhive.NewFake()
		if _, err := bcd.CreateKey(fakeDefaultBootEntry); err != nil {
			return err
		}
		f.hives["BCD"] = bcd
	}
	return nil
}
func (f *fakeWinSystem) LookPath(name string) (string, error) {
	if err, ok := f.lookPathErr[name]; ok {
		return "", err
	}
	return `C:\Windows\System32\` + name, nil
}
func (f *fakeWinSystem) InWinPE() bool                    { return f.inWinPE }
func (f *fakeWinSystem) SystemDiskNumber() (int, error)   { return f.systemDiskNumber, nil }
func (f *fakeWinSystem) MediaDiskNumbers() ([]int, error) { return f.mediaDiskNumbers, nil }
func (f *fakeWinSystem) DiskInfo(n int) (WinDiskInfo, error) {
	if info, ok := f.diskInfo[n]; ok {
		return info, nil
	}
	return WinDiskInfo{}, fmt.Errorf("fakeWinSystem: no DiskInfo configured for disk %d", n)
}
func (f *fakeWinSystem) VolumesOnDisk(diskNumber int) ([]WinVolume, error) {
	f.mu.Lock()
	hidden := f.hideVolumesCalls > 0
	if hidden {
		f.hideVolumesCalls--
	}
	f.mu.Unlock()
	if hidden {
		return nil, nil
	}
	var out []WinVolume
	for _, v := range f.volumes {
		if v.diskNumber == diskNumber {
			out = append(out, WinVolume{GUIDPath: v.guidPath, DiskNumber: v.diskNumber, PartitionNumber: v.partitionNumber, DriveLetter: f.letters[v.guidPath]})
		}
	}
	return out, nil
}

// Locking rule for every method below: f.record takes f.mu itself, so no
// method may hold f.mu while calling it (sync.Mutex is not reentrant).
func (f *fakeWinSystem) CreateVHDX(path string, sizeBytes int64, sector int) error {
	if _, err := f.record("CreateVHDX", path, fmt.Sprint(sizeBytes), fmt.Sprint(sector)); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.vhdxFiles[path] = struct {
		sizeBytes int64
		sector    int
	}{sizeBytes, sector}
	return nil
}
func (f *fakeWinSystem) AttachVHDX(path string) (int, func() error, error) {
	if _, err := f.record("AttachVHDX", path); err != nil {
		return 0, nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	meta, ok := f.vhdxFiles[path]
	if !ok {
		return 0, nil, fmt.Errorf("fakeWinSystem: AttachVHDX(%s) before CreateVHDX", path)
	}
	disk, seen := f.vhdxDiskNumber[path]
	if !seen {
		disk = f.nextDiskNumber
		f.nextDiskNumber++
		f.vhdxDiskNumber[path] = disk
		f.disks[disk] = &fakeDisk{sizeBytes: meta.sizeBytes, sector: meta.sector}
		f.diskInfo[disk] = WinDiskInfo{SizeBytes: meta.sizeBytes, LogicalSectorSize: meta.sector}
	}
	f.attachedVHDX[path] = disk
	detach := func() error {
		f.mu.Lock()
		defer f.mu.Unlock()
		// Recorded in cmds (not via f.record, which takes f.mu) so tests
		// can assert the handle detach's position in the call order.
		f.cmds = append(f.cmds, "DetachVHDXHandle "+path)
		delete(f.attachedVHDX, path)
		f.detachedVHDXPaths = append(f.detachedVHDXPaths, path)
		return nil
	}
	return disk, detach, nil
}
func (f *fakeWinSystem) DetachVHDXByPath(path string) (bool, error) {
	if _, err := f.record("DetachVHDXByPath", path); err != nil {
		return false, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.attachedVHDX[path]; !ok {
		return false, nil
	}
	delete(f.attachedVHDX, path)
	f.detachedVHDXPaths = append(f.detachedVHDXPaths, path)
	return true, nil
}
func (f *fakeWinSystem) WipeDisk(_ context.Context, diskNumber int) error {
	_, _ = f.record("WipeDisk", fmt.Sprint(diskNumber))
	if d, ok := f.disks[diskNumber]; ok {
		d.parts = nil
	}
	return nil
}
func (f *fakeWinSystem) WriteGPT(diskNumber int, diskGUID string, parts []WinGPTPartition) error {
	if _, err := f.record("WriteGPT", fmt.Sprint(diskNumber), diskGUID, fmt.Sprint(len(parts))); err != nil {
		return err
	}
	f.mu.Lock()
	d, ok := f.disks[diskNumber]
	if !ok {
		d = &fakeDisk{}
		f.disks[diskNumber] = d
	}
	d.guid, d.parts = diskGUID, append([]WinGPTPartition(nil), parts...)
	f.mu.Unlock()

	for _, p := range parts {
		if p.TypeGUID == layout.GUIDMicrosoftMSR {
			continue // MSR carries no filesystem/volume
		}
		id := p.PartGUID
		if id == "" {
			id = fmt.Sprintf("fake-%d-%d", diskNumber, p.Number)
		}
		volDir := filepath.Join(f.dir, "vol-"+id)
		if err := os.MkdirAll(volDir, 0o755); err != nil {
			return err
		}
		f.mu.Lock()
		f.volumes = append(f.volumes, fakeVolume{guidPath: volDir, dir: volDir, diskNumber: diskNumber, partitionNumber: p.Number})
		f.mu.Unlock()
	}
	return nil
}
func (f *fakeWinSystem) ReadGPT(diskNumber int) (string, []WinGPTPartition, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	d, ok := f.disks[diskNumber]
	if !ok {
		return "", nil, fmt.Errorf("fakeWinSystem: no GPT written for disk %d", diskNumber)
	}
	return d.guid, append([]WinGPTPartition(nil), d.parts...), nil
}
func (f *fakeWinSystem) SetPartitionAttributes(diskNumber, number int, attrs uint64) error {
	if _, err := f.record("SetPartitionAttributes", fmt.Sprint(diskNumber), fmt.Sprint(number), fmt.Sprint(attrs)); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	d, ok := f.disks[diskNumber]
	if !ok {
		return fmt.Errorf("fakeWinSystem: no GPT written for disk %d", diskNumber)
	}
	for i := range d.parts {
		if d.parts[i].Number == number {
			d.parts[i].Attributes = attrs
			return nil
		}
	}
	return fmt.Errorf("fakeWinSystem: no partition %d on disk %d", number, diskNumber)
}

// WaitForVolumes polls VolumesOnDisk like the real seam (without the
// sleep), giving up after a bounded number of polls.
func (f *fakeWinSystem) WaitForVolumes(_ context.Context, diskNumber int, want int) ([]WinVolume, error) {
	_, _ = f.record("WaitForVolumes", fmt.Sprint(diskNumber), fmt.Sprint(want))
	var vols []WinVolume
	for attempt := 0; attempt < 50; attempt++ {
		var err error
		if vols, err = f.VolumesOnDisk(diskNumber); err != nil {
			return nil, err
		}
		if len(vols) >= want {
			return vols, nil
		}
	}
	return vols, fmt.Errorf("fakeWinSystem: only %d of %d expected volumes appeared on disk %d", len(vols), want, diskNumber)
}
func (f *fakeWinSystem) Format(_ context.Context, volumeGUIDPath, filesystem, label string) error {
	_, err := f.record("format.com", volumeGUIDPath, "/FS:"+strings.ToUpper(filesystem), "/Q", "/Y", "/V:"+label)
	return err
}
func (f *fakeWinSystem) MountVolume(volumeGUIDPath, dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	f.mu.Lock()
	f.mountLog = append(f.mountLog, volumeGUIDPath+" "+dir)
	f.mu.Unlock()
	return nil
}
func (f *fakeWinSystem) UnmountVolume(dir string) error {
	f.mu.Lock()
	f.unmounts = append(f.unmounts, dir)
	f.cmds = append(f.cmds, "UnmountVolume "+dir)
	f.mu.Unlock()
	return nil
}
func (f *fakeWinSystem) AssignLetter(volumeGUIDPath string) (string, func() error, error) {
	f.mu.Lock()
	f.letters[volumeGUIDPath] = "Z"
	f.mu.Unlock()
	release := func() error {
		f.mu.Lock()
		delete(f.letters, volumeGUIDPath)
		f.mu.Unlock()
		return nil
	}
	return "Z", release, nil
}
func (f *fakeWinSystem) FlushVolume(volumeGUIDPath string) error {
	_, err := f.record("FlushVolume", volumeGUIDPath)
	return err
}
func (f *fakeWinSystem) FreeSpace(string) (int64, error) { return f.freeSpace, nil }

// LoadHive returns the fake pre-seeded under the hive file's base name
// (SYSTEM, SOFTWARE, BCD, ...), creating an empty one when none was seeded.
// The base name is taken after the LAST `\` or `/`, so Windows-shaped hive
// paths resolve the same on every host.
func (f *fakeWinSystem) LoadHive(hiveFile, mountName string) (winhive.Handle, error) {
	if _, err := f.record("LoadHive", hiveFile, mountName); err != nil {
		return nil, err
	}
	base := hiveFile
	if i := strings.LastIndexAny(base, `\/`); i >= 0 {
		base = base[i+1:]
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	h, ok := f.hives[base]
	if !ok {
		h = winhive.NewFake()
		f.hives[base] = h
	}
	if f.hiveCloseErr != nil {
		return fakeHiveHandle{Fake: h, closeErr: f.hiveCloseErr}, nil
	}
	return h, nil
}

// fakeHiveHandle is a loaded fake hive whose unload fails.
type fakeHiveHandle struct {
	*winhive.Fake
	closeErr error
}

func (h fakeHiveHandle) Close() error { return h.closeErr }
func (f *fakeWinSystem) UnloadStaleHives(prefix string) (int, error) {
	if _, err := f.record("UnloadStaleHives", prefix); err != nil {
		return 0, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	n := f.staleHiveCount
	f.staleHivesUnloaded = append(f.staleHivesUnloaded, prefix)
	f.staleHiveCount = 0
	return n, nil
}
func (f *fakeWinSystem) HasWindowsTree(volumeGUIDPath string) (bool, error) {
	return f.hasWindowsTree[volumeGUIDPath], nil
}

// volumeDirForPartition returns the backing directory (== GUIDPath, Ruling
// B1a) of the fake volume for partition number on any disk.
func (f *fakeWinSystem) volumeDirForPartition(t *testing.T, number int) string {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, v := range f.volumes {
		if v.partitionNumber == number {
			return v.dir
		}
	}
	t.Fatalf("fakeWinSystem: no volume for partition %d", number)
	return ""
}

// volumePathsForDisk is the partition number -> GUIDPath map a real
// provision persists in runState.Volumes for diskNumber.
func (f *fakeWinSystem) volumePathsForDisk(diskNumber int) map[int]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[int]string{}
	for _, v := range f.volumes {
		if v.diskNumber == diskNumber {
			out[v.partitionNumber] = v.guidPath
		}
	}
	return out
}

func (f *fakeWinSystem) dumpForTest() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return strings.Join(f.cmds, "\n")
}

func (f *fakeWinSystem) has(prefix string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.cmds {
		if strings.HasPrefix(c, prefix) {
			return true
		}
	}
	return false
}
