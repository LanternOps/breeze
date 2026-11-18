//go:build unix

package backup

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// The placeholder policy (#7326) keys on Windows file attributes and reparse
// tags, which no Unix filesystem has. These tests drive it on any CI host
// through three seams: rawWinAttrsFor (the attributes the directory listing
// reported), skippedReparsePointFor (the reparse tag), and openDataReparseFile
// (whether the file opens through its filter). A FIFO stands in for an entry
// Go reports as ModeIrregular. The real Windows behaviour is covered by
// placeholder_windows_test.go.

func stubWinAttrs(t *testing.T, byName map[string]uint32) {
	t.Helper()
	orig := rawWinAttrsFor
	rawWinAttrsFor = func(info os.FileInfo) uint32 { return byName[info.Name()] }
	t.Cleanup(func() { rawWinAttrsFor = orig })
}

func stubReparseTags(t *testing.T, byName map[string]uint32) *[]string {
	t.Helper()
	var classified []string
	orig := skippedReparsePointFor
	skippedReparsePointFor = func(path string, info os.FileInfo) (skippedReparsePoint, bool) {
		classified = append(classified, path)
		tag, ok := byName[filepath.Base(path)]
		if !ok {
			return skippedReparsePoint{}, false
		}
		return skippedReparsePoint{path: path, kind: reparseKindOther, tag: tag}, true
	}
	t.Cleanup(func() { skippedReparsePointFor = orig })
	return &classified
}

func stubDataReparseOpen(t *testing.T, err error) *[]string {
	t.Helper()
	var opened []string
	orig := openDataReparseFile
	openDataReparseFile = func(path string) error {
		opened = append(opened, path)
		return err
	}
	t.Cleanup(func() { openDataReparseFile = orig })
	return &opened
}

func mkfifo(t *testing.T, path string) {
	t.Helper()
	if err := syscall.Mkfifo(path, 0o644); err != nil {
		t.Skipf("mkfifo unsupported here: %v", err)
	}
}

func manifestPaths(files []backupFile) map[string]backupFile {
	out := make(map[string]backupFile, len(files))
	for _, f := range files {
		out[f.snapshotPath] = f
	}
	return out
}

// An unhydrated cloud placeholder (OneDrive Files On-Demand) is skipped and
// reported, never classified or opened: reading it would download it, and a
// whole-machine backup must not hydrate a user's entire OneDrive.
func TestCollectBackupFiles_UnhydratedPlaceholderSkippedNotOpened(t *testing.T) {
	root := t.TempDir()
	createTempFile(t, root, "data.txt", "payload")
	profile := filepath.Join(root, "OneDrive")
	if err := os.Mkdir(profile, 0o755); err != nil {
		t.Fatal(err)
	}
	createTempFile(t, profile, "Report.docx", "local bytes stand in for the cloud copy")
	stubWinAttrs(t, map[string]uint32{
		"Report.docx": winAttrReparsePoint | winAttrSparseFile | winAttrOffline | winAttrRecallOnDataAccess,
	})
	classified := stubReparseTags(t, nil)
	opened := stubDataReparseOpen(t, nil)

	files, skips, err := NewBackupManager(BackupConfig{}).collectBackupFilesWithSkips(context.Background(), []string{root}, nil, nil)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	got := manifestPaths(files)
	if _, ok := got["path_0/OneDrive/Report.docx"]; ok {
		t.Fatal("an unhydrated placeholder must not be in the backup: reading it hydrates it")
	}
	if _, ok := got["path_0/data.txt"]; !ok {
		t.Fatal("regular file missing")
	}
	if len(*classified) != 0 || len(*opened) != 0 {
		t.Fatalf("a placeholder must not be classified or opened: classified=%v opened=%v", *classified, *opened)
	}
	if skips.notLocalTotal != 1 || len(skips.notLocalSample) != 1 || skips.notLocalSample[0].path != filepath.Join(profile, "Report.docx") {
		t.Fatalf("placeholder not recorded: %+v", skips)
	}
	if d := skips.notLocalSample[0].detail; !strings.Contains(d, "recall on data access") || !strings.Contains(d, "offline") {
		t.Fatalf("detail = %q, want the attributes that made it a placeholder", d)
	}
	if skips.total != 0 {
		t.Fatalf("a placeholder is not counted as a skipped reparse point: %+v", skips)
	}
	if d, ok := got["path_0/OneDrive"]; !ok || d.kind != KindDir {
		t.Fatal("a directory whose only file was a placeholder needs its own KindDir entry to be recreated")
	}
}

