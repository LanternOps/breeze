//go:build windows

package securefs

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// allocatedRanges is `fsutil sparse queryrange`: FSCTL_QUERY_ALLOCATED_RANGES
// over the whole file. holeRange has the same layout as
// FILE_ALLOCATED_RANGE_BUFFER (two LARGE_INTEGERs).
func allocatedRanges(t *testing.T, path string) []holeRange {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	query := holeRange{Offset: 0, Length: info.Size()}
	out := make([]holeRange, 512)
	var returned uint32
	if err := windows.DeviceIoControl(windows.Handle(f.Fd()), windows.FSCTL_QUERY_ALLOCATED_RANGES,
		(*byte)(unsafe.Pointer(&query)), uint32(unsafe.Sizeof(query)),
		(*byte)(unsafe.Pointer(&out[0])), uint32(len(out))*uint32(unsafe.Sizeof(out[0])),
		&returned, nil); err != nil {
		t.Fatalf("FSCTL_QUERY_ALLOCATED_RANGES(%s): %v", path, err)
	}
	return out[:returned/uint32(unsafe.Sizeof(out[0]))]
}

func overlaps(a, b holeRange) bool {
	return a.Offset < b.Offset+b.Length && b.Offset < a.Offset+a.Length
}

func writeBinarySource(t *testing.T, content []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "source")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// sparseCorpus is the issue's "sparse corpus file": data, a 1 MiB interior
// zero run, data, and a trailing zero run that is not a whole chunk — the
// case that needs the restore to extend the file over a hole it never wrote.
func sparseCorpus() (content []byte, holes []holeRange) {
	const k = sparseChunk
	content = bytes.Join([][]byte{
		bytes.Repeat([]byte{'a'}, k),
		make([]byte, 16*k),
		bytes.Repeat([]byte{'b'}, k),
		make([]byte, 3*k+100),
	}, nil)
	return content, []holeRange{{k, 16 * k}, {18 * k, 3*k + 100}}
}

func assertHoles(t *testing.T, path string, want []byte, holes []holeRange) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read restored file: %v", err)
	}
	if len(got) != len(want) {
		t.Fatalf("restored size = %d, want %d", len(got), len(want))
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("restored content differs from the source")
	}
	if fileAttrs(t, path)&windows.FILE_ATTRIBUTE_SPARSE_FILE == 0 {
		t.Fatalf("restored file is not sparse")
	}
	allocated := allocatedRanges(t, path)
	for _, a := range allocated {
		for _, h := range holes {
			// Only whole 64 KiB units can be released; a trailing partial
			// unit may legitimately stay allocated.
			whole := holeRange{Offset: h.Offset, Length: h.Length / sparseChunk * sparseChunk}
			if whole.Length > 0 && overlaps(a, whole) {
				t.Errorf("allocated range %v overlaps source hole %v (allocated=%v)", a, whole, allocated)
			}
		}
	}
	// The data chunks must still be allocated — a restore that released
	// everything would pass the overlap check above vacuously.
	if len(allocated) == 0 {
		t.Fatalf("no allocated ranges at all; the data chunks were lost")
	}
}

// TestInstallFileWithAttrsRecreatesSparseHoles is the regression test for
// #6446 on the primary (pinned temporary) restore path. Before the fix the
// restore set FSCTL_SET_SPARSE and then io.Copy'd every byte, so the 1 MiB
// zero run came back allocated: FSCTL_QUERY_ALLOCATED_RANGES reported the
// whole file.
func TestInstallFileWithAttrsRecreatesSparseHoles(t *testing.T) {
	content, holes := sparseCorpus()
	base := t.TempDir()
	warnings, err := InstallFileWithAttrs(base, "sparse.bin", writeBinarySource(t, content), 0o644, time.Time{}, nil, windows.FILE_ATTRIBUTE_SPARSE_FILE)
	if err != nil {
		t.Fatalf("InstallFileWithAttrs: %v", err)
	}
	if len(warnings) != 0 {
		t.Fatalf("warnings = %v, want none on NTFS", warnings)
	}
	assertHoles(t, filepath.Join(base, "sparse.bin"), content, holes)
}

