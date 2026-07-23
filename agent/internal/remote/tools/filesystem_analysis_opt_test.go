package tools

import (
	"encoding/json"
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