// A directory with RECALL_ON_OPEN has no local representation at all: it is
// not descended (enumerating it would fetch it) and nothing under it is read.
func TestCollectBackupFiles_RecallOnOpenDirectoryNotDescended(t *testing.T) {
	root := t.TempDir()
	createTempFile(t, root, "data.txt", "payload")
	virtual := filepath.Join(root, "Shared With Me")
	if err := os.Mkdir(virtual, 0o755); err != nil {
		t.Fatal(err)
	}
	createTempFile(t, virtual, "inside.txt", "must not be reached")
	stubWinAttrs(t, map[string]uint32{"Shared With Me": winAttrDirectory | winAttrRecallOnOpen})

	files, skips, err := NewBackupManager(BackupConfig{}).collectBackupFilesWithSkips(context.Background(), []string{root}, nil, nil)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	for p := range manifestPaths(files) {
		if strings.HasPrefix(p, "path_0/Shared With Me") {
			t.Fatalf("a virtual directory must be neither descended nor recorded: %s", p)
		}
	}
	if skips.notLocalTotal != 1 || skips.notLocalSample[0].path != virtual {
		t.Fatalf("virtual directory not recorded: %+v", skips)
	}
}

// A partially local directory (RECALL_ON_DATA_ACCESS on a directory) is
// still walked: it can hold files that are on this machine, and those must
// be backed up. Only its unhydrated children are skipped.
func TestCollectBackupFiles_PartiallyLocalDirectoryStillWalked(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "Documents")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	createTempFile(t, dir, "local.txt", "on disk")
	createTempFile(t, dir, "cloud.txt", "not on disk")
	stubWinAttrs(t, map[string]uint32{
		"Documents": winAttrDirectory | winAttrReparsePoint | winAttrRecallOnDataAccess,
		"cloud.txt": winAttrReparsePoint | winAttrRecallOnDataAccess,
	})

	files, skips, err := NewBackupManager(BackupConfig{}).collectBackupFilesWithSkips(context.Background(), []string{root}, nil, nil)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	got := manifestPaths(files)
	if _, ok := got["path_0/Documents/local.txt"]; !ok {
		t.Fatal("a local file inside a partially local directory must be backed up")
	}
	if _, ok := got["path_0/Documents/cloud.txt"]; ok {
		t.Fatal("the unhydrated sibling must be skipped")
	}
	if skips.notLocalTotal != 1 {
		t.Fatalf("notLocalTotal = %d, want 1 (the file, not the directory)", skips.notLocalTotal)
	}
}

// A WOF-compressed file (CompactOS, compact /exe) is an ordinary data file
// that Go reports as ModeIrregular. When it opens through wof.sys it is read
// like any other file, so it is backed up and restores as a plain file.
func TestCollectBackupFiles_WOFCompressedFileCaptured(t *testing.T) {
	root := t.TempDir()
	createTempFile(t, root, "data.txt", "payload")
	wof := filepath.Join(root, "notepad.exe")
	mkfifo(t, wof)
	stubReparseTags(t, map[string]uint32{"notepad.exe": ioReparseTagWOF})
	opened := stubDataReparseOpen(t, nil)

	files, skips, err := NewBackupManager(BackupConfig{}).collectBackupFilesWithSkips(context.Background(), []string{root}, nil, nil)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	f, ok := manifestPaths(files)["path_0/notepad.exe"]
	if !ok {
		t.Fatal("a WOF-compressed file must be backed up")
	}
	if f.kind != "" || f.sourcePath != wof {
		t.Fatalf("WOF file must be captured as a regular file entry, got kind=%q source=%q", f.kind, f.sourcePath)
	}
	if len(*opened) != 1 || (*opened)[0] != wof {
		t.Fatalf("the file must be proven to open through its filter first, opened=%v", *opened)
	}
	if skips.total != 0 || skips.notLocalTotal != 0 {
		t.Fatalf("a captured WOF file is not a skip: %+v", skips)
	}
}

// When the file does not open through its filter (wof.sys or cldflt.sys not
// attached to that volume, e.g. a shadow copy), reading it would fail per
// file. It stays skipped and the Warning says why.
func TestCollectBackupFiles_DataReparseFileThatWontOpenStaysSkipped(t *testing.T) {
	root := t.TempDir()
	wof := filepath.Join(root, "notepad.exe")
	mkfifo(t, wof)
	stubReparseTags(t, map[string]uint32{"notepad.exe": ioReparseTagWOF})
	stubDataReparseOpen(t, errors.New("The file cannot be accessed by the system."))

	files, skips, err := NewBackupManager(BackupConfig{}).collectBackupFilesWithSkips(context.Background(), []string{root}, nil, nil)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if _, ok := manifestPaths(files)["path_0/notepad.exe"]; ok {
		t.Fatal("a file that will not open must not be captured")
	}
	if skips.total != 1 || len(skips.sample) != 1 {
		t.Fatalf("skip not recorded: %+v", skips)
	}
	s := skips.sample[0].String()
	if !strings.Contains(s, "tag 0x80000017") || !strings.Contains(s, "cannot be accessed") {
		t.Fatalf("skip must name the tag and the open error, got %q", s)
	}
}

