package tools

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// writeAgedFile creates a file whose mtime is `age` in the past, so the
// scanner's min-age gate (temp_files, 24h) can be driven deterministically.
func writeAgedFile(t *testing.T, path string, size int, age time.Duration) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, make([]byte, size), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	when := time.Now().Add(-age)
	if err := os.Chtimes(path, when, when); err != nil {
		t.Fatalf("chtimes %s: %v", path, err)
	}
}

func runAnalyzeFilesystem(t *testing.T, root string) FilesystemAnalysisResponse {
	t.Helper()
	result := AnalyzeFilesystem(map[string]any{
		"path":           root,
		"maxDepth":       12,
		"timeoutSeconds": 30,
		"maxEntries":     100000,
		"workers":        2,
	})
	if result.Status != "completed" {
		t.Fatalf("AnalyzeFilesystem failed: %s", result.Error)
	}
	var response FilesystemAnalysisResponse
	if err := json.Unmarshal([]byte(result.Stdout), &response); err != nil {
		t.Fatalf("decode analysis response: %v", err)
	}
	return response
}

// The scanner must classify through the rooted rule table, not the old
// substring classifier. A temp directory named "tmp" that is NOT /tmp is the
// regression the old `strings.Contains(n, "/tmp/")` shipped.
func TestAnalyzeFilesystemClassifiesThroughTheRuleTable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX path fixture; the Windows rules are covered by the shared fixture table")
	}
	if runtime.GOOS == "linux" {
		// The default /tmp is a real rule anchor, so put this negative fixture
		// in the package directory instead.
		dir, err := os.Getwd()
		if err != nil {
			t.Fatal(err)
		}
		t.Setenv("TMPDIR", dir)
	}
	root := t.TempDir()
	// An app directory that merely CONTAINS a component called tmp.
	writeAgedFile(t, filepath.Join(root, "opt", "app", "tmp", "build.log"), 4096, 72*time.Hour)
	// A directory that merely CONTAINS a component called .cache.
	writeAgedFile(t, filepath.Join(root, "var", "lib", "postgres", ".cache", "blob"), 4096, 72*time.Hour)

	response := runAnalyzeFilesystem(t, root)
	for _, candidate := range response.CleanupCandidates {
		t.Errorf("no file under a scratch root should be a cleanup candidate, got %+v", candidate)
	}
	if len(response.TempAccumulation) != 0 {
		t.Errorf("tempAccumulation should be empty, got %+v", response.TempAccumulation)
	}
}

func TestClassifyCleanupPathComputesSafeAndGranularity(t *testing.T) {
	now := time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)
	old := now.Add(-48 * time.Hour)
	fresh := now.Add(-1 * time.Hour)

	category, granularity, safe := classifyCleanupPathFor("linux", "/tmp/build.tmp", old, now)
	if category != "temp_files" || granularity != "file" || !safe {
		t.Errorf("aged /tmp file: got %q/%q safe=%v", category, granularity, safe)
	}

	category, _, safe = classifyCleanupPathFor("linux", "/tmp/build.tmp", fresh, now)
	if category != "" || safe {
		t.Errorf("fresh /tmp file must not be a candidate: got %q safe=%v", category, safe)
	}

	category, granularity, safe = classifyCleanupPathFor("darwin", "/Users/alice/.Trash", now, now)
	if category != "trash" || granularity != "contents" || !safe {
		t.Errorf("trash root: got %q/%q safe=%v", category, granularity, safe)
	}

	category, _, safe = classifyCleanupPathFor("windows",
		`C:\Users\alice\AppData\Local\Google\Chrome\User Data\Default\Bookmarks`, now, now)
	if category != "" || safe {
		t.Errorf("Chrome Bookmarks must never be a candidate: got %q safe=%v", category, safe)
	}
}

// The old classifier is gone. This keeps a later refactor from quietly
// resurrecting a substring path next to the rule table.
func TestNoSubstringClassifierRemains(t *testing.T) {
	source, err := os.ReadFile("filesystem_analysis.go")
	if err != nil {
		t.Fatalf("read filesystem_analysis.go: %v", err)
	}
	for _, banned := range []string{`"/tmp/"`, `"/library/caches/"`, `"/.cache/"`, `"/appdata/local/packages/"`} {
		if idx := indexOfCleanupSubstring(string(source), banned); idx >= 0 {
			t.Errorf("filesystem_analysis.go still contains the substring classifier fragment %s at offset %d", banned, idx)
		}
	}
}

func indexOfCleanupSubstring(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}

