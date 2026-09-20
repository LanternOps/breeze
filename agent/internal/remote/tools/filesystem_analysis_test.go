package tools

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestReadCheckpointFramesCapsEntries(t *testing.T) {
	pending := make([]any, 0, maxFSCheckpointDirs+10)
	for i := 0; i < maxFSCheckpointDirs+10; i++ {
		pending = append(pending, map[string]any{
			"path":  "/tmp/test",
			"depth": 1,
		})
	}

	frames := readCheckpointFrames(map[string]any{
		"pendingDirs": pending,
	})

	if len(frames) != maxFSCheckpointDirs {
		t.Fatalf("expected %d frames, got %d", maxFSCheckpointDirs, len(frames))
	}
}

func TestReadTargetDirectoriesCapsEntries(t *testing.T) {
	raw := make([]any, 0, maxFSTargetDirectories+10)
	for i := 0; i < maxFSTargetDirectories+10; i++ {
		raw = append(raw, fmt.Sprintf("/tmp/test-%d", i))
	}

	dirs := readTargetDirectories(raw)
	if len(dirs) > maxFSTargetDirectories {
		t.Fatalf("expected at most %d target dirs, got %d", maxFSTargetDirectories, len(dirs))
	}
}

// Defect 7a: the duplicate map was unbounded. A 10M-file scan with mostly
// distinct basenames grew one entry per file.
func TestAddDuplicateCandidateIsBounded(t *testing.T) {
	groups := map[string]*duplicateGroup{}
	for i := 0; i < maxFSDuplicateGroups; i++ {
		if dropped := addDuplicateCandidate(groups, fmt.Sprintf("/data/file-%d.bin", i), int64(i+1)); dropped {
			t.Fatalf("unexpected drop at i=%d (below the cap)", i)
		}
	}
	if len(groups) != maxFSDuplicateGroups {
		t.Fatalf("expected %d groups, got %d", maxFSDuplicateGroups, len(groups))
	}
	if dropped := addDuplicateCandidate(groups, "/data/one-too-many.bin", 999); !dropped {
		t.Fatal("expected a NEW key past the cap to be dropped and reported")
	}
	if len(groups) != maxFSDuplicateGroups {
		t.Fatalf("cap breached: %d groups", len(groups))
	}
	// An EXISTING key must still accumulate — the cap bounds keys, not members.
	if dropped := addDuplicateCandidate(groups, "/other/file-1.bin", 2); dropped {
		t.Fatal("an existing key must not be reported as dropped")
	}
}

// Defect 7b: the candidate cap was insertion-ordered, so a late 40 GB candidate
// could not displace an early 1 KB one while the UI advertised "biggest wins".
func TestCleanupCandidateSetKeepsTopBySize(t *testing.T) {
	set := newCleanupCandidateSet(3)
	for i := 1; i <= 3; i++ {
		set.Add(FilesystemCleanupCandidate{Path: fmt.Sprintf("/tmp/small-%d", i), Category: "temp_files", SizeBytes: int64(i)})
	}
	set.Add(FilesystemCleanupCandidate{Path: "/tmp/huge", Category: "temp_files", SizeBytes: 40 << 30})

	sorted := set.Sorted()
	if len(sorted) != 3 {
		t.Fatalf("expected the limit to hold at 3, got %d", len(sorted))
	}
	if sorted[0].Path != "/tmp/huge" {
		t.Fatalf("largest candidate was evicted or not admitted: %+v", sorted)
	}
	for _, candidate := range sorted {
		if candidate.Path == "/tmp/small-1" {
			t.Fatal("the smallest candidate should have been evicted")
		}
	}
	// Descending by size.
	for i := 1; i < len(sorted); i++ {
		if sorted[i-1].SizeBytes < sorted[i].SizeBytes {
			t.Fatalf("Sorted() is not descending: %+v", sorted)
		}
	}
}

func TestCleanupCandidateSetDedupesByPathKeepingLargest(t *testing.T) {
	set := newCleanupCandidateSet(10)
	set.Add(FilesystemCleanupCandidate{Path: "/tmp/a", Category: "temp_files", SizeBytes: 10})
	set.Add(FilesystemCleanupCandidate{Path: "/tmp/a", Category: "temp_files", SizeBytes: 99})
	set.Add(FilesystemCleanupCandidate{Path: "/tmp/a", Category: "temp_files", SizeBytes: 5})
	set.Add(FilesystemCleanupCandidate{Path: "", Category: "temp_files", SizeBytes: 5})
	set.Add(FilesystemCleanupCandidate{Path: "/tmp/b", Category: "temp_files", SizeBytes: 0})

	sorted := set.Sorted()
	if len(sorted) != 1 || sorted[0].SizeBytes != 99 {
		t.Fatalf("expected one /tmp/a at 99 bytes, got %+v", sorted)
	}
}

