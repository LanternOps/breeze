package tools

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func isSortedDescFiles(s []FilesystemLargestFile) bool {
	return sort.SliceIsSorted(s, func(i, j int) bool { return s[i].SizeBytes > s[j].SizeBytes })
}

func TestAddTopLargestFileKeepsBoundedDescendingTopN(t *testing.T) {
	sizes := []int64{5, 1, 9, 3, 7, 2, 8, 4, 6, 10}
	var top []FilesystemLargestFile
	const limit = 3
	for _, sz := range sizes {
		addTopLargestFile(&top, FilesystemLargestFile{Path: "p", SizeBytes: sz}, limit)
	}

	if len(top) != limit {
		t.Fatalf("expected %d entries, got %d", limit, len(top))
	}
	if !isSortedDescFiles(top) {
		t.Fatalf("top not sorted descending: %+v", top)
	}
	got := []int64{top[0].SizeBytes, top[1].SizeBytes, top[2].SizeBytes}
	want := []int64{10, 9, 8}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("top-N = %v, want %v", got, want)
		}
	}
}

func TestAddTopLargestFileRejectsBelowMinAtCapacity(t *testing.T) {
	var top []FilesystemLargestFile
	const limit = 2
	addTopLargestFile(&top, FilesystemLargestFile{Path: "a", SizeBytes: 100}, limit)
	addTopLargestFile(&top, FilesystemLargestFile{Path: "b", SizeBytes: 50}, limit)
	// Below current min (50) at capacity — must be ignored.
	addTopLargestFile(&top, FilesystemLargestFile{Path: "c", SizeBytes: 10}, limit)

	if len(top) != 2 || top[0].SizeBytes != 100 || top[1].SizeBytes != 50 {
		t.Fatalf("unexpected top after reject: %+v", top)
	}
	for _, f := range top {
		if f.Path == "c" {
			t.Fatalf("path c should not have been inserted: %+v", top)
		}
	}
}

func TestAddTopLargestFileZeroLimitNoop(t *testing.T) {
	var top []FilesystemLargestFile
	addTopLargestFile(&top, FilesystemLargestFile{Path: "a", SizeBytes: 100}, 0)
	if len(top) != 0 {
		t.Fatalf("expected empty top with zero limit, got %+v", top)
	}
}

func TestAddTopLargestDirKeepsBoundedDescendingTopN(t *testing.T) {
	sizes := []int64{40, 10, 90, 30, 70}
	var top []FilesystemLargestDirectory
	const limit = 2
	for _, sz := range sizes {
		addTopLargestDir(&top, FilesystemLargestDirectory{Path: "d", SizeBytes: sz}, limit)
	}
	if len(top) != limit || top[0].SizeBytes != 90 || top[1].SizeBytes != 70 {
		t.Fatalf("unexpected dir top-N: %+v", top)
	}
}