// A fully local OneDrive file keeps its cloud reparse tag but has no recall
// attribute: its data is on disk, so it is backed up like any other file.
// With Known Folder Move that is the user's whole Documents folder.
func TestCollectBackupFiles_HydratedCloudFileCaptured(t *testing.T) {
	root := t.TempDir()
	hydrated := filepath.Join(root, "Budget.xlsx")
	mkfifo(t, hydrated)
	stubWinAttrs(t, map[string]uint32{"Budget.xlsx": winAttrReparsePoint | winAttrPinned})
	stubReparseTags(t, map[string]uint32{"Budget.xlsx": 0x9000601A})
	opened := stubDataReparseOpen(t, nil)

	files, skips, err := NewBackupManager(BackupConfig{}).collectBackupFilesWithSkips(context.Background(), []string{root}, nil, nil)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if f, ok := manifestPaths(files)["path_0/Budget.xlsx"]; !ok || f.kind != "" {
		t.Fatalf("a hydrated cloud file must be captured as a regular file, files=%+v", files)
	}
	if len(*opened) != 1 || skips.total != 0 || skips.notLocalTotal != 0 {
		t.Fatalf("opened=%v skips=%+v", *opened, skips)
	}
}

// A reparse point that is not a data file (an app execution alias, an
// unknown tag) keeps the #7051 behaviour: skipped and reported, and never
// opened, since opening it can do something other than read data.
func TestCollectBackupFiles_NonDataReparseTagNeverOpened(t *testing.T) {
	root := t.TempDir()
	alias := filepath.Join(root, "python.exe")
	mkfifo(t, alias)
	stubReparseTags(t, map[string]uint32{"python.exe": 0x8000001B})
	opened := stubDataReparseOpen(t, nil)

	files, skips, err := NewBackupManager(BackupConfig{}).collectBackupFilesWithSkips(context.Background(), []string{root}, nil, nil)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if _, ok := manifestPaths(files)["path_0/python.exe"]; ok {
		t.Fatal("an app execution alias is not a data file")
	}
	if len(*opened) != 0 {
		t.Fatalf("a non-data reparse point must never be opened, opened=%v", *opened)
	}
	if skips.total != 1 || skips.sample[0].tag != 0x8000001B {
		t.Fatalf("skip not recorded: %+v", skips)
	}
}

// A backup path that is itself an unhydrated placeholder file gets the same
// treatment as one met during the walk.
func TestCollectBackupFiles_PlaceholderAsBackupRootSkipped(t *testing.T) {
	root := t.TempDir()
	file := createTempFile(t, root, "Thesis.docx", "cloud copy")
	stubWinAttrs(t, map[string]uint32{"Thesis.docx": winAttrReparsePoint | winAttrRecallOnDataAccess})
	opened := stubDataReparseOpen(t, nil)

	files, skips, err := NewBackupManager(BackupConfig{}).collectBackupFilesWithSkips(context.Background(), []string{file}, nil, nil)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if len(files) != 0 {
		t.Fatalf("an unhydrated placeholder root must not be captured: %+v", files)
	}
	if skips.notLocalTotal != 1 || skips.notLocalSample[0].path != file || len(*opened) != 0 {
		t.Fatalf("skips=%+v opened=%v", skips, *opened)
	}
}

// A WOF-compressed file named directly as a backup path is captured too.
func TestCollectBackupFiles_WOFFileAsBackupRootCaptured(t *testing.T) {
	root := t.TempDir()
	wof := filepath.Join(root, "notepad.exe")
	mkfifo(t, wof)
	stubReparseTags(t, map[string]uint32{"notepad.exe": ioReparseTagWOF})
	stubDataReparseOpen(t, nil)

	files, _, err := NewBackupManager(BackupConfig{}).collectBackupFilesWithSkips(context.Background(), []string{wof}, nil, nil)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if len(files) != 1 || files[0].snapshotPath != "path_0/notepad.exe" || files[0].kind != "" {
		t.Fatalf("files = %+v, want the WOF root captured as a regular file", files)
	}
}

// End to end: a run that skips placeholders completes green, names them on
// the Warning, and adds nothing to ErrorCount.
func TestRunBackupContext_PlaceholderSkipIsWarningNotError(t *testing.T) {
	root := t.TempDir()
	createTempFile(t, root, "data.txt", "payload that uploads fine")
	createTempFile(t, root, "Photo.jpg", "cloud copy")
	stubWinAttrs(t, map[string]uint32{"Photo.jpg": winAttrReparsePoint | winAttrOffline | winAttrRecallOnDataAccess})

	mgr := NewBackupManager(BackupConfig{
		Provider:   newMockProvider(),
		Paths:      []string{root},
		StagingDir: t.TempDir(),
	})
	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if job.Status != jobStatusCompleted || job.ErrorCount != 0 || job.FilesBackedUp != 1 {
		t.Fatalf("status=%q errors=%d files=%d", job.Status, job.ErrorCount, job.FilesBackedUp)
	}
	if !strings.Contains(job.Warning, "1 file(s) were not backed up because their data is not stored on this machine") ||
		!strings.Contains(job.Warning, filepath.Join(root, "Photo.jpg")) {
		t.Fatalf("Warning must name the placeholder, got %q", job.Warning)
	}
}
