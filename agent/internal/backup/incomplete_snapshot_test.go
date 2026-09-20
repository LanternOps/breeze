package backup

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// writeIncompleteSnapshot stores one good object plus a manifest that declares
// `incompleteFiles` missing entries, i.e. exactly the shape #6350 produced: the
// files that failed to upload are ABSENT from Files, so every entry the
// verifier walks is present and intact.
func writeIncompleteSnapshot(t *testing.T, basePath, snapshotID string, incomplete int, incompletePaths []string) {
	t.Helper()
	prefix := path.Join("snapshots", snapshotID)

	srcDir := t.TempDir()
	srcFile := filepath.Join(srcDir, "small.txt")
	if err := os.WriteFile(srcFile, []byte("hello world"), 0o644); err != nil {
		t.Fatal(err)
	}
	provider := providers.NewLocalProvider(basePath)
	backupPath := path.Join(prefix, "files", "small.txt.gz")
	if err := provider.Upload(srcFile, backupPath); err != nil {
		t.Fatal(err)
	}

	manifest := Snapshot{
		ID:                  snapshotID,
		Files:               []SnapshotFile{{SourcePath: srcFile, BackupPath: backupPath, Size: 11}},
		Size:                11,
		IncompleteFiles:     incomplete,
		IncompleteFilePaths: incompletePaths,
	}
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(basePath, prefix, "manifest.json")
	if err := os.MkdirAll(filepath.Dir(manifestPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manifestPath, manifestBytes, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyIntegrity_IncompleteSnapshotNeverPasses(t *testing.T) {
	cases := []struct {
		name            string
		incomplete      int
		incompletePaths []string
		wantStatus      string
		wantIncomplete  int
		wantWarningPart string
	}{
		{
			name:       "complete snapshot still passes",
			incomplete: 0,
			wantStatus: "passed",
		},
		{
			name:            "one missing file downgrades to partial",
			incomplete:      1,
			incompletePaths: []string{`C:\data\big.bin`},
			wantStatus:      "partial",
			wantIncomplete:  1,
			wantWarningPart: `C:\data\big.bin`,
		},
		{
			name:            "count without recorded paths still downgrades",
			incomplete:      3,
			wantStatus:      "partial",
			wantIncomplete:  3,
			wantWarningPart: "3 file(s) never uploaded",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			basePath := t.TempDir()
			snapshotID := "snapshot-incomplete"
			writeIncompleteSnapshot(t, basePath, snapshotID, tc.incomplete, tc.incompletePaths)

			result, err := VerifyIntegrity(providers.NewLocalProvider(basePath), snapshotID)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if result.Status != tc.wantStatus {
				t.Errorf("status = %q, want %q (error: %s)", result.Status, tc.wantStatus, result.Error)
			}
			if result.FilesIncomplete != tc.wantIncomplete {
				t.Errorf("FilesIncomplete = %d, want %d", result.FilesIncomplete, tc.wantIncomplete)
			}
			// The stored object itself is fine, so the verification failure
			// count must stay 0 — the whole point is that a zero here used to
			// be read as "nothing is missing".
			if result.FilesFailed != 0 {
				t.Errorf("FilesFailed = %d, want 0", result.FilesFailed)
			}
			if result.FilesVerified != 1 {
				t.Errorf("FilesVerified = %d, want 1", result.FilesVerified)
			}
			if tc.wantWarningPart == "" {
				if len(result.Warnings) != 0 {
					t.Errorf("unexpected warnings: %v", result.Warnings)
				}
				return
			}
			if !strings.Contains(strings.Join(result.Warnings, " | "), tc.wantWarningPart) {
				t.Errorf("warnings %v do not mention %q", result.Warnings, tc.wantWarningPart)
			}
		})
	}
}

func TestTestRestore_IncompleteSnapshotNeverPasses(t *testing.T) {
	basePath := t.TempDir()
	snapshotID := "snapshot-incomplete"
	writeIncompleteSnapshot(t, basePath, snapshotID, 2, []string{"/srv/data/one.bin"})

	result, err := TestRestore(providers.NewLocalProvider(basePath), snapshotID, t.TempDir(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "partial" {
		t.Errorf("status = %q, want partial", result.Status)
	}
	if !strings.Contains(strings.Join(result.Warnings, " | "), "/srv/data/one.bin") {
		t.Errorf("warnings %v do not name the missing file", result.Warnings)
	}
}

func TestRecordIncompleteFiles(t *testing.T) {
	manyErrs := make([]error, 0, maxManifestIncompletePaths+25)
	manyPaths := make([]string, 0, maxManifestIncompletePaths+25)
	for i := 0; i < maxManifestIncompletePaths+25; i++ {
		manyErrs = append(manyErrs, fmt.Errorf("failed to upload f%d", i))
		manyPaths = append(manyPaths, fmt.Sprintf("/data/f%d", i))
	}

	cases := []struct {
		name      string
		failures  []error
		sources   []string
		wantCount int
		wantPaths int
	}{
		{name: "no failures leaves the manifest clean"},
		{
			name:      "failures are counted and named",
			failures:  []error{errors.New("a"), errors.New("b")},
			sources:   []string{"/data/a", "/data/b"},
			wantCount: 2,
			wantPaths: 2,
		},
		{
			// A failure with no recorded source path must still be counted —
			// under-reporting the count is the bug this field exists to stop.
			name:      "count comes from failures not from paths",
			failures:  []error{errors.New("a"), errors.New("b"), errors.New("c")},
			sources:   []string{"/data/a"},
			wantCount: 3,
			wantPaths: 1,
		},
		{
			name:      "paths are capped but the count is exact",
			failures:  manyErrs,
			sources:   manyPaths,
			wantCount: len(manyErrs),
			wantPaths: maxManifestIncompletePaths,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			snap := &Snapshot{ID: "s"}
			recordIncompleteFiles(snap, tc.failures, tc.sources)
			if snap.IncompleteFiles != tc.wantCount {
				t.Errorf("IncompleteFiles = %d, want %d", snap.IncompleteFiles, tc.wantCount)
			}
			if len(snap.IncompleteFilePaths) != tc.wantPaths {
				t.Errorf("len(IncompleteFilePaths) = %d, want %d", len(snap.IncompleteFilePaths), tc.wantPaths)
			}

			data, err := json.Marshal(snap)
			if err != nil {
				t.Fatal(err)
			}
			hasField := strings.Contains(string(data), `"incompleteFiles"`)
			if hasField != (tc.wantCount > 0) {
				t.Errorf("manifest incompleteFiles presence = %v, want %v: %s", hasField, tc.wantCount > 0, data)
			}
		})
	}
}
