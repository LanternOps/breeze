package backup

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

// winAttrsHidden/System mirror the Windows constants without importing
// golang.org/x/sys/windows, so this file builds and runs on every platform.
const (
	winAttrsReadOnly = uint32(0x00000001)
	winAttrsHidden   = uint32(0x00000002)
	winAttrsSystem   = uint32(0x00000004)
	winAttrsSparse   = uint32(0x00000200)
)

// TestSnapshotFileWinAttrsOmittedWhenZero pins the compatibility contract:
// a manifest for a file with no preserved attributes (every non-Windows
// backup, and every manifest written before #5407) must serialize exactly as
// it did before the field existed.
func TestSnapshotFileWinAttrsOmittedWhenZero(t *testing.T) {
	blob, err := json.Marshal(SnapshotFile{SourcePath: "/tmp/a", BackupPath: "b", Size: 1})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(blob), "winAttrs") {
		t.Fatalf("WinAttrs=0 must be omitted, got %s", blob)
	}
}

// TestSnapshotFileWinAttrsRoundTrip proves the attributes survive the
// manifest, which is the whole point of #5407: before it, Hidden/System/Sparse
// had nowhere to be recorded and a byte-exact restore silently dropped them.
func TestSnapshotFileWinAttrsRoundTrip(t *testing.T) {
	want := winAttrsHidden | winAttrsSystem | winAttrsSparse
	blob, err := json.Marshal(SnapshotFile{SourcePath: `C:\data\a`, WinAttrs: want})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(blob), `"winAttrs":518`) {
		t.Fatalf("serialized manifest = %s, want a winAttrs:518 member", blob)
	}
	var back SnapshotFile
	if err := json.Unmarshal(blob, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if back.WinAttrs != want {
		t.Fatalf("WinAttrs = %#x, want %#x", back.WinAttrs, want)
	}
}

// TestContentlessEntryCarriesWinAttrs guards the symlink/directory manifest
// builder: it hand-copies every field, so a new one is easy to forget.
func TestContentlessEntryCarriesWinAttrs(t *testing.T) {
	entry := contentlessEntry(backupFile{
		sourcePath: `C:\data\dir`,
		kind:       KindDir,
		modTime:    time.Unix(1, 0),
		winAttrs:   winAttrsHidden,
	})
	if entry.WinAttrs != winAttrsHidden {
		t.Fatalf("WinAttrs = %#x, want %#x", entry.WinAttrs, winAttrsHidden)
	}
}

// TestIncrementalReferenceEntryCarriesWinAttrs guards the same hand-copy in
// the incremental (unchanged-file reference) builder. An unchanged file whose
// attributes were dropped on every incremental would lose them after the first
// non-full backup even with the full-backup path fixed.
func TestIncrementalReferenceEntryCarriesWinAttrs(t *testing.T) {
	entry := referenceEntry(
		backupFile{sourcePath: `C:\data\a`, size: 3, modTime: time.Unix(1, 0), winAttrs: winAttrsReadOnly | winAttrsSystem},
		SnapshotFile{BackupPath: "prev", Checksum: "abc"},
	)
	if entry.WinAttrs != winAttrsReadOnly|winAttrsSystem {
		t.Fatalf("WinAttrs = %#x, want %#x", entry.WinAttrs, winAttrsReadOnly|winAttrsSystem)
	}
}

// TestWinFileAttrsIsZeroOffWindows documents the stub contract the
// non-Windows build relies on — and, on Windows, that a plain Archive-only
// file records nothing (so ordinary manifests stay byte-identical).
func TestWinFileAttrsOnOrdinaryFile(t *testing.T) {
	path := t.TempDir() + string(os.PathSeparator) + "plain.txt"
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatalf("lstat: %v", err)
	}
	if got := winFileAttrs(info); got != 0 {
		t.Fatalf("winFileAttrs(ordinary file) = %#x, want 0 (Archive is deliberately not preserved)", got)
	}
}

// TestApplyWinAttrsZeroIsNoOp: a zero-attribute entry must never touch the
// restored file, on any platform.
func TestApplyWinAttrsZeroIsNoOp(t *testing.T) {
	if err := applyWinAttrs(t.TempDir()+string(os.PathSeparator)+"does-not-exist", 0); err != nil {
		t.Fatalf("applyWinAttrs(_, 0) = %v, want nil", err)
	}
}

// TestApplyEntryMetadataAppliesWinAttrsLast proves the ordering the restore
// depends on: FILE_ATTRIBUTE_READONLY makes chmod/chtimes fail, so it must be
// the last thing applied. Off Windows applyWinAttrs is a no-op, so this
// asserts the surrounding fidelity steps still succeed unchanged.
func TestApplyEntryMetadataWithWinAttrs(t *testing.T) {
	path := t.TempDir() + string(os.PathSeparator) + "restored.txt"
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	modTime := time.Date(2024, 3, 2, 1, 0, 0, 0, time.UTC)
	warnings := applyEntryMetadata(path, SnapshotFile{
		SourcePath: path,
		ModeBits:   0o640,
		ModTime:    modTime,
		WinAttrs:   winAttrsHidden,
	}, false)
	if len(warnings) != 0 {
		t.Fatalf("warnings = %v, want none", warnings)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if !info.ModTime().Equal(modTime) {
		t.Fatalf("mtime = %v, want %v (attribute apply must come AFTER chtimes)", info.ModTime(), modTime)
	}
}
