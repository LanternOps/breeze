//go:build windows

package securefs

import (
	"fmt"
	"io"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// copySparse fills the EMPTY, already-sparse temporary from src without
// allocating its zero runs (#6446). Zero chunks are skipped rather than
// written, the file is extended to its full logical size (a trailing hole was
// never written), and each hole is then released explicitly with
// FSCTL_SET_ZERO_DATA so the outcome does not depend on how the filesystem
// treats a skipped range.
//
// A copy or size failure is a hard error: the content would be wrong. A
// failure to release a hole is only a fidelity warning — the skipped range
// already reads back as zero, so the bytes are right and the file is merely
// more allocated than the source.
func copySparse(temp *os.File, handle windows.Handle, src io.Reader) (warning, err error) {
	size, holes, err := planSparseCopy(temp, src, sparseChunk)
	if err != nil {
		return nil, err
	}
	if err := temp.Truncate(size); err != nil {
		return nil, fmt.Errorf("set restored file size: %w", err)
	}
	if err := zeroDataRanges(handle, holes); err != nil {
		return fmt.Errorf("recreate sparse holes: %w", err), nil
	}
	return nil, nil
}

// zeroDataRanges releases each hole of handle's sparse file. On a sparse file
// FSCTL_SET_ZERO_DATA deallocates every whole allocation unit in the range and
// zeroes any partial one; on a file that is not sparse it would write zeroes
// instead, so callers only use it after FSCTL_SET_SPARSE succeeded.
func zeroDataRanges(handle windows.Handle, holes []holeRange) error {
	for _, hole := range holes {
		info := windows.FileZeroDataInformation{
			FileOffset:      hole.Offset,
			BeyondFinalZero: hole.Offset + hole.Length,
		}
		var returned uint32
		if err := windows.DeviceIoControl(handle, windows.FSCTL_SET_ZERO_DATA,
			(*byte)(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)),
			nil, 0, &returned, nil); err != nil {
			return fmt.Errorf("release range [%d, %d): %w", hole.Offset, hole.Offset+hole.Length, err)
		}
	}
	return nil
}

// punchHolesByPath recreates the holes of an ALREADY-WRITTEN sparse file, for
// the pathname-based restore paths (BMR) that publish content first and apply
// attributes afterwards. It scans the file and releases its all-zero chunks.
//
// Safety rests on scanning and releasing through ONE handle that denies other
// writers (share mode FILE_SHARE_READ only): only ranges that this handle has
// just read as zero are released, and nobody can write them in between, so the
// file's bytes cannot change — even if the pathname were redirected, the only
// effect on whatever file it reached would be deallocation of zeroes.
// Directories are skipped: they carry no data stream to scan.
func punchHolesByPath(p *uint16) error {
	// Skip a directory before the writer-excluding open below, which would
	// otherwise fail on any directory something else holds open — and a
	// directory's attribute error is a hard restore error (restore.go).
	if attrs, err := windows.GetFileAttributes(p); err == nil && attrs&windows.FILE_ATTRIBUTE_DIRECTORY != 0 {
		return nil
	}
	handle, err := windows.CreateFile(p, windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return err
	}
	defer func() { _ = windows.CloseHandle(handle) }()
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0 {
		return nil
	}
	_, holes, err := planSparseCopy(nil, handleReader{handle}, sparseChunk)
	if err != nil {
		return fmt.Errorf("scan for zero ranges: %w", err)
	}
	return zeroDataRanges(handle, holes)
}

// handleReader reads sequentially from a raw handle without handing its
// ownership to an *os.File (whose finalizer would close it).
type handleReader struct{ handle windows.Handle }

func (r handleReader) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	var n uint32
	if err := windows.ReadFile(r.handle, p, &n, nil); err != nil {
		return int(n), err
	}
	if n == 0 {
		return 0, io.EOF
	}
	return int(n), nil
}
