package tools

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// macOS Finder aliases are not symlinks: on disk they are ordinary regular
// files whose data fork holds a CoreFoundation "bookmark" blob (the same bytes
// CFURLCreateBookmarkData / -[NSURL writeBookmarkData:toURL:] produce) and
// whose com.apple.FinderInfo xattr carries the kIsAlias flag. Because they are
// regular files, os.DirEntry.IsDir() is false and filepath.EvalSymlinks is a
// no-op on them, so without explicit handling the file browser lists an alias
// as a ~1KB "file" and offers the raw bookmark blob for download instead of
// following it (issue #3344).
//
// The blob is parsed here in pure Go rather than through CoreServices/cgo: the
// agent's CI and several release targets build with CGO_ENABLED=0, so a cgo
// resolver would silently do nothing on exactly the builds that ship.
//
// Blob layout (all integers little-endian):
//
//	0x00  "book\0\0\0\0mark\0\0\0\0"  magic
//	0x10  uint32  header size (56 in every macOS version observed)
//	0x14  uint32  header size, repeated
//	0x18  uint32  body size
//	0x1C  uint32  version
//	...          reserved
//
//	body := blob[headerSize:]
//	body[0:4]  uint32  offset (relative to body) of the first table of contents
//
// Table of contents record:
//
//	uint32 size, uint32 magic (0xFFFFFFFE), uint32 identifier,
//	uint32 offset of next TOC (0 = last), uint32 entry count,
//	then entryCount × { uint32 key, uint32 offset, uint32 reserved }
//
// Item at body[offset]:
//
//	uint32 length, uint32 type, then length payload bytes
//
// The two keys needed to rebuild a POSIX path are the path-component array and
// the volume path; everything else (CNIDs, volume UUID, creation dates) is
// ignored.
const macAliasMagic = "book\x00\x00\x00\x00mark\x00\x00\x00\x00"

const (
	// bookmarkKeyPathComponents holds an array of the target's path components,
	// relative to the volume root.
	bookmarkKeyPathComponents = 0x1004
	// bookmarkKeyVolumePath holds the mount point of the target's volume ("/"
	// for the boot volume, "/Volumes/Name" for anything else).
	bookmarkKeyVolumePath = 0x2002

	bookmarkTypeString = 0x0101
	bookmarkTypeArray  = 0x0601

	bookmarkTOCMagic = 0xFFFFFFFE

	// bookmarkMinHeaderSize is the smallest header that can still hold the
	// magic and the header-size field itself.
	bookmarkMinHeaderSize = 32
	bookmarkTOCHeaderSize = 20
	bookmarkTOCEntrySize  = 12
	bookmarkItemHeader    = 8

	// Bounds applied to attacker-influenced counts so a small hostile file can
	// never drive a large allocation or a long loop. Real aliases carry a
	// single TOC and a handful of path components.
	maxBookmarkTOCs           = 8
	maxBookmarkTOCEntries     = 512
	maxBookmarkPathComponents = 256
	maxBookmarkStringLen      = 4096
	// maxBookmarkPathLen bounds the reconstructed path; PATH_MAX on macOS is
	// 1024, so anything longer cannot name a real file.
	maxBookmarkPathLen = 4096
)

var errNotBookmark = errors.New("not a macOS bookmark blob")

// resolveMacAliasPath resolves path when it names a macOS Finder alias file,
// taking care of the lstat itself. Returns ("", false) for anything that is not
// a resolvable alias, and on every non-macOS platform.
func resolveMacAliasPath(path string) (string, bool) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", false
	}
	target, _, ok := resolveMacAliasTarget(path, info)
	return target, ok
}

// hasMacAliasMagic reports whether b starts with the bookmark magic.
func hasMacAliasMagic(b []byte) bool {
	return len(b) >= len(macAliasMagic) && string(b[:len(macAliasMagic)]) == macAliasMagic
}

// sliceAt returns body[off:off+n], or false if that range is out of bounds.
// off and n arrive from the file, so the arithmetic is done in uint64 to keep
// a hostile 32-bit value from wrapping on any GOARCH.
func sliceAt(body []byte, off uint32, n uint64) ([]byte, bool) {
	end := uint64(off) + n
	if end > uint64(len(body)) {
		return nil, false
	}
	return body[uint64(off):end], true
}

// bookmarkItem returns the type and payload of the item stored at body[off].
func bookmarkItem(body []byte, off uint32) (uint32, []byte, bool) {
	head, ok := sliceAt(body, off, bookmarkItemHeader)
	if !ok {
		return 0, nil, false
	}
	length := binary.LittleEndian.Uint32(head[0:4])
	itemType := binary.LittleEndian.Uint32(head[4:8])
	payload, ok := sliceAt(body, off+bookmarkItemHeader, uint64(length))
	if !ok {
		return 0, nil, false
	}
	return itemType, payload, true
}