// Replaces the []map[string]any assertion, which asserted the Go value shape
// rather than the JSON the API actually receives.
func TestBuildCheckpointPayloadRoundTripsThroughJSON(t *testing.T) {
	frames := []scanDirFrame{
		{path: "/tmp/one", depth: 1},
		{path: "/tmp/two", depth: 2},
		{path: "/tmp/three", depth: 3},
	}
	raw, err := json.Marshal(buildCheckpointPayload(frames, 2))
	if err != nil {
		t.Fatalf("marshal checkpoint payload: %v", err)
	}
	var decoded struct {
		PendingDirs []struct {
			Path  string `json:"path"`
			Depth int    `json:"depth"`
		} `json:"pendingDirs"`
		Truncated      bool `json:"truncated"`
		RemainingCount int  `json:"remainingCount"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal checkpoint payload: %v", err)
	}
	if len(decoded.PendingDirs) != 2 {
		t.Fatalf("expected 2 pending dirs, got %d", len(decoded.PendingDirs))
	}
	if decoded.PendingDirs[0].Path != "/tmp/one" || decoded.PendingDirs[0].Depth != 1 {
		t.Fatalf("first pending dir round-tripped wrong: %+v", decoded.PendingDirs[0])
	}
	if !decoded.Truncated || decoded.RemainingCount != 3 {
		t.Fatalf("truncation metadata lost: truncated=%v remaining=%d", decoded.Truncated, decoded.RemainingCount)
	}
}

func TestIsUnrotatedLog(t *testing.T) {
	if !isUnrotatedLog("/var/log/app.log", unrotatedLogMinBytes) {
		t.Error("a .log at the threshold should count")
	}
	if isUnrotatedLog("/var/log/app.log", unrotatedLogMinBytes-1) {
		t.Error("below the threshold should not count")
	}
	if isUnrotatedLog("/var/log/app.log.1", unrotatedLogMinBytes) {
		t.Error("a rotated file is not an unrotated log")
	}
	if isUnrotatedLog("/var/log/app.txt", unrotatedLogMinBytes) {
		t.Error("only .log qualifies")
	}
}

func TestIsOldDownloadIgnoresRuleTableClaims(t *testing.T) {
	threshold := time.Now().Add(-30 * 24 * time.Hour)
	old := threshold.Add(-24 * time.Hour)
	if !isOldDownload("/home/bob/Downloads/installer.iso", 1<<30, old, threshold) {
		t.Error("an aged user download should count")
	}
	if isOldDownload("/home/bob/Downloads/installer.iso", 1<<30, time.Now(), threshold) {
		t.Error("a fresh download should not count")
	}
	claimedPath := "/home/bob/.cache/pip/http/Downloads/blob"
	switch runtime.GOOS {
	case "darwin":
		claimedPath = "/Users/bob/.cache/pip/http/Downloads/blob"
	case "windows":
		claimedPath = "C:/Users/bob/AppData/Local/pip/cache/Downloads/blob"
	}
	if isOldDownload(claimedPath, 1<<30, old, threshold) {
		t.Error("a path a cleanup rule already claims must not double-report as an old download")
	}
	if isOldDownload("/srv/Downloads/x.iso", 1<<30, old, threshold) {
		t.Error("only user download roots count")
	}
}

func TestEstimateDirectorySizeCountsPermissionDenials(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX mode bits")
	}
	if os.Geteuid() == 0 {
		t.Skip("root ignores the mode bits this test relies on")
	}
	root := t.TempDir()
	locked := filepath.Join(root, "locked")
	if err := os.MkdirAll(locked, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(locked, "x"), make([]byte, 16), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := os.Chmod(locked, 0o000); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o700) })

	var permissionDenied int64
	if _, _, _, err := estimateDirectorySize(root, time.Now().Add(time.Minute), 1000, &permissionDenied); err != nil {
		t.Fatalf("estimateDirectorySize: %v", err)
	}
	if permissionDenied == 0 {
		t.Fatal("a permission-denied directory must be counted, not silently skipped")
	}
}