// TestInstallFileWithAttrsAllZeroSparseFile: a sparse file that is entirely a
// hole is restored with its full size and nothing allocated.
func TestInstallFileWithAttrsAllZeroSparseFile(t *testing.T) {
	content := make([]byte, 4*sparseChunk+7)
	base := t.TempDir()
	warnings, err := InstallFileWithAttrs(base, "zero.bin", writeBinarySource(t, content), 0o644, time.Time{}, nil, windows.FILE_ATTRIBUTE_SPARSE_FILE)
	if err != nil || len(warnings) != 0 {
		t.Fatalf("InstallFileWithAttrs = (%v, %v), want no warnings or error", warnings, err)
	}
	path := filepath.Join(base, "zero.bin")
	info, err := os.Stat(path)
	if err != nil || info.Size() != int64(len(content)) {
		t.Fatalf("stat = (%v, %v), want size %d", info, err, len(content))
	}
	for _, a := range allocatedRanges(t, path) {
		if overlaps(a, holeRange{0, 4 * sparseChunk}) {
			t.Errorf("allocated range %v inside an all-zero sparse file", a)
		}
	}
}

// TestInstallFileWithoutSparseStaysFullyAllocated: a file the manifest did NOT
// mark sparse keeps the old byte-for-byte write — no holes, no sparse flag.
func TestInstallFileWithoutSparseStaysFullyAllocated(t *testing.T) {
	content, _ := sparseCorpus()
	base := t.TempDir()
	if _, err := InstallFileWithAttrs(base, "dense.bin", writeBinarySource(t, content), 0o644, time.Time{}, nil, 0); err != nil {
		t.Fatalf("InstallFileWithAttrs: %v", err)
	}
	path := filepath.Join(base, "dense.bin")
	if fileAttrs(t, path)&windows.FILE_ATTRIBUTE_SPARSE_FILE != 0 {
		t.Fatalf("a non-sparse manifest entry was restored sparse")
	}
	allocated := allocatedRanges(t, path)
	if len(allocated) != 1 || allocated[0] != (holeRange{0, int64(len(content))}) {
		t.Fatalf("allocated = %v, want the whole file", allocated)
	}
}

// TestApplyWinAttrsSparseKeepsRestoredMtime: BMR sets the recorded mtime
// BEFORE the attributes, so releasing the zero runs must not move it to "now".
func TestApplyWinAttrsSparseKeepsRestoredMtime(t *testing.T) {
	content, holes := sparseCorpus()
	path := filepath.Join(t.TempDir(), "bmr-mtime.bin")
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	recorded := time.Date(2023, 4, 5, 6, 7, 8, 0, time.UTC)
	if err := os.Chtimes(path, recorded, recorded); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
	if err := ApplyWinAttrs(path, windows.FILE_ATTRIBUTE_SPARSE_FILE); err != nil {
		t.Fatalf("ApplyWinAttrs: %v", err)
	}
	// Holes really were released, so this is not a vacuous no-op pass.
	assertHoles(t, path, content, holes)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if !info.ModTime().Equal(recorded) {
		t.Fatalf("mtime = %v, want the restored %v", info.ModTime().UTC(), recorded)
	}
}

// TestInstallFileWithAttrsEmptySparseFile: zero bytes in, an empty sparse
// file out, no warnings.
func TestInstallFileWithAttrsEmptySparseFile(t *testing.T) {
	base := t.TempDir()
	warnings, err := InstallFileWithAttrs(base, "empty.bin", writeBinarySource(t, nil), 0o644, time.Time{}, nil, windows.FILE_ATTRIBUTE_SPARSE_FILE)
	if err != nil || len(warnings) != 0 {
		t.Fatalf("InstallFileWithAttrs = (%v, %v), want no warnings or error", warnings, err)
	}
	info, err := os.Stat(filepath.Join(base, "empty.bin"))
	if err != nil || info.Size() != 0 {
		t.Fatalf("stat = (%v, %v), want an empty file", info, err)
	}
}

// TestApplyWinAttrsRecreatesSparseHoles covers the pathname (BMR) restore
// path, which writes the content BEFORE the attributes: setting the flag must
// also release the zero runs already written as allocated zeroes.
func TestApplyWinAttrsRecreatesSparseHoles(t *testing.T) {
	content, holes := sparseCorpus()
	path := filepath.Join(t.TempDir(), "bmr-sparse.bin")
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := ApplyWinAttrs(path, windows.FILE_ATTRIBUTE_SPARSE_FILE|windows.FILE_ATTRIBUTE_HIDDEN); err != nil {
		t.Fatalf("ApplyWinAttrs: %v", err)
	}
	assertHoles(t, path, content, holes)
	if fileAttrs(t, path)&windows.FILE_ATTRIBUTE_HIDDEN == 0 {
		t.Fatalf("HIDDEN was not applied alongside SPARSE_FILE")
	}
}
