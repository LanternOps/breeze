//go:build windows

package backup

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/breeze-rmm/agent/internal/backup/vss"
)

// Live Windows coverage for #7326. CI runs these by name in test-agent-windows
// and fails if any skips.

// The walk's thread sees placeholders exposed, and release restores the
// thread's previous mode.
func TestExposePlaceholdersForWalk_SetsThreadModeOnWindows(t *testing.T) {
	if procRtlSetThreadPlaceholderCompatibilityMode.Find() != nil {
		t.Skip("placeholder compatibility modes need Windows 10 1803 or later")
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	before := threadPlaceholderCompatibilityMode()

	release := exposePlaceholdersForWalk()
	during := threadPlaceholderCompatibilityMode()
	release()
	after := threadPlaceholderCompatibilityMode()

	if during != phcmExposePlaceholders {
		t.Fatalf("mode during the walk = %d, want PHCM_EXPOSE_PLACEHOLDERS (%d)", during, phcmExposePlaceholders)
	}
	if after != before {
		t.Fatalf("mode after release = %d, want the previous mode %d", after, before)
	}
}

func reparseTagOf(t *testing.T, path string) uint32 {
	t.Helper()
	buf, err := readReparseData(path)
	if err != nil {
		t.Fatalf("read reparse data of %s: %v", path, err)
	}
	tag, _, _, err := parseReparseBuffer(buf)
	if err != nil {
		t.Fatalf("parse reparse data of %s: %v", path, err)
	}
	return tag
}

// withExposedPlaceholders runs fn on a locked thread that sees placeholders
// as they are, the way the backup walk does.
func withExposedPlaceholders(fn func()) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	release := exposePlaceholdersForWalk()
	defer release()
	fn()
}

// wofBackingProvider returns the WOF provider backing path
// (FSCTL_GET_EXTERNAL_BACKING), or an error when wof.sys does not back it.
// It works whether or not wof.sys hides the file's reparse point.
func wofBackingProvider(path string) (uint32, error) {
	const fsctlGetExternalBacking = 0x00090310 // CTL_CODE(FILE_DEVICE_FILE_SYSTEM, 196, METHOD_BUFFERED, FILE_ANY_ACCESS)
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	h, err := windows.CreateFile(p, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return 0, err
	}
	defer func() { _ = windows.CloseHandle(h) }()
	var buf [64]byte // WOF_EXTERNAL_INFO {Version, Provider} + provider info
	var n uint32
	if err := windows.DeviceIoControl(h, fsctlGetExternalBacking, nil, 0, &buf[0], uint32(len(buf)), &n, nil); err != nil {
		return 0, err
	}
	if n < 8 {
		return 0, fmt.Errorf("external backing info too short: %d bytes", n)
	}
	return binary.LittleEndian.Uint32(buf[4:8]), nil
}

func logEntry(t *testing.T, label, path string) os.FileInfo {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatalf("lstat %s: %v", path, err)
	}
	t.Logf("%s: mode=%v attrs=0x%08X", label, info.Mode(), platformRawWinAttrs(info))
	return info
}

func backupAndRestore(t *testing.T, root string) (*BackupJob, string) {
	t.Helper()
	provider := privateTestLocalProvider(t, t.TempDir())
	mgr := NewBackupManager(BackupConfig{Provider: provider, Paths: []string{root}, StagingDir: t.TempDir()})
	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	if job.Snapshot == nil {
		t.Fatalf("backup produced no snapshot: %+v", job)
	}
	restoreRoot := t.TempDir()
	res, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: job.Snapshot.ID, TargetPath: restoreRoot}, nil)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if res.Status != "completed" || res.FilesFailed != 0 {
		t.Fatalf("restore result = %+v", res)
	}
	return job, filepath.Join(restoreRoot, stripVolumeAndLeadingSeparators(root))
}