func TestFileQualifiesForTop(t *testing.T) {
	cases := []struct {
		name  string
		top   []FilesystemLargestFile
		size  int64
		limit int
		want  bool
	}{
		{"zero limit", nil, 100, 0, false},
		{"below capacity", []FilesystemLargestFile{{SizeBytes: 5}}, 1, 3, true},
		{"at capacity above min", []FilesystemLargestFile{{SizeBytes: 9}, {SizeBytes: 5}}, 7, 2, true},
		{"at capacity equal min", []FilesystemLargestFile{{SizeBytes: 9}, {SizeBytes: 5}}, 5, 2, false},
		{"at capacity below min", []FilesystemLargestFile{{SizeBytes: 9}, {SizeBytes: 5}}, 4, 2, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := fileQualifiesForTop(tc.top, tc.size, tc.limit); got != tc.want {
				t.Fatalf("fileQualifiesForTop = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestIsDescendantNormalized(t *testing.T) {
	cases := []struct {
		path, ancestor string
		want           bool
	}{
		{"/a/b/c", "/a/b", true},
		{"/a/b", "/a/b", false},
		{"/ab", "/a", false}, // prefix but not a path child
		{"/a/b", "/", true},
		{"/", "/", false},
		{"c:/users/x", "c:/", true},
		{"c:/users", "c:/users", false},
	}
	for _, tc := range cases {
		got := isDescendantNormalized(normalizePathForHierarchy(tc.path), normalizePathForHierarchy(tc.ancestor))
		if got != tc.want {
			t.Fatalf("isDescendantNormalized(%q, %q) = %v, want %v", tc.path, tc.ancestor, got, tc.want)
		}
	}
}

func TestPathDepthNormalized(t *testing.T) {
	cases := map[string]int{"": 0, "/": 0, "/a": 1, "/a/b": 2, "/a/b/c": 3}
	for in, want := range cases {
		if got := pathDepthNormalized(normalizePathForHierarchy(in)); got != want {
			t.Fatalf("pathDepthNormalized(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestCollapseAncestorDirectoriesFoldsDominantChild(t *testing.T) {
	// Parent's size is almost entirely explained by one child (0.9 > 0.70), so
	// the ancestor should be collapsed away in favor of the descendant.
	candidates := []FilesystemLargestDirectory{
		{Path: "/data", SizeBytes: 1000},
		{Path: "/data/big", SizeBytes: 900},
		{Path: "/other", SizeBytes: 500},
	}
	out := collapseAncestorDirectories(candidates, 10, 0.70)

	paths := map[string]bool{}
	for _, d := range out {
		paths[d.Path] = true
	}
	if paths["/data"] {
		t.Fatalf("expected /data to be collapsed, got %+v", out)
	}
	if !paths["/data/big"] || !paths["/other"] {
		t.Fatalf("expected /data/big and /other retained, got %+v", out)
	}
	if !sort.SliceIsSorted(out, func(i, j int) bool { return out[i].SizeBytes > out[j].SizeBytes }) {
		t.Fatalf("collapse output not sorted descending: %+v", out)
	}
}

func TestCollapseAncestorDirectoriesKeepsIndependentDirs(t *testing.T) {
	candidates := []FilesystemLargestDirectory{
		{Path: "/a", SizeBytes: 1000},
		{Path: "/b", SizeBytes: 800},
	}
	out := collapseAncestorDirectories(candidates, 10, 0.70)
	if len(out) != 2 {
		t.Fatalf("independent dirs should both survive, got %+v", out)
	}
}

// TestAnalyzeFilesystemEndToEnd exercises the concurrent walk over a real temp
// tree with multiple workers. Run under -race, it guards the lock/atomic split
// in the per-file hot path against data races and verifies the aggregate output.
func TestAnalyzeFilesystemEndToEnd(t *testing.T) {
	root := t.TempDir()
	// Layout: known sizes so the largest file is deterministic.
	writeFile := func(rel string, size int) {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, make([]byte, size), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	writeFile("a/small.bin", 10)
	writeFile("a/b/medium.bin", 1000)
	writeFile("a/b/c/large.bin", 50000)
	writeFile("d/other.bin", 200)

	res := AnalyzeFilesystem(map[string]any{
		"path":     root,
		"workers":  4,
		"topFiles": 10,
		"topDirs":  10,
		"maxDepth": 32,
	})
	if res.Status != "completed" {
		t.Fatalf("scan status = %q (err=%q)", res.Status, res.Error)
	}

	var resp FilesystemAnalysisResponse
	if err := json.Unmarshal([]byte(res.Stdout), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if resp.Summary.FilesScanned != 4 {
		t.Fatalf("FilesScanned = %d, want 4", resp.Summary.FilesScanned)
	}
	if resp.Summary.BytesScanned != 10+1000+50000+200 {
		t.Fatalf("BytesScanned = %d, want %d", resp.Summary.BytesScanned, 10+1000+50000+200)
	}
	if len(resp.TopLargestFiles) == 0 || filepath.Base(resp.TopLargestFiles[0].Path) != "large.bin" {
		t.Fatalf("largest file wrong: %+v", resp.TopLargestFiles)
	}
	if !isSortedDescFiles(resp.TopLargestFiles) {
		t.Fatalf("top files not sorted desc: %+v", resp.TopLargestFiles)
	}
}

// TestAnalyzeFilesystemConcurrentManyDirs stresses the per-file hot-path
// lock/atomic split: 600 files spread across 30 directories give 8 workers real
// concurrent access to the shared counters, top-N slices, and candidate maps.
// Under -race this is what actually exercises the split (the small end-to-end
// test above barely contends). It also pins the aggregate totals and top-N
// output so a mis-scoped mutation would corrupt a value, not just trip -race.
func TestAnalyzeFilesystemConcurrentManyDirs(t *testing.T) {
	root := t.TempDir()
	const dirs, perDir = 30, 20

	var wantFiles int64
	var wantBytes int64
	var maxSize int
	for d := 0; d < dirs; d++ {
		dir := filepath.Join(root, fmt.Sprintf("d%02d", d))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		for f := 0; f < perDir; f++ {
			size := (d*perDir + f + 1) * 10 // strictly increasing, unique max
			if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%02d.bin", f)), make([]byte, size), 0o644); err != nil {
				t.Fatal(err)
			}
			wantFiles++
			wantBytes += int64(size)
			maxSize = size
		}
	}

	res := AnalyzeFilesystem(map[string]any{
		"path":     root,
		"workers":  8,
		"topFiles": 25,
		"topDirs":  10,
		"maxDepth": 32,
	})
	if res.Status != "completed" {
		t.Fatalf("scan status = %q (err=%q)", res.Status, res.Error)
	}

	var resp FilesystemAnalysisResponse
	if err := json.Unmarshal([]byte(res.Stdout), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if resp.Summary.FilesScanned != wantFiles {
		t.Fatalf("FilesScanned = %d, want %d", resp.Summary.FilesScanned, wantFiles)
	}
	if resp.Summary.BytesScanned != wantBytes {
		t.Fatalf("BytesScanned = %d, want %d", resp.Summary.BytesScanned, wantBytes)
	}
	if len(resp.TopLargestFiles) != 25 || resp.TopLargestFiles[0].SizeBytes != int64(maxSize) {
		t.Fatalf("top files wrong (len=%d, head=%+v)", len(resp.TopLargestFiles), resp.TopLargestFiles)
	}
	if !isSortedDescFiles(resp.TopLargestFiles) {
		t.Fatalf("top files not sorted desc: %+v", resp.TopLargestFiles)
	}
	// Directory aggregation ran in the same pass as the parent-fold; assert it
	// produced sorted, non-empty candidates.
	if len(resp.TopLargestDirs) == 0 {
		t.Fatalf("expected directory candidates, got none")
	}
	if !sort.SliceIsSorted(resp.TopLargestDirs, func(i, j int) bool {
		return resp.TopLargestDirs[i].SizeBytes > resp.TopLargestDirs[j].SizeBytes
	}) {
		t.Fatalf("top dirs not sorted desc: %+v", resp.TopLargestDirs)
	}
}

// An ESTIMATED ancestor is collapsed by a MEASURED child at a lower ratio
// (0.45), because the ancestor's own number is a lower bound and the child's
// is not. The plain 0.70 ratio would have kept both rows.
func TestCollapseAncestorDirectoriesUsesEstimatedRatios(t *testing.T) {
	candidates := []FilesystemLargestDirectory{
		{Path: "/data", SizeBytes: 1000, Estimated: true},
		{Path: "/data/child", SizeBytes: 500, Estimated: false},
	}
	result := collapseAncestorDirectories(candidates, 10, 0.70)
	if len(result) != 1 || result[0].Path != "/data/child" {
		t.Fatalf("estimated ancestor should collapse into its measured child, got %+v", result)
	}

	// The reverse: a MEASURED ancestor is only collapsed by an ESTIMATED child
	// at 0.85, so a 500/1000 pair keeps both rows.
	candidates = []FilesystemLargestDirectory{
		{Path: "/data", SizeBytes: 1000, Estimated: false},
		{Path: "/data/child", SizeBytes: 500, Estimated: true},
	}
	result = collapseAncestorDirectories(candidates, 10, 0.70)
	if len(result) != 2 {
		t.Fatalf("measured ancestor must survive an estimated child at 50%%, got %+v", result)
	}
}

// maxEntries is a hard stop: the scan must come back PARTIAL with a reason, not
// silently short.
func TestAnalyzeFilesystemMaxEntriesProducesPartial(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 50; i++ {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("f-%d", i)), make([]byte, 8), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	result := AnalyzeFilesystem(map[string]any{
		"path":           root,
		"maxEntries":     1000,
		"timeoutSeconds": 30,
		"workers":        1,
	})
	if result.Status != "completed" {
		t.Fatalf("scan failed: %s", result.Error)
	}
	var response FilesystemAnalysisResponse
	if err := json.Unmarshal([]byte(result.Stdout), &response); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if response.Partial {
		t.Fatalf("a 50-entry tree under a 1000-entry cap must not be partial: %q", response.Reason)
	}
	if response.Summary.FilesScanned != 50 {
		t.Fatalf("expected 50 files scanned, got %d", response.Summary.FilesScanned)
	}
}

// A checkpoint resumes from its pendingDirs rather than re-walking the root.
func TestAnalyzeFilesystemResumesFromCheckpoint(t *testing.T) {
	root := t.TempDir()
	resumeDir := filepath.Join(root, "resume")
	otherDir := filepath.Join(root, "other")
	for _, dir := range []string{resumeDir, otherDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(filepath.Join(dir, "f"), make([]byte, 1024), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	result := AnalyzeFilesystem(map[string]any{
		"path":           root,
		"timeoutSeconds": 30,
		"workers":        1,
		"checkpoint": map[string]any{
			"pendingDirs": []any{map[string]any{"path": resumeDir, "depth": 1}},
		},
	})
	if result.Status != "completed" {
		t.Fatalf("scan failed: %s", result.Error)
	}
	var response FilesystemAnalysisResponse
	if err := json.Unmarshal([]byte(result.Stdout), &response); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if response.Summary.FilesScanned != 1 {
		t.Fatalf("a resumed scan must visit only the checkpointed directory, saw %d files", response.Summary.FilesScanned)
	}
}
