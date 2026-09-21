package bmr

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// TestManifestFileDecodesWinAttrs is the dual-struct guard. bmr deliberately
// mirrors backup.SnapshotFile rather than importing it, so a field added on
// one side and forgotten on the other is silently dropped on decode — exactly
// how mode/modTime were once lost (O20), and how Hidden/System/Sparse would be
// lost again if manifestFile had no winAttrs member (#5407).
func TestManifestFileDecodesWinAttrs(t *testing.T) {
	var file manifestFile
	if err := json.Unmarshal([]byte(`{"sourcePath":"C:\\d\\a","winAttrs":518}`), &file); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if file.WinAttrs != 518 {
		t.Fatalf("WinAttrs = %d, want 518 (Hidden|System|SparseFile)", file.WinAttrs)
	}
}

// TestRestoreFiles_AppliesWinAttrsAfterModeAndMtime proves the restore
// actually reaches for the captured attributes, and does so LAST: once
// FILE_ATTRIBUTE_READONLY is set, the chmod/chtimes above it would fail.
func TestRestoreFiles_AppliesWinAttrsAfterModeAndMtime(t *testing.T) {
	provider, manifest := seedWinAttrsManifest(t, 0x0002|0x0004)

	var order []string
	var gotPath string
	var gotAttrs uint32
	origChmod, origChtimes, origAttrs := chmodFile, chtimesFile, applyWinAttrsFile
	chmodFile = func(string, os.FileMode) error { order = append(order, "chmod"); return nil }
	chtimesFile = func(string, time.Time, time.Time) error { order = append(order, "chtimes"); return nil }
	applyWinAttrsFile = func(p string, attrs uint32) error {
		order = append(order, "winattrs")
		gotPath, gotAttrs = p, attrs
		return nil
	}
	defer func() { chmodFile, chtimesFile, applyWinAttrsFile = origChmod, origChtimes, origAttrs }()

	restored, _, warnings, failed, err := restoreFiles(context.Background(), manifest, RecoveryConfig{}, provider)
	if err != nil || restored != 1 || failed != 0 {
		t.Fatalf("restoreFiles = (%d restored, %d failed, %v), warnings %v", restored, failed, err, warnings)
	}
	if len(warnings) != 0 {
		t.Fatalf("warnings = %v, want none", warnings)
	}
	if gotAttrs != 0x0002|0x0004 {
		t.Fatalf("applyWinAttrsFile got attrs %#x, want %#x (the manifest's captured value)", gotAttrs, 0x0002|0x0004)
	}
	if gotPath != manifest.Files[0].SourcePath {
		t.Fatalf("applyWinAttrsFile got path %q, want %q", gotPath, manifest.Files[0].SourcePath)
	}
	if want := []string{"chmod", "chtimes", "winattrs"}; strings.Join(order, ",") != strings.Join(want, ",") {
		t.Fatalf("apply order = %v, want %v (ReadOnly must not be set before chmod/chtimes run)", order, want)
	}
}

// TestRestoreFiles_WinAttrsFailureWarnsButDoesNotFailTheFile: a filesystem
// that cannot carry the attributes (FAT32, a network redirector) must degrade
// to a warning, never to a failed restore of good bytes.
func TestRestoreFiles_WinAttrsFailureWarnsButDoesNotFailTheFile(t *testing.T) {
	provider, manifest := seedWinAttrsManifest(t, 0x0200)

	origAttrs := applyWinAttrsFile
	applyWinAttrsFile = func(string, uint32) error { return errors.New("injected attribute failure") }
	defer func() { applyWinAttrsFile = origAttrs }()

	restored, _, warnings, failed, err := restoreFiles(context.Background(), manifest, RecoveryConfig{}, provider)
	if err != nil {
		t.Fatalf("restoreFiles: %v", err)
	}
	if restored != 1 || failed != 0 {
		t.Fatalf("restored=%d failed=%d, want 1/0 — bytes were fine, only the attribute reapply failed", restored, failed)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "could not reapply windows attributes") {
		t.Fatalf("warnings = %v, want exactly one windows-attribute warning", warnings)
	}
}

// TestRestoreFiles_ZeroWinAttrsStillCallsTheSeamHarmlessly documents that a
// pre-#5407 manifest (winAttrs absent → 0) restores exactly as before: the
// seam is a no-op for 0 and produces no warning.
func TestRestoreFiles_ZeroWinAttrsProducesNoWarning(t *testing.T) {
	provider, manifest := seedWinAttrsManifest(t, 0)

	_, _, warnings, failed, err := restoreFiles(context.Background(), manifest, RecoveryConfig{}, provider)
	if err != nil || failed != 0 || len(warnings) != 0 {
		t.Fatalf("restoreFiles = (%d failed, %v), warnings %v — want a clean, unchanged restore", failed, err, warnings)
	}
}

func seedWinAttrsManifest(t *testing.T, attrs uint32) (*providers.LocalProvider, *snapshotManifest) {
	t.Helper()
	provider := providers.NewLocalProvider(t.TempDir())
	snapshotID := "bmr-winattrs"
	backupPath := filepath.ToSlash(path.Join("snapshots", snapshotID, "files", "x.gz"))

	content := []byte("winattrs-content")
	srcPath := filepath.Join(t.TempDir(), "x")
	if err := os.WriteFile(srcPath, content, 0o644); err != nil {
		t.Fatalf("write source: %v", err)
	}
	if err := provider.Upload(srcPath, backupPath); err != nil {
		t.Fatalf("upload: %v", err)
	}

	targetPath := filepath.Join(t.TempDir(), "x")
	return provider, &snapshotManifest{
		ID: snapshotID,
		Files: []manifestFile{{
			SourcePath: targetPath,
			BackupPath: backupPath,
			Size:       int64(len(content)),
			Mode:       0o644,
			ModTime:    time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC),
			WinAttrs:   attrs,
		}},
		Size: int64(len(content)),
	}
}

// TestRestoreContentlessEntryDirAppliesWinAttrs is the bmr half of the same
// review finding: its independent "dir" branch must reapply the manifest's
// captured attributes too, after the chmod (ReadOnly would block it).
func TestRestoreContentlessEntryDirAppliesWinAttrs(t *testing.T) {
	target := filepath.Join(t.TempDir(), "hidden-dir")

	var order []string
	var gotPath string
	var gotAttrs uint32
	origChmod, origAttrs := chmodFile, applyWinAttrsFile
	chmodFile = func(string, os.FileMode) error { order = append(order, "chmod"); return nil }
	applyWinAttrsFile = func(p string, a uint32) error {
		order = append(order, "winattrs")
		gotPath, gotAttrs = p, a
		return nil
	}
	defer func() { chmodFile, applyWinAttrsFile = origChmod, origAttrs }()

	if err := restoreContentlessEntry(target, manifestFile{
		SourcePath: target,
		Kind:       "dir",
		ModeBits:   0o750,
		WinAttrs:   0x0002 | 0x0004,
	}); err != nil {
		t.Fatalf("restoreContentlessEntry: %v", err)
	}
	if gotAttrs != 0x0002|0x0004 {
		t.Fatalf("applyWinAttrsFile got %#x, want %#x", gotAttrs, 0x0002|0x0004)
	}
	if gotPath != target {
		t.Fatalf("applyWinAttrsFile got path %q, want %q", gotPath, target)
	}
	if strings.Join(order, ",") != "chmod,winattrs" {
		t.Fatalf("order = %v, want chmod then winattrs", order)
	}
}
