//go:build darwin

package tools

import (
	"encoding/binary"
	"io"
	"io/fs"
	"os"

	"golang.org/x/sys/unix"
)

const (
	// finderInfoAttr holds the 32-byte Carbon FileInfo/FolderInfo record.
	finderInfoAttr = "com.apple.FinderInfo"
	// finderFlagIsAlias is kIsAlias, bit 15 of the big-endian uint16 Finder
	// flags field at offset 8 of that record. Finder itself uses this bit to
	// decide whether a file is an alias, so it is the authoritative test.
	finderFlagIsAlias = 0x8000

	// maxAliasResolveHops bounds an alias→alias chain.
	maxAliasResolveHops = 8
)

// hasFinderAliasFlag reports whether path carries the Finder kIsAlias flag.
// This is a single getxattr with no open(2), which keeps the per-entry cost of
// checking a large directory listing negligible: virtually no file on a modern
// macOS system has a com.apple.FinderInfo xattr at all, so the common case is
// one failing syscall.
func hasFinderAliasFlag(path string) bool {
	var buf [32]byte
	n, err := unix.Getxattr(path, finderInfoAttr, buf[:])
	if err != nil || n < 10 {
		return false
	}
	return binary.BigEndian.Uint16(buf[8:10])&finderFlagIsAlias != 0
}

// resolveAliasHop follows path one step if it is a macOS Finder alias file
// whose target currently exists. info must be the lstat of path.
func resolveAliasHop(path string, info fs.FileInfo) (string, fs.FileInfo, bool) {
	if info == nil || !info.Mode().IsRegular() {
		return "", nil, false
	}
	if info.Size() < int64(len(macAliasMagic)) || info.Size() > maxAliasFileSize {
		return "", nil, false
	}
	if !hasFinderAliasFlag(path) {
		return "", nil, false
	}
	// Read through a bounded reader rather than os.ReadFile: the size above came
	// from a stat that another process can invalidate before the open, and an
	// alias blob is never larger than maxAliasFileSize anyway.
	f, err := os.Open(path)
	if err != nil {
		return "", nil, false
	}
	blob, err := io.ReadAll(io.LimitReader(f, maxAliasFileSize))
	f.Close()
	if err != nil {
		return "", nil, false
	}
	target, err := parseBookmarkTargetPath(blob)
	if err != nil || target == path {
		return "", nil, false
	}
	targetInfo, err := os.Stat(target)
	if err != nil {
		return "", nil, false
	}
	return target, targetInfo, true
}

// resolveMacAliasTarget resolves path when it is a macOS Finder alias file,
// following alias→alias chains up to maxAliasResolveHops. info must be the
// lstat of path (os.DirEntry.Info() qualifies).
//
// It reports ok=false — leaving the caller's existing behaviour untouched — for
// anything that is not a resolvable alias: ordinary files, symlinks,
// directories, aliases whose target has been deleted, and blobs that fail to
// parse.
//
// Resolution is deliberately kept free of containment policy so that every
// caller decides what a denied target means for it (a per-entry listing hides
// the alias; an explicit read or navigation returns an error). Callers MUST run
// enforceReadContainment against the returned target — following an alias
// intentionally steps outside the directory being listed, and filepath.EvalSymlinks
// does not see through an alias.
func resolveMacAliasTarget(path string, info fs.FileInfo) (string, fs.FileInfo, bool) {
	cur, curInfo := path, info
	resolved := false
	visited := map[string]bool{path: true}
	for hop := 0; hop < maxAliasResolveHops; hop++ {
		next, nextInfo, ok := resolveAliasHop(cur, curInfo)
		if !ok || visited[next] {
			break // not an alias, or an alias chain that loops back on itself
		}
		visited[next] = true
		cur, curInfo, resolved = next, nextInfo, true
	}
	if !resolved {
		return "", nil, false
	}
	return cur, curInfo, true
}
