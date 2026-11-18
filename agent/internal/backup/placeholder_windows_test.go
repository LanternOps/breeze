//go:build windows

package backup

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
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
	info := logEntry(t, "WOF file", path)
	if tag := reparseTagOf(t, path); tag != ioReparseTagWOF {
		t.Fatalf("compact /exe did not produce a WOF file: tag 0x%08X, output %s", tag, out)
	}
	t.Logf("Go reports a WOF file as ModeIrregular: %v (the #7326 premise)", info.Mode()&os.ModeIrregular != 0)

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
	before := logEntry(t, "unhydrated placeholder", placeholder)
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
	info := logEntry(t, "hydrated cloud file", path)
	if tag := reparseTagOf(t, path); !isDataReparseTag(tag) || tag == ioReparseTagWOF {
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
