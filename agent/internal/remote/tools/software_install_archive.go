package tools

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// zip "installs" (#6958): the archive is only extracted, into the install's
// private staging dir, for a post-install script to act on (copy a binary,
// register a service). The agent runs as SYSTEM/root and the archive comes
// from a vendor URL, so extraction is deliberately strict: anything a
// well-formed vendor release zip does not need is an error, never a skip.

// maxArchiveEntries bounds the number of entries (files and directories).
const maxArchiveEntries = 1000

// maxArchiveUncompressedBytes bounds the total bytes WRITTEN, counted while
// copying rather than read from headers (which an archive can forge). A var
// solely so tests can shrink it; moving 1 GiB through a unit test is
// impractical (the maxInstallFileSize precedent).
var maxArchiveUncompressedBytes int64 = 1 << 30

var errArchiveTooLarge = errors.New("archive exceeds the uncompressed size limit")

// extractArchive extracts the zip at zipPath into destDir, which must already
// exist. It refuses, before writing anything for that entry:
//   - absolute paths, drive letters, any ':' (also NTFS alternate data
//     streams), backslashes, '..', '.' and empty components, control
//     characters, components ending in '.' or ' ' (Windows strips them, so
//     they alias another name), and reserved Windows device names
//     (CON, NUL.txt, COM1, …) on every OS;
//   - symlinks and every other non-regular, non-directory entry;
//   - a path already extracted (case-insensitively: Windows and macOS file
//     systems fold case), so no entry ever overwrites another;
//   - more than maxArchiveEntries entries, or more than
//     maxArchiveUncompressedBytes written in total.
//
// File modes are reduced to 0755 when any exec bit is set and 0644 otherwise,
// dropping setuid, setgid and sticky. Directories are 0755. On error the
// partial extraction is left for the caller's staging cleanup.
func extractArchive(zipPath, destDir string) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("open archive: %w", err)
	}
	// Read-only handle: a close error cannot affect what was extracted.
	defer func() { _ = r.Close() }()

	if len(r.File) > maxArchiveEntries {
		return fmt.Errorf("archive has %d entries, more than the limit of %d", len(r.File), maxArchiveEntries)
	}

	root, err := filepath.Abs(destDir)
	if err != nil {
		return fmt.Errorf("resolve extraction dir: %w", err)
	}

	seen := make(map[string]struct{}, len(r.File))
	remaining := maxArchiveUncompressedBytes
	for _, f := range r.File {
		rel, isDir, err := safeArchiveEntryPath(f.Name)
		if err != nil {
			return err
		}
		key := strings.ToLower(rel)
		if _, dup := seen[key]; dup {
			return fmt.Errorf("archive entry %q appears more than once", f.Name)
		}
		seen[key] = struct{}{}

		mode := f.Mode()
		switch {
		case mode.IsDir():
			isDir = true
		case isDir:
			return fmt.Errorf("archive entry %q is named as a directory but is not one", f.Name)
		case !mode.IsRegular():
			return fmt.Errorf("archive entry %q is not a regular file or directory (%s)", f.Name, mode.Type())
		}

		target, err := archiveEntryTarget(root, rel)
		if err != nil {
			return err
		}

		if isDir {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return fmt.Errorf("create %q: %w", rel, err)
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return fmt.Errorf("create parent of %q: %w", rel, err)
		}
		perm := os.FileMode(0o644)
		if mode.Perm()&0o111 != 0 {
			perm = 0o755
		}
		written, err := extractArchiveFile(f, target, perm, remaining)
		if err != nil {
			return fmt.Errorf("extract %q: %w", rel, err)
		}
		remaining -= written
	}
	return nil
}

// archiveEntryTarget joins a validated entry path onto root (an absolute,
// clean directory) and returns the result only if it is strictly inside root.
// It is a backstop behind safeArchiveEntryPath. The positive
// strings.HasPrefix guard on the returned path is deliberate: CodeQL's
// go/zipslip query accepts it as proof of containment for every file-system
// call made with the result. A filepath.Rel check that refuses on a ".."
// prefix does not satisfy that query.
func archiveEntryTarget(root, rel string) (string, error) {
	local := filepath.FromSlash(rel)
	if filepath.IsAbs(local) || filepath.VolumeName(local) != "" {
		return "", fmt.Errorf("archive entry %q is absolute", rel)
	}
	prefix := root
	if !strings.HasSuffix(prefix, string(filepath.Separator)) {
		prefix += string(filepath.Separator)
	}
	target := filepath.Join(root, local)
	if !strings.HasPrefix(target, prefix) {
		return "", fmt.Errorf("archive entry %q escapes the extraction dir", rel)
	}
	return target, nil
}

// extractArchiveFile writes one entry with O_EXCL (never replacing an existing
// file, never following a pre-placed link), copying at most limit bytes.
func extractArchiveFile(f *zip.File, target string, perm os.FileMode, limit int64) (int64, error) {
	src, err := f.Open()
	if err != nil {
		return 0, err
	}
	// Read side; a decompression or CRC failure surfaces from io.Copy instead.
	defer func() { _ = src.Close() }()

	dst, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return 0, err
	}
	// Read one byte past the remaining budget: reaching it proves the archive
	// is over the cap without trusting any header.
	n, copyErr := io.Copy(dst, io.LimitReader(src, limit+1))
	closeErr := dst.Close()
	if copyErr != nil {
		return n, copyErr
	}
	if n > limit {
		return n, errArchiveTooLarge
	}
	if closeErr != nil {
		return n, closeErr
	}
	// OpenFile's perm is filtered by the umask; set it exactly.
	if err := os.Chmod(target, perm); err != nil {
		return n, err
	}
	return n, nil
}

// safeArchiveEntryPath validates a zip entry name and returns it as a clean,
// slash-separated relative path, plus whether the name denotes a directory
// (trailing '/').
func safeArchiveEntryPath(name string) (string, bool, error) {
	refuse := func(why string) (string, bool, error) {
		return "", false, fmt.Errorf("archive entry %q refused: %s", name, why)
	}
	if name == "" {
		return refuse("empty name")
	}
	if strings.ContainsAny(name, `\:`) {
		return refuse(`contains '\' or ':' (drive, alternate data stream, or non-portable separator)`)
	}
	if strings.HasPrefix(name, "/") {
		return refuse("absolute path")
	}
	isDir := strings.HasSuffix(name, "/")
	trimmed := strings.TrimSuffix(name, "/")
	if trimmed == "" {
		return refuse("empty name")
	}
	for _, part := range strings.Split(trimmed, "/") {
		switch {
		case part == "" || part == "." || part == "..":
			return refuse("empty, '.' or '..' path component")
		case strings.HasSuffix(part, ".") || strings.HasSuffix(part, " "):
			return refuse("path component ends in '.' or ' '")
		case strings.IndexFunc(part, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0:
			return refuse("control character")
		case isReservedWindowsName(part):
			return refuse("reserved Windows device name")
		}
	}
	return trimmed, isDir, nil
}

// isReservedWindowsName reports whether a path component names a DOS device
// (CON, PRN, AUX, NUL, COM0-9, LPT0-9, incl. the superscript-digit forms, and
// CONIN$/CONOUT$), with or without an extension, in any case.
func isReservedWindowsName(part string) bool {
	base := part
	if i := strings.IndexByte(base, '.'); i >= 0 {
		base = base[:i]
	}
	base = strings.ToUpper(strings.TrimRight(base, " "))
	switch base {
	case "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$":
		return true
	}
	if len(base) >= 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) {
		switch base[3:] {
		case "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "\u00b9", "\u00b2", "\u00b3":
			return true
		}
	}
	return false
}
