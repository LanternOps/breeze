package tools

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
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
