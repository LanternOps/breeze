package bmr

import (
	"context"
	"errors"
	"path"
	"path/filepath"
	"strings"
	"testing"
)

// #7050: operator-facing BMR messages about a VSS-backed entry must name the
// real path (OriginalPath), never the per-run shadow-copy device path VSS
// rewrote SourcePath to.
const vssShadowSource = `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy7\data\report.docx`

func TestRestoreFilesDownloadFailureNamesOriginalPath(t *testing.T) {
	origPath := filepath.Join(t.TempDir(), "report.docx")
	provider := &breakerFakeProvider{
		downloadErr: func(int) error { return errors.New("object missing") },
	}
	manifest := &snapshotManifest{ID: "snap-vss", Size: 10, Files: []manifestFile{{
		SourcePath:   vssShadowSource,
		OriginalPath: origPath,
		BackupPath:   path.Join("snapshots", "snap-vss", "files", "report.docx.gz"),
		Size:         10,
	}}}

	_, _, warnings, failedFiles, _ := restoreFiles(context.Background(), manifest, RecoveryConfig{}, provider)
	if failedFiles != 1 || len(warnings) == 0 {
		t.Fatalf("failedFiles=%d warnings=%v, want one download failure", failedFiles, warnings)
	}
	joined := strings.Join(warnings, "\n")
	if strings.Contains(joined, "HarddiskVolumeShadowCopy") {
		t.Fatalf("warnings name the VSS shadow-copy path: %q", joined)
	}
	if !strings.Contains(joined, origPath) {
		t.Fatalf("warnings %q do not name the original path %q", joined, origPath)
	}
}

func TestRestoreContentlessEntryErrorNamesOriginalPath(t *testing.T) {
	err := restoreContentlessEntry(filepath.Join(t.TempDir(), "report.docx"), manifestFile{
		SourcePath:   vssShadowSource,
		OriginalPath: `C:\data\report.docx`,
		BackupPath:   "files/report.docx",
	})
	if err == nil {
		t.Fatal("expected an error for a content entry")
	}
	if strings.Contains(err.Error(), "HarddiskVolumeShadowCopy") {
		t.Fatalf("error %q names the VSS shadow-copy path", err)
	}
	if !strings.Contains(err.Error(), `C:\data\report.docx`) {
		t.Fatalf("error %q does not name the original path", err)
	}
}