// bookmarkString reads a UTF-8 string item.
func bookmarkString(body []byte, off uint32) (string, bool) {
	itemType, payload, ok := bookmarkItem(body, off)
	if !ok || itemType != bookmarkTypeString || len(payload) > maxBookmarkStringLen {
		return "", false
	}
	return string(payload), true
}

// bookmarkStringArray reads an array item whose elements are string items.
func bookmarkStringArray(body []byte, off uint32, limit int) ([]string, bool) {
	itemType, payload, ok := bookmarkItem(body, off)
	if !ok || itemType != bookmarkTypeArray {
		return nil, false
	}
	count := len(payload) / 4
	if count == 0 || count > limit {
		return nil, false
	}
	out := make([]string, 0, count)
	for i := 0; i < count; i++ {
		s, ok := bookmarkString(body, binary.LittleEndian.Uint32(payload[i*4:i*4+4]))
		if !ok {
			return nil, false
		}
		out = append(out, s)
	}
	return out, true
}

// parseBookmarkTargetPath extracts the absolute POSIX path a macOS bookmark
// blob points at. It only reads the blob — the returned path is not checked for
// existence, and callers must treat it as untrusted input until they stat it.
func parseBookmarkTargetPath(blob []byte) (string, error) {
	if !hasMacAliasMagic(blob) {
		return "", errNotBookmark
	}
	if len(blob) < bookmarkMinHeaderSize {
		return "", errNotBookmark
	}

	headerSize := binary.LittleEndian.Uint32(blob[16:20])
	if headerSize < bookmarkMinHeaderSize || uint64(headerSize) > uint64(len(blob)) {
		return "", fmt.Errorf("bookmark header size %d out of range", headerSize)
	}
	body := blob[headerSize:]
	if len(body) < 4 {
		return "", errNotBookmark
	}

	var (
		components []string
		volumePath string
		tocOffset  = binary.LittleEndian.Uint32(body[0:4])
		visited    = make(map[uint32]bool, maxBookmarkTOCs)
	)

	for hop := 0; tocOffset != 0 && hop < maxBookmarkTOCs; hop++ {
		if visited[tocOffset] {
			break // cyclic TOC chain in a malformed/hostile blob
		}
		visited[tocOffset] = true

		head, ok := sliceAt(body, tocOffset, bookmarkTOCHeaderSize)
		if !ok {
			return "", errors.New("bookmark table of contents out of range")
		}
		if binary.LittleEndian.Uint32(head[4:8]) != bookmarkTOCMagic {
			return "", errors.New("bookmark table of contents has bad magic")
		}
		next := binary.LittleEndian.Uint32(head[12:16])
		count := binary.LittleEndian.Uint32(head[16:20])
		if count > maxBookmarkTOCEntries {
			return "", fmt.Errorf("bookmark table of contents lists %d entries", count)
		}
		entries, ok := sliceAt(body, tocOffset+bookmarkTOCHeaderSize, uint64(count)*bookmarkTOCEntrySize)
		if !ok {
			return "", errors.New("bookmark table of contents entries out of range")
		}

		for i := uint32(0); i < count; i++ {
			e := entries[i*bookmarkTOCEntrySize:]
			key := binary.LittleEndian.Uint32(e[0:4])
			off := binary.LittleEndian.Uint32(e[4:8])
			switch key {
			case bookmarkKeyPathComponents:
				if components == nil {
					if parts, ok := bookmarkStringArray(body, off, maxBookmarkPathComponents); ok {
						components = parts
					}
				}
			case bookmarkKeyVolumePath:
				if volumePath == "" {
					if s, ok := bookmarkString(body, off); ok {
						volumePath = s
					}
				}
			}
		}

		tocOffset = next
	}

	if len(components) == 0 {
		return "", errors.New("bookmark carries no path components")
	}
	for _, c := range components {
		// A component containing a separator or a traversal segment would let a
		// crafted blob synthesise a different path than the one it describes.
		if c == "" || c == "." || c == ".." || strings.ContainsRune(c, filepath.Separator) || strings.ContainsRune(c, '/') {
			return "", fmt.Errorf("bookmark path component %q is not a plain name", c)
		}
	}

	if volumePath == "" {
		volumePath = "/"
	}
	if !filepath.IsAbs(volumePath) {
		return "", fmt.Errorf("bookmark volume path %q is not absolute", volumePath)
	}

	target := filepath.Join(append([]string{volumePath}, components...)...)
	if !filepath.IsAbs(target) {
		return "", fmt.Errorf("bookmark resolved to non-absolute path %q", target)
	}
	if len(target) > maxBookmarkPathLen {
		return "", fmt.Errorf("bookmark resolved to an oversized path (%d bytes)", len(target))
	}
	return target, nil
}