// A file compressed with `compact /exe` (the CompactOS mechanism) is backed
// up with its real, decompressed bytes and restores as a readable plain file.
func TestWOFCompressedFile_BackupRestoreRoundTripOnWindows(t *testing.T) {
	root := t.TempDir()
	want := bytes.Repeat([]byte("breeze #7326 wof-compressed payload line\r\n"), 32*1024) // ~1.3 MiB, compresses well
	path := filepath.Join(root, "tool.exe")
	if err := os.WriteFile(path, want, 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("compact", "/c", "/exe:xpress4k", path).CombinedOutput()
	if err != nil {
		t.Fatalf("compact /exe: %v: %s", err, out)
	}
	t.Logf("compact /exe: %s", bytes.TrimSpace(out))
	provider, err := wofBackingProvider(path)
	if err != nil {
		t.Fatalf("compact /exe did not produce a WOF-backed file: FSCTL_GET_EXTERNAL_BACKING: %v", err)
	}
	t.Logf("WOF provider %d (2 = WOF_PROVIDER_FILE)", provider)
	// The #7326 premise was that the collector sees this as a reparse point.
	// With wof.sys attached it does not: wof.sys hides the reparse point, so
	// Go reports a regular file. Logged, not asserted, either way the file
	// must be captured.
	var info os.FileInfo
	withExposedPlaceholders(func() { info = logEntry(t, "WOF file", path) })
	_, tagErr := readReparseData(path)
	t.Logf("Go reports a WOF file as ModeIrregular: %v; reparse data visible: %v (%v)",
		info.Mode()&os.ModeIrregular != 0, tagErr == nil, tagErr)

	files, skips, err := NewBackupManager(BackupConfig{}).collectBackupFilesWithSkips(context.Background(), []string{root}, nil, nil)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if f, ok := manifestPathsWin(files)["path_0/tool.exe"]; !ok || f.kind != "" {
		t.Fatalf("WOF file must be captured as a regular file; files=%+v skips=%+v sample=%v", files, skips, skips.sample)
	}
	if skips.total != 0 || skips.notLocalTotal != 0 {
		t.Fatalf("a WOF file is not a skip: %+v %v", skips, skips.sample)
	}

	job, restoredRoot := backupAndRestore(t, root)
	if job.FilesBackedUp != 1 {
		t.Fatalf("FilesBackedUp = %d, want 1 (warning %q)", job.FilesBackedUp, job.Warning)
	}
	restored := filepath.Join(restoredRoot, "tool.exe")
	rinfo := logEntry(t, "restored WOF file", restored)
	if !rinfo.Mode().IsRegular() {
		t.Fatalf("restored file must be a plain regular file, mode %v", rinfo.Mode())
	}
	got, err := os.ReadFile(restored)
	if err != nil {
		t.Fatalf("restored WOF file is not readable: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("restored WOF file content differs: %d bytes, want %d", len(got), len(want))
	}
}

func manifestPathsWin(files []backupFile) map[string]backupFile {
	out := make(map[string]backupFile, len(files))
	for _, f := range files {
		out[f.snapshotPath] = f
	}
	return out
}

// --- Cloud Files API (cldapi.dll) test provider -----------------------------
//
// Registers a throwaway sync root and never connects a provider to it, so any
// attempt to read an unhydrated placeholder fails instead of downloading.

var (
	modCldapi                  = windows.NewLazySystemDLL("cldapi.dll")
	procCfRegisterSyncRoot     = modCldapi.NewProc("CfRegisterSyncRoot")
	procCfUnregisterSyncRoot   = modCldapi.NewProc("CfUnregisterSyncRoot")
	procCfCreatePlaceholders   = modCldapi.NewProc("CfCreatePlaceholders")
	procCfConvertToPlaceholder = modCldapi.NewProc("CfConvertToPlaceholder")
)

// CF_SYNC_REGISTRATION
type cfSyncRegistration struct {
	StructSize             uint32
	ProviderName           *uint16
	ProviderVersion        *uint16
	SyncRootIdentity       unsafe.Pointer
	SyncRootIdentityLength uint32
	FileIdentity           unsafe.Pointer
	FileIdentityLength     uint32
	ProviderID             windows.GUID
}

// CF_SYNC_POLICIES
type cfSyncPolicies struct {
	StructSize            uint32
	HydrationPrimary      uint16
	HydrationModifier     uint16
	PopulationPrimary     uint16
	PopulationModifier    uint16
	InSync                uint32
	HardLink              uint32
	PlaceholderManagement uint32
}

// CF_PLACEHOLDER_CREATE_INFO (FILE_BASIC_INFO + file size inlined)
type cfPlaceholderCreateInfo struct {
	RelativeFileName   *uint16
	CreationTime       int64
	LastAccessTime     int64
	LastWriteTime      int64
	ChangeTime         int64
	FileAttributes     uint32
	_                  uint32
	FileSize           int64
	FileIdentity       unsafe.Pointer
	FileIdentityLength uint32
	Flags              uint32
	Result             int32
	_                  uint32
	CreateUsn          int64
}

const (
	cfHydrationPolicyFull         = 2
	cfPopulationPolicyAlwaysFull  = 3
	cfPlaceholderCreateMarkInSync = 0x2
	cfConvertFlagMarkInSync       = 0x1
)

func hresultOK(r uintptr) bool { return int32(uint32(r)) >= 0 }

// newTestSyncRoot registers a fresh directory as a Cloud Files sync root.
// The directory is removed best effort: a leftover placeholder must not fail
// the test the way testing.TempDir's strict cleanup would.
func newTestSyncRoot(t *testing.T) string {
	t.Helper()
	if err := procCfRegisterSyncRoot.Find(); err != nil {
		t.Skipf("Cloud Files API unavailable: %v", err)
	}
	root, err := os.MkdirTemp("", "breeze-7326-syncroot-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	rootW, _ := windows.UTF16PtrFromString(root)
	name, _ := windows.UTF16PtrFromString("Breeze7326Test")
	version, _ := windows.UTF16PtrFromString("1.0")
	identity := []byte("breeze-7326-root")
	reg := cfSyncRegistration{
		ProviderName:           name,
		ProviderVersion:        version,
		SyncRootIdentity:       unsafe.Pointer(&identity[0]),
		SyncRootIdentityLength: uint32(len(identity)),
		ProviderID:             windows.GUID{Data1: 0x7326b0e2, Data2: 0x7326, Data3: 0x4b2e, Data4: [8]byte{0x9a, 0x1f, 0, 0, 0, 0, 0x73, 0x26}},
	}
	reg.StructSize = uint32(unsafe.Sizeof(reg))
	pol := cfSyncPolicies{HydrationPrimary: cfHydrationPolicyFull, PopulationPrimary: cfPopulationPolicyAlwaysFull}
	pol.StructSize = uint32(unsafe.Sizeof(pol))
	r, _, _ := procCfRegisterSyncRoot.Call(uintptr(unsafe.Pointer(rootW)), uintptr(unsafe.Pointer(&reg)), uintptr(unsafe.Pointer(&pol)), 0)
	runtime.KeepAlive(identity)
	if !hresultOK(r) {
		t.Fatalf("CfRegisterSyncRoot(%s) = 0x%08X", root, uint32(r))
	}
	t.Cleanup(func() { _, _, _ = procCfUnregisterSyncRoot.Call(uintptr(unsafe.Pointer(rootW))) })
	return root
}

// createPlaceholder creates an unhydrated (online-only) placeholder file.
func createPlaceholder(t *testing.T, syncRoot, name string, size int64) string {
	t.Helper()
	baseW, _ := windows.UTF16PtrFromString(syncRoot)
	nameW, _ := windows.UTF16PtrFromString(name)
	identity := []byte("breeze-7326-file-" + name)
	ft := windows.NsecToFiletime(time.Now().UnixNano())
	now := int64(ft.HighDateTime)<<32 | int64(ft.LowDateTime)
	info := cfPlaceholderCreateInfo{
		RelativeFileName:   nameW,
		CreationTime:       now,
		LastAccessTime:     now,
		LastWriteTime:      now,
		ChangeTime:         now,
		FileAttributes:     windows.FILE_ATTRIBUTE_NORMAL,
		FileSize:           size,
		FileIdentity:       unsafe.Pointer(&identity[0]),
		FileIdentityLength: uint32(len(identity)),
		Flags:              cfPlaceholderCreateMarkInSync,
	}
	var processed uint32
	r, _, _ := procCfCreatePlaceholders.Call(uintptr(unsafe.Pointer(baseW)), uintptr(unsafe.Pointer(&info)), 1, 0, uintptr(unsafe.Pointer(&processed)))
	runtime.KeepAlive(identity)
	if !hresultOK(r) || processed != 1 || info.Result < 0 {
		t.Fatalf("CfCreatePlaceholders(%s) = 0x%08X, processed %d, result 0x%08X", name, uint32(r), processed, uint32(info.Result))
	}
	return filepath.Join(syncRoot, name)
}

// convertToPlaceholder turns a local file into a fully hydrated, in-sync
// placeholder: what a OneDrive file that is "always keep on this device" or
// was recently opened looks like.
func convertToPlaceholder(t *testing.T, path string) {
	t.Helper()
	p, _ := windows.UTF16PtrFromString(path)
	h, err := windows.CreateFile(p, windows.GENERIC_READ|windows.GENERIC_WRITE, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer func() { _ = windows.CloseHandle(h) }()
	identity := []byte("breeze-7326-converted")
	r, _, _ := procCfConvertToPlaceholder.Call(uintptr(h), uintptr(unsafe.Pointer(&identity[0])), uintptr(len(identity)), cfConvertFlagMarkInSync, 0, 0)
	runtime.KeepAlive(identity)
	if !hresultOK(r) {
		t.Fatalf("CfConvertToPlaceholder(%s) = 0x%08X", path, uint32(r))
	}
}

// An online-only placeholder is skipped, named on the Warning, and left
// unhydrated: the backup never reads it.
func TestCloudPlaceholder_NotHydratedByBackupOnWindows(t *testing.T) {
	syncRoot := newTestSyncRoot(t)
	createTempFile(t, syncRoot, "local.txt", "a plain local file beside the placeholder")
	placeholder := createPlaceholder(t, syncRoot, "Report.docx", 64*1024)
	before := logEntry(t, "unhydrated placeholder, default thread mode", placeholder)
	withExposedPlaceholders(func() { logEntry(t, "unhydrated placeholder, exposed", placeholder) })
	func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		t.Logf("default thread placeholder mode: %d (0 application default, 1 disguise, 2 expose)", threadPlaceholderCompatibilityMode())
	}()
	reason := notStoredLocallyReason(platformRawWinAttrs(before))
	if reason == "" {
		t.Fatalf("an unhydrated placeholder must carry OFFLINE or a RECALL attribute, attrs 0x%08X", platformRawWinAttrs(before))
	}

	mgr := NewBackupManager(BackupConfig{Provider: newMockProvider(), Paths: []string{syncRoot}, StagingDir: t.TempDir()})
	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	if job.Status != jobStatusCompleted || job.ErrorCount != 0 {
		t.Fatalf("a skipped placeholder must not fail the run: status %q, errors %d, error %q", job.Status, job.ErrorCount, job.Error)
	}
	if job.FilesBackedUp != 1 {
		t.Fatalf("FilesBackedUp = %d, want 1 (local.txt only)", job.FilesBackedUp)
	}
	if !strings.Contains(job.Warning, "not stored on this machine") || !strings.Contains(job.Warning, placeholder) {
		t.Fatalf("Warning must name the placeholder, got %q", job.Warning)
	}
	for _, f := range job.Snapshot.Files {
		if strings.HasSuffix(f.SourcePath, "Report.docx") {
			t.Fatalf("placeholder leaked into the manifest: %+v", f)
		}
	}

	after := logEntry(t, "placeholder after backup", placeholder)
	if notStoredLocallyReason(platformRawWinAttrs(after)) == "" {
		t.Fatalf("the backup hydrated the placeholder: attrs 0x%08X", platformRawWinAttrs(after))
	}
}

// A fully local cloud file keeps its cloud reparse tag. Its data is on disk,
// so it is backed up and restores as a plain readable file (OneDrive Known
// Folder Move puts a user's whole Documents folder in this state).
func TestHydratedCloudFile_BackupRestoreRoundTripOnWindows(t *testing.T) {
	syncRoot := newTestSyncRoot(t)
	want := "budget figures that live on this disk"
	path := createTempFile(t, syncRoot, "Budget.xlsx", want)
	convertToPlaceholder(t, path)
	logEntry(t, "hydrated cloud file, default thread mode", path)
	// The walk exposes placeholders, so check the file the way it sees it.
	var info os.FileInfo
	var tag uint32
	withExposedPlaceholders(func() {
		info = logEntry(t, "hydrated cloud file, exposed", path)
		tag = reparseTagOf(t, path)
	})
	if !isDataReparseTag(tag) || tag == ioReparseTagWOF {
		t.Fatalf("converted file should carry a cloud reparse tag, got 0x%08X", tag)
	}
	if r := notStoredLocallyReason(platformRawWinAttrs(info)); r != "" {
		t.Fatalf("a converted local file is fully hydrated, got %q", r)
	}

	job, restoredRoot := backupAndRestore(t, syncRoot)
	if job.FilesBackedUp != 1 {
		t.Fatalf("FilesBackedUp = %d, want 1 (warning %q)", job.FilesBackedUp, job.Warning)
	}
	got, err := os.ReadFile(filepath.Join(restoredRoot, "Budget.xlsx"))
	if err != nil {
		t.Fatalf("restored cloud file is not readable: %v", err)
	}
	if string(got) != want {
		t.Fatalf("restored content = %q, want %q", got, want)
	}
}

const phcmDisguisePlaceholder = 1

func setThreadPlaceholderMode(t *testing.T, mode int8) int8 {
	t.Helper()
	r, _, _ := procRtlSetThreadPlaceholderCompatibilityMode.Call(uintptr(uint8(mode)))
	prev := int8(uint8(r))
	if prev < 0 {
		t.Fatalf("RtlSetThreadPlaceholderCompatibilityMode(%d) = %d", mode, prev)
	}
	return prev
}

// A walk started from a thread that disguises placeholders still detects an
// online-only placeholder, because the walk exposes them on its own thread,
// and it puts the caller's disguise mode back afterwards. The Lstat made from
// the disguised thread first is the control: it shows what the walk would see
// without exposePlaceholdersForWalk.
func TestCloudPlaceholder_DetectedFromDisguisedThreadOnWindows(t *testing.T) {
	if procRtlSetThreadPlaceholderCompatibilityMode.Find() != nil {
		t.Skip("placeholder compatibility modes need Windows 10 1803 or later")
	}
	syncRoot := newTestSyncRoot(t)
	placeholder := createPlaceholder(t, syncRoot, "Disguised.docx", 32*1024)

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	prev := setThreadPlaceholderMode(t, phcmDisguisePlaceholder)
	defer setThreadPlaceholderMode(t, prev)

	disguised := logEntry(t, "placeholder seen from a disguised thread (control)", placeholder)
	t.Logf("disguise hides the placeholder from a plain stat: %v",
		notStoredLocallyReason(platformRawWinAttrs(disguised)) == "" && disguised.Mode().IsRegular())

	files, skips, err := NewBackupManager(BackupConfig{}).collectBackupFilesWithSkips(context.Background(), []string{syncRoot}, nil, nil)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if _, ok := manifestPathsWin(files)["path_0/Disguised.docx"]; ok {
		t.Fatal("a placeholder walked from a disguised thread was captured: the upload would hydrate it")
	}
	if skips.notLocalTotal != 1 {
		t.Fatalf("placeholder not recorded as not stored locally: %+v", skips)
	}
	if mode := threadPlaceholderCompatibilityMode(); mode != phcmDisguisePlaceholder {
		t.Fatalf("the walk must restore the caller's mode: got %d, want %d", mode, phcmDisguisePlaceholder)
	}
}

// Opt-in live check (BREEZE_VSS_LIVE=1, elevated) of the one thing CI does not
// cover: whether wof.sys and cldflt.sys serve these files on a VSS shadow
// copy. Either outcome is safe, and the test enforces that. A WOF or hydrated
// cloud file is either backed up with its exact bytes or named on the
// Warning, never errored and never wrong. An online-only placeholder is
// always skipped and stays unhydrated. The log says which outcome this host
// produced.
func TestLive_WOFAndCloudFilesUnderVSS(t *testing.T) {
	if os.Getenv("BREEZE_VSS_LIVE") != "1" {
		t.Skip("set BREEZE_VSS_LIVE=1 to run live VSS tests (needs an elevated process)")
	}
	wofDir, err := os.MkdirTemp("", "breeze-7326-wof-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(wofDir) })
	syncRoot := newTestSyncRoot(t)
	sysVol := filepath.VolumeName(os.Getenv("SystemRoot"))
	if !strings.EqualFold(filepath.VolumeName(wofDir), sysVol) || !strings.EqualFold(filepath.VolumeName(syncRoot), sysVol) {
		t.Skipf("temp dir is not on the system volume %s", sysVol)
	}

	wofWant := bytes.Repeat([]byte("breeze #7326 wof under vss\r\n"), 32*1024)
	wofPath := filepath.Join(wofDir, "tool.exe")
	if err := os.WriteFile(wofPath, wofWant, 0o644); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("compact", "/c", "/exe:xpress4k", wofPath).CombinedOutput(); err != nil {
		t.Fatalf("compact /exe: %v: %s", err, out)
	}
	cloudWant := "hydrated cloud file under vss"
	cloudPath := createTempFile(t, syncRoot, "Budget.xlsx", cloudWant)
	convertToPlaceholder(t, cloudPath)
	placeholder := createPlaceholder(t, syncRoot, "Online.docx", 16*1024)

	provider := privateTestLocalProvider(t, t.TempDir())
	mgr := NewBackupManager(BackupConfig{
		Provider:    provider,
		Paths:       []string{wofDir, syncRoot},
		StagingDir:  t.TempDir(),
		VSSEnabled:  true,
		VSSProvider: vss.NewProvider(vss.DefaultConfig()),
	})
	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	t.Logf("job status=%q files=%d errors=%d warning=%q", job.Status, job.FilesBackedUp, job.ErrorCount, job.Warning)
	if job.ErrorCount != 0 {
		t.Fatalf("a WOF or cloud file under VSS must be captured or reported, never errored: %q", job.Error)
	}
	if !strings.Contains(job.Warning, placeholder) {
		t.Fatalf("the online-only placeholder must be named on the Warning: %q", job.Warning)
	}
	after := logEntry(t, "placeholder after VSS backup", placeholder)
	if notStoredLocallyReason(platformRawWinAttrs(after)) == "" {
		t.Fatal("the VSS backup hydrated the placeholder")
	}

	restoreRoot := t.TempDir()
	res, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: job.Snapshot.ID, TargetPath: restoreRoot}, nil)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if res.FilesFailed != 0 {
		t.Fatalf("restore result = %+v", res)
	}
	for _, c := range []struct {
		label, path string
		want        []byte
	}{
		{"WOF file", wofPath, wofWant},
		{"hydrated cloud file", cloudPath, []byte(cloudWant)},
	} {
		got, readErr := os.ReadFile(filepath.Join(restoreRoot, stripVolumeAndLeadingSeparators(c.path)))
		switch {
		case readErr == nil && bytes.Equal(got, c.want):
			t.Logf("%s under VSS: BACKED UP, restored byte-identical", c.label)
		case readErr == nil:
			t.Fatalf("%s under VSS restored with wrong content (%d bytes, want %d)", c.label, len(got), len(c.want))
		case strings.Contains(job.Warning, c.path):
			t.Logf("%s under VSS: NOT BACKED UP, reported on the Warning (its filter does not serve the shadow copy)", c.label)
		default:
			t.Fatalf("%s under VSS was neither restored nor reported: %v", c.label, readErr)
		}
	}
}
