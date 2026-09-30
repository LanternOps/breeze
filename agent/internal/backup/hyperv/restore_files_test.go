package hyperv

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// fakeObjectStore serves object bytes by key; a key in errs fails.
type fakeObjectStore struct {
	mu      sync.Mutex
	objects map[string][]byte
	errs    map[string]error
	calls   []string
}

func (f *fakeObjectStore) Upload(string, string) error   { return errors.New("read only") }
func (f *fakeObjectStore) List(string) ([]string, error) { return nil, errors.New("read only") }
func (f *fakeObjectStore) Delete(string) error           { return errors.New("read only") }
func (f *fakeObjectStore) Download(key, local string) error {
	f.mu.Lock()
	f.calls = append(f.calls, key)
	data, ok := f.objects[key]
	err := f.errs[key]
	f.mu.Unlock()
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("no such object: " + key)
	}
	return os.WriteFile(local, data, 0o600)
}

func sha(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// vssEntry is a file-snapshot entry as a Windows backup with VSS records it:
// the shadow-copy device path it was read from plus its real path.
func vssEntry(shadow int, original, key string, data []byte) vmRestoreManifFile {
	rel := strings.TrimPrefix(original, `C:\`)
	return vmRestoreManifFile{
		SourcePath:   `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy` + string(rune('0'+shadow)) + `\` + rel,
		OriginalPath: original,
		BackupPath:   key,
		Size:         int64(len(data)),
		Checksum:     sha(data),
	}
}

func TestVMRestoreRelativePath(t *testing.T) {
	tests := []struct {
		name     string
		source   string
		original string
		want     string
		wantErr  bool
		wantCode string // substring the error must carry
	}{
		{name: "vss shadow source with original path", source: `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1\brzlab\markers\m1.txt`, original: `C:\brzlab\markers\m1.txt`, want: "brzlab/markers/m1.txt"},
		{name: "vss shadow source, two-digit shadow id", source: `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy12\Users\labadmin\Documents\q3.xlsx`, original: `C:\Users\labadmin\Documents\q3.xlsx`, want: "Users/labadmin/Documents/q3.xlsx"},
		{name: "vss shadow source without original path", source: `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy3\Windows\System32\config\SYSTEM`, want: "Windows/System32/config/SYSTEM"},
		{name: "plain drive path", source: `C:\Users\labadmin\Desktop\notes.txt`, want: "Users/labadmin/Desktop/notes.txt"},
		{name: "lower-case drive with forward slashes", source: `d:/data/exports/a.csv`, want: "data/exports/a.csv"},
		{name: "extended-length drive path", source: `\\?\C:\very\long\path.bin`, want: "very/long/path.bin"},
		{name: "unc share", source: `\\fileserver\share\dept\plan.docx`, want: "dept/plan.docx"},
		{name: "extended-length unc share", source: `\\?\UNC\fileserver\share\dept\plan.docx`, want: "dept/plan.docx"},
		{name: "volume guid path", source: `\\?\Volume{6b2e1f0a-0000-0000-0000-100000000000}\data\x.txt`, want: "data/x.txt"},
		{name: "posix absolute path", source: "/home/ops/.bashrc", want: "home/ops/.bashrc"},
		{name: "relative path", source: `path_0\reports\config.json`, want: "path_0/reports/config.json"},
		{name: "dot components dropped", source: `C:\a\.\b\c.txt`, want: "a/b/c.txt"},
		{name: "original path wins over a different source", source: `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1\x\y.txt`, original: `E:\x\y.txt`, want: "x/y.txt"},

		{name: "parent traversal", source: `C:\a\..\..\Windows\System32\evil.dll`, wantErr: true},
		{name: "parent traversal in original path", source: `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1\ok.txt`, original: `C:\..\escape.txt`, wantErr: true},
		{name: "trailing-dot parent component", source: `C:\a\.. \b.txt`, wantErr: true},
		{name: "alternate data stream", source: `C:\a\b.txt:hidden`, wantErr: true},
		{name: "drive-relative component", source: `C:\a\D:b.txt`, wantErr: true},
		{name: "volume root only", source: `C:\`, wantErr: true},
		{name: "shadow device with no path", source: `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1`, wantErr: true},
		{name: "globalroot without device", source: `\\?\GLOBALROOT\Foo\x.txt`, wantErr: true},
		{name: "unc without share", source: `\\fileserver`, wantErr: true},
		{name: "empty", source: "", wantErr: true},
		{name: "nul byte", source: "C:\\a\x00b.txt", wantErr: true},
		{name: "trailing dot name", source: `C:\a\name.`, wantErr: true},
		{name: "trailing space directory", source: `C:\a \b.txt`, wantErr: true},

		{name: "device name file", source: `C:\a\CON`, wantErr: true, wantCode: "invalid_windows_name"},
		{name: "device name with extension", source: `C:\a\nul.txt`, wantErr: true, wantCode: "invalid_windows_name"},
		{name: "device name directory", source: `C:\a\com1\b.txt`, wantErr: true, wantCode: "invalid_windows_name"},
		{name: "superscript printer port", source: "C:\\a\\LPT\u00b9.log", wantErr: true, wantCode: "invalid_windows_name"},
		{name: "console input device", source: `C:\CONIN$`, wantErr: true, wantCode: "invalid_windows_name"},
		{name: "short name directory", source: `C:\PROGRA~1\app\x.dll`, want: "PROGRA~1/app/x.dll"},
		{name: "short name file", source: `C:\data\REPORT~2.TXT`, want: "data/REPORT~2.TXT"},
		{name: "short name in original path", source: `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1\ok.txt`, original: `C:\DOCUME~1\ok.txt`, want: "DOCUME~1/ok.txt"},
		{name: "name starting with a device name", source: `C:\a\console.log`, want: "a/console.log"},
		{name: "tilde not followed by a digit", source: `C:\a\~$budget.xlsx`, want: "a/~$budget.xlsx"},
		{name: "four-digit port name", source: `C:\a\COM10.txt`, want: "a/COM10.txt"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := vmRestoreRelativePath(vmRestoreManifFile{SourcePath: tt.source, OriginalPath: tt.original})
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected an error, got %q", got)
				}
				if tt.wantCode != "" && !strings.Contains(err.Error(), tt.wantCode) {
					t.Fatalf("error %q does not carry %q", err, tt.wantCode)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestRestoreManifestFiles_PlacesVSSSnapshotUnderRoot(t *testing.T) {
	root := t.TempDir()
	store := &fakeObjectStore{objects: map[string][]byte{}}
	var files []vmRestoreManifFile
	for i, orig := range []string{
		`C:\brzlab\markers\m1.txt`,
		`C:\brzlab\markers\m2.txt`,
		`C:\brzlab\markers\sub\m3.txt`,
		`C:\Users\labadmin\m4.txt`,
	} {
		data := []byte("marker-" + string(rune('1'+i)))
		key := "snapshots/snap-1/files/" + string(rune('a'+i)) + ".gz"
		store.objects[key] = data
		files = append(files, vssEntry(1, orig, key, data))
	}

	tally := restoreManifestFiles(context.Background(), files, store, root, t.TempDir(), nil)

	if err := tally.err(); err != nil {
		t.Fatalf("unexpected failure: %v (warnings %v)", err, tally.Warnings)
	}
	if tally.Total != 4 || tally.Restored != 4 || tally.Failed != 0 {
		t.Fatalf("tally = %+v, want 4 restored of 4", tally)
	}
	for i, rel := range []string{"brzlab/markers/m1.txt", "brzlab/markers/m2.txt", "brzlab/markers/sub/m3.txt", "Users/labadmin/m4.txt"} {
		got, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			t.Fatalf("expected %s under the restore root: %v", rel, err)
		}
		if want := "marker-" + string(rune('1'+i)); string(got) != want {
			t.Fatalf("%s = %q, want %q", rel, got, want)
		}
	}
	entries, _ := os.ReadDir(root)
	for _, e := range entries {
		if e.Name() != "brzlab" && e.Name() != "Users" {
			t.Fatalf("unexpected entry %q at the restore root", e.Name())
		}
	}
}

func TestRestoreManifestFiles_OutcomeRules(t *testing.T) {
	good := []byte("good bytes")
	tests := []struct {
		name         string
		files        []vmRestoreManifFile
		errs         map[string]error
		wantRestored int
		wantFailed   int
		wantErr      bool
	}{
		{
			name:       "every file refused is a failed restore",
			files:      []vmRestoreManifFile{{SourcePath: `C:\..\..\x.txt`, BackupPath: "k1", Size: int64(len(good))}, {SourcePath: `C:\a:stream`, BackupPath: "k1", Size: int64(len(good))}},
			wantFailed: 2, wantErr: true,
		},
		{
			name:       "every download failing is a failed restore",
			files:      []vmRestoreManifFile{vssEntry(1, `C:\a\1.txt`, "k1", good), vssEntry(1, `C:\a\2.txt`, "k2", good)},
			errs:       map[string]error{"k1": errors.New("403"), "k2": errors.New("403")},
			wantFailed: 2, wantErr: true,
		},
		{
			name:         "one failed file fails the restore",
			files:        []vmRestoreManifFile{vssEntry(1, `C:\a\1.txt`, "k1", good), vssEntry(1, `C:\a\2.txt`, "k2", good)},
			errs:         map[string]error{"k2": errors.New("timeout")},
			wantRestored: 1, wantFailed: 1, wantErr: true,
		},
		{
			name:       "size mismatch fails the file",
			files:      []vmRestoreManifFile{{SourcePath: `C:\a\1.txt`, BackupPath: "k1", Size: 999}},
			wantFailed: 1, wantErr: true,
		},
		{
			name:       "checksum mismatch fails the file",
			files:      []vmRestoreManifFile{{SourcePath: `C:\a\1.txt`, BackupPath: "k1", Size: int64(len(good)), Checksum: sha([]byte("other"))}},
			wantFailed: 1, wantErr: true,
		},
		{
			name:         "volatile mismatch is a warning",
			files:        []vmRestoreManifFile{{SourcePath: `C:\a\1.txt`, BackupPath: "k1", Size: 999, Volatile: true}},
			wantRestored: 1,
		},
		{
			name:         "missing backup path fails the file",
			files:        []vmRestoreManifFile{vssEntry(1, `C:\a\1.txt`, "k1", good), {SourcePath: `C:\a\2.txt`}},
			wantRestored: 1, wantFailed: 1, wantErr: true,
		},
		{
			name:         "directory and symlink entries are not file failures",
			files:        []vmRestoreManifFile{vssEntry(1, `C:\a\1.txt`, "k1", good), {SourcePath: `C:\a\empty`, Kind: "dir"}, {SourcePath: `C:\a\link`, Kind: "symlink"}},
			wantRestored: 1,
		},
		{
			name:    "an empty snapshot restored nothing",
			files:   nil,
			wantErr: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			store := &fakeObjectStore{objects: map[string][]byte{"k1": good, "k2": good}, errs: tt.errs}
			tally := restoreManifestFiles(context.Background(), tt.files, store, root, t.TempDir(), nil)
			if tally.Restored != tt.wantRestored || tally.Failed != tt.wantFailed {
				t.Fatalf("tally = %+v, want restored %d failed %d", tally, tt.wantRestored, tt.wantFailed)
			}
			if err := tally.err(); (err != nil) != tt.wantErr {
				t.Fatalf("err() = %v, wantErr %v", err, tt.wantErr)
			}
			if tt.wantFailed > 0 && len(tally.FailedFiles) == 0 {
				t.Fatal("failed files are not reported")
			}
		})
	}
}

func TestRestoreManifestFiles_NeverWritesOutsideRoot(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "vol")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	store := &fakeObjectStore{objects: map[string][]byte{"k": []byte("x")}}
	files := []vmRestoreManifFile{
		{SourcePath: `C:\..\outside.txt`, BackupPath: "k", Size: 1},
		{SourcePath: "../outside2.txt", BackupPath: "k", Size: 1},
		{SourcePath: `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1\..\outside3.txt`, BackupPath: "k", Size: 1},
	}
	tally := restoreManifestFiles(context.Background(), files, store, root, t.TempDir(), nil)
	if tally.Failed != 3 || tally.err() == nil {
		t.Fatalf("tally = %+v, want all 3 refused and a failed outcome", tally)
	}
	if len(store.calls) != 0 {
		t.Fatalf("refused entries were downloaded: %v", store.calls)
	}
	entries, _ := os.ReadDir(parent)
	if len(entries) != 1 {
		t.Fatalf("restore wrote outside its root: %v", entries)
	}
}

func TestRestoreManifestFiles_BoundsReportedFiles(t *testing.T) {
	var files []vmRestoreManifFile
	for i := 0; i < maxReportedFiles+50; i++ {
		files = append(files, vmRestoreManifFile{SourcePath: `C:\..\x`, BackupPath: "k", Size: 1})
	}
	tally := restoreManifestFiles(context.Background(), files, &fakeObjectStore{}, t.TempDir(), t.TempDir(), nil)
	if tally.Failed != maxReportedFiles+50 {
		t.Fatalf("failed = %d", tally.Failed)
	}
	if len(tally.FailedFiles) > maxReportedFiles || len(tally.Warnings) > maxReportedFiles {
		t.Fatalf("reported lists are unbounded: %d failed files, %d warnings", len(tally.FailedFiles), len(tally.Warnings))
	}
}

// The sync must outlive the call that started it: the exec layer cancels its
// context as soon as the command function returns.
func TestRunBackgroundSync_CompletesBeforeReturning(t *testing.T) {
	syncDir := filepath.Join(t.TempDir(), "sync-staging")
	data := []byte("payload")
	store := &fakeObjectStore{objects: map[string][]byte{"k1": data, "k2": data, "k3": data}}
	files := []vmRestoreManifFile{
		vssEntry(2, `C:\data\1.bin`, "k1", data),
		vssEntry(2, `C:\data\2.bin`, "k2", data),
		vssEntry(2, `C:\data\deep\3.bin`, "k3", data),
	}
	result := &InstantBootResult{Status: "completed"}

	ctx, cancel := context.WithCancel(context.Background())
	runBackgroundSync(ctx, result, syncDir, files, store, nil)
	cancel() // what execInstantBoot's deferred cancel does on return

	if result.SyncProgress == nil || result.SyncProgress.Synced != 3 || result.SyncProgress.Failed != 0 || result.SyncProgress.Total != 3 {
		t.Fatalf("sync progress = %+v, want 3 of 3 synced", result.SyncProgress)
	}
	if result.Status != "completed" || result.BackgroundSyncActive {
		t.Fatalf("status = %q active = %v, want completed and no sync left running", result.Status, result.BackgroundSyncActive)
	}
	for _, rel := range []string{"data/1.bin", "data/2.bin", "data/deep/3.bin"} {
		if _, err := os.Stat(filepath.Join(syncDir, filepath.FromSlash(rel))); err != nil {
			t.Fatalf("%s was not synced: %v", rel, err)
		}
	}
}

func TestRunBackgroundSync_FailureDegradesAndCleansUp(t *testing.T) {
	data := []byte("payload")
	tests := []struct {
		name       string
		errs       map[string]error
		ctx        func() context.Context
		wantSynced int
		wantFailed int
	}{
		{name: "a download fails", errs: map[string]error{"k2": errors.New("session revoked")}, ctx: context.Background, wantSynced: 1, wantFailed: 1},
		{name: "run budget already spent", ctx: func() context.Context {
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			return ctx
		}, wantSynced: 0, wantFailed: 2},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			syncDir := filepath.Join(t.TempDir(), "sync-staging")
			store := &fakeObjectStore{objects: map[string][]byte{"k1": data, "k2": data}, errs: tt.errs}
			files := []vmRestoreManifFile{vssEntry(1, `C:\d\1.bin`, "k1", data), vssEntry(1, `C:\d\2.bin`, "k2", data)}
			result := &InstantBootResult{Status: "completed"}

			runBackgroundSync(tt.ctx(), result, syncDir, files, store, nil)

			if result.SyncProgress == nil || result.SyncProgress.Synced != tt.wantSynced || result.SyncProgress.Failed != tt.wantFailed {
				t.Fatalf("sync progress = %+v, want synced %d failed %d", result.SyncProgress, tt.wantSynced, tt.wantFailed)
			}
			if result.Status != "degraded" || result.Error == "" || result.BackgroundSyncActive {
				t.Fatalf("status = %q error = %q active = %v, want degraded with an error", result.Status, result.Error, result.BackgroundSyncActive)
			}
			if _, err := os.Stat(syncDir); !os.IsNotExist(err) {
				t.Fatalf("partial sync staging was left behind: %v", err)
			}
		})
	}
}

func TestRunBackgroundSync_NothingToSync(t *testing.T) {
	result := &InstantBootResult{Status: "completed"}
	runBackgroundSync(context.Background(), result, filepath.Join(t.TempDir(), "s"), nil, &fakeObjectStore{}, nil)
	if result.Status != "completed" || result.BackgroundSyncActive {
		t.Fatalf("result = %+v", result)
	}
}

// A mounted volume root keeps its trailing separator through filepath.Clean
// (D:\ on Windows, / here), so containment must not append a second one.
func TestUnderRoot(t *testing.T) {
	sep := string(filepath.Separator)
	vol := filepath.Clean(sep) // "/" here; `\` on Windows
	tests := []struct {
		root, target string
		want         bool
	}{
		{vol, filepath.Join(vol, "brzlab", "m1.txt"), true},
		{filepath.Join(vol, "r"), filepath.Join(vol, "r", "a"), true},
		{filepath.Join(vol, "r"), filepath.Join(vol, "r"), false},
		{filepath.Join(vol, "r"), filepath.Join(vol, "rx", "a"), false},
		{filepath.Join(vol, "r"), filepath.Join(vol, "r", "..", "a"), false},
		{vol, vol, false},
	}
	for _, tt := range tests {
		if got := underRoot(tt.root, tt.target); got != tt.want {
			t.Errorf("underRoot(%q, %q) = %v, want %v", tt.root, tt.target, got, tt.want)
		}
	}
}

// planningStore also records the download plan a batching provider (the
// brokered storage-session provider) is handed before the downloads.
type planningStore struct {
	fakeObjectStore
	plans [][]string
}

func (p *planningStore) PrepareDownloads(keys []string) {
	p.plans = append(p.plans, append([]string(nil), keys...))
}

func TestRestoreManifestFiles_PlansOnlyPlaceableFiles(t *testing.T) {
	data := []byte("x")
	store := &planningStore{fakeObjectStore: fakeObjectStore{objects: map[string][]byte{"k1": data, "k3": data}}}
	files := []vmRestoreManifFile{
		vssEntry(1, `C:\a\1.txt`, "k1", data),
		{SourcePath: `C:\..\escape.txt`, BackupPath: "k2", Size: 1},
		{SourcePath: `C:\a\dir`, Kind: "dir"},
		vssEntry(1, `C:\a\3.txt`, "k3", data),
		{SourcePath: `C:\a\nokey.txt`},
	}
	restoreManifestFiles(context.Background(), files, store, t.TempDir(), t.TempDir(), nil)
	if len(store.plans) != 1 || strings.Join(store.plans[0], ",") != "k1,k3" {
		t.Fatalf("plans = %v, want one plan [k1 k3]", store.plans)
	}
}