func TestIsWindowsVolumeRoot(t *testing.T) {
	cases := []struct {
		path string
		want bool
	}{
		{`C:\`, true},
		{`c:/`, true},
		{`D:\`, true},
		{`C:`, true},
		{`C:\Users`, false},
		{`C:\$Recycle.Bin`, false},
		{`\\server\share`, false},
	}
	for _, c := range cases {
		if got := isWindowsVolumeRoot(c.path); got != c.want {
			t.Errorf("isWindowsVolumeRoot(%q) = %v, want %v", c.path, got, c.want)
		}
	}
}

// Defect 2: the only Windows trash path was the literal C:\$Recycle.Bin, which
// is depth 1 and therefore refused by isRecursiveDeleteBoundary — Windows bin
// reclaim was dead on arrival, and no other volume's bin was ever seen. The bin
// is now enumerated per SID, one level down, on whatever volume was scanned.
func TestEnumerateWindowsRecycleBinsListsSidDirectories(t *testing.T) {
	volumeRoot := t.TempDir()
	binRoot := filepath.Join(volumeRoot, "$Recycle.Bin")
	for _, sid := range []string{"S-1-5-21-1111111111-1-1-1001", "S-1-5-18"} {
		if err := os.MkdirAll(filepath.Join(binRoot, sid), 0o700); err != nil {
			t.Fatalf("mkdir sid dir: %v", err)
		}
	}
	if err := os.MkdirAll(filepath.Join(binRoot, "notasid"), 0o700); err != nil {
		t.Fatalf("mkdir decoy dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(binRoot, "desktop.ini"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write desktop.ini: %v", err)
	}

	paths, scanErrors := enumerateWindowsRecycleBins(volumeRoot)
	if len(scanErrors) != 0 {
		t.Fatalf("unexpected scan errors: %+v", scanErrors)
	}
	got := map[string]bool{}
	for _, p := range paths {
		got[filepath.Base(p)] = true
	}
	if len(got) != 2 || !got["S-1-5-21-1111111111-1-1-1001"] || !got["S-1-5-18"] {
		t.Fatalf("expected exactly the two SID directories, got %v", got)
	}
}

func TestEnumerateWindowsRecycleBinsReportsReadErrors(t *testing.T) {
	volumeRoot := t.TempDir()
	// $Recycle.Bin exists but is a FILE, so ReadDir fails with something other
	// than IsNotExist. Defect: that error used to be swallowed entirely.
	if err := os.WriteFile(filepath.Join(volumeRoot, "$Recycle.Bin"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write decoy: %v", err)
	}
	paths, scanErrors := enumerateWindowsRecycleBins(volumeRoot)
	if len(paths) != 0 {
		t.Errorf("expected no paths, got %v", paths)
	}
	if len(scanErrors) != 1 {
		t.Fatalf("expected the ReadDir error to be reported, got %+v", scanErrors)
	}
}

// §13 row 11 follow-up: isRealPathUnderRoot used to collapse EVERY
// EvalSymlinks error — permission-denied included — into "not under root",
// silently dropping a real trash dir with no trace. A non-ENOENT error must
// surface as a scanError, and an EACCES specifically must bump
// permissionDeniedCount, the same contract estimateDirectorySize already
// upholds for a locked directory.
func TestTrashPathsForRootReportsPermissionDeniedTrashDir(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX mode bits")
	}
	if os.Geteuid() == 0 {
		t.Skip("root ignores the mode bits this test relies on")
	}
	scanRoot := t.TempDir()
	locked := filepath.Join(scanRoot, "locked")
	if err := os.MkdirAll(locked, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	trash := filepath.Join(locked, ".Trash")
	if err := os.MkdirAll(trash, 0o700); err != nil {
		t.Fatalf("mkdir trash: %v", err)
	}
	// EvalSymlinks on trash must traverse `locked`, which we now seal off.
	if err := os.Chmod(locked, 0o000); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o700) })

	home := locked
	paths, scanErrors, permissionDeniedCount := trashPathsForRoot("darwin", scanRoot, home)
	for _, p := range paths {
		if p == trash {
			t.Fatalf("a permission-denied trash dir must not be silently offered as a candidate, got %v", paths)
		}
	}
	if len(scanErrors) == 0 {
		t.Fatal("expected the permission error to be reported, got none")
	}
	if permissionDeniedCount == 0 {
		t.Fatal("expected permissionDeniedCount to be bumped for the EACCES")
	}
}

func TestTrashPathsForRootIsVolumeScopedOnWindows(t *testing.T) {
	paths, scanErrors, _ := trashPathsForRoot("windows", `C:\Users\alice`, "")
	if len(paths) != 0 || len(scanErrors) != 0 {
		t.Fatalf("a scan rooted below the volume root must emit no bin candidates, got %v / %+v", paths, scanErrors)
	}
}

func TestTrashPathsForRootPosixSkipsTrashOutsideTheScannedRoot(t *testing.T) {
	// §13 row 11: a /data scan must not propose deleting the OS volume's trash.
	home := t.TempDir()
	for _, trash := range []string{filepath.Join(home, ".local", "share", "Trash"), filepath.Join(home, ".Trash")} {
		if err := os.MkdirAll(trash, 0o700); err != nil {
			t.Fatalf("mkdir trash: %v", err)
		}
	}
	elsewhere := t.TempDir()
	paths, _, _ := trashPathsForRoot("linux", elsewhere, home)
	for _, path := range paths {
		if strings.HasPrefix(path, home) {
			t.Fatalf("trash under %s must not be offered for a scan rooted at %s (got %v)", home, elsewhere, paths)
		}
	}
}

func TestTrashPathsForRootPosixUsesHome(t *testing.T) {
	home := t.TempDir()
	for _, trash := range []string{filepath.Join(home, ".local", "share", "Trash"), filepath.Join(home, ".Trash")} {
		if err := os.MkdirAll(trash, 0o700); err != nil {
			t.Fatalf("mkdir trash: %v", err)
		}
	}
	paths, _, _ := trashPathsForRoot("linux", "/", home)
	want := filepath.Join(home, ".local", "share", "Trash")
	found := false
	for _, p := range paths {
		if p == want {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected %s in %v", want, paths)
	}

	paths, _, _ = trashPathsForRoot("darwin", "/", home)
	want = filepath.Join(home, ".Trash")
	found = false
	for _, p := range paths {
		if p == want {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected %s in %v", want, paths)
	}
}
