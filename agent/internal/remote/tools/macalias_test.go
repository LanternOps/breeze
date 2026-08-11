package tools

import (
	"encoding/binary"
	"strings"
	"testing"
)

// buildBookmark assembles a macOS bookmark blob in the layout documented in
// macalias.go. It mirrors the byte layout of real alias files produced by
// macOS Sequoia (verified against aliases created with
// -[NSURL writeBookmarkData:toURL:] on a 15.x host), so the parser is exercised
// against the same structure it will meet in the field, on every GOOS.
func buildBookmark(t *testing.T, volumePath string, components []string) []byte {
	t.Helper()

	// Body items are laid out first; offsets are relative to the body start.
	var body []byte
	// The first four bytes of the body hold the offset of the first TOC, filled
	// in once the item area is sized.
	body = append(body, 0, 0, 0, 0)

	appendItem := func(itemType uint32, payload []byte) uint32 {
		off := uint32(len(body))
		var head [8]byte
		binary.LittleEndian.PutUint32(head[0:4], uint32(len(payload)))
		binary.LittleEndian.PutUint32(head[4:8], itemType)
		body = append(body, head[:]...)
		body = append(body, payload...)
		for len(body)%4 != 0 { // items are 4-byte aligned
			body = append(body, 0)
		}
		return off
	}

	componentOffsets := make([]byte, 0, len(components)*4)
	for _, c := range components {
		off := appendItem(bookmarkTypeString, []byte(c))
		var b [4]byte
		binary.LittleEndian.PutUint32(b[:], off)
		componentOffsets = append(componentOffsets, b[:]...)
	}
	componentsOff := appendItem(bookmarkTypeArray, componentOffsets)
	volumeOff := appendItem(bookmarkTypeString, []byte(volumePath))

	// Table of contents.
	tocOff := uint32(len(body))
	entries := []struct {
		key, off uint32
	}{
		{bookmarkKeyPathComponents, componentsOff},
		{bookmarkKeyVolumePath, volumeOff},
	}
	toc := make([]byte, bookmarkTOCHeaderSize)
	binary.LittleEndian.PutUint32(toc[0:4], uint32(bookmarkTOCHeaderSize+len(entries)*bookmarkTOCEntrySize))
	binary.LittleEndian.PutUint32(toc[4:8], bookmarkTOCMagic)
	binary.LittleEndian.PutUint32(toc[8:12], 1)  // identifier
	binary.LittleEndian.PutUint32(toc[12:16], 0) // next TOC: none
	binary.LittleEndian.PutUint32(toc[16:20], uint32(len(entries)))
	for _, e := range entries {
		var rec [bookmarkTOCEntrySize]byte
		binary.LittleEndian.PutUint32(rec[0:4], e.key)
		binary.LittleEndian.PutUint32(rec[4:8], e.off)
		toc = append(toc, rec[:]...)
	}
	body = append(body, toc...)
	binary.LittleEndian.PutUint32(body[0:4], tocOff)

	header := make([]byte, 56)
	copy(header, macAliasMagic)
	binary.LittleEndian.PutUint32(header[16:20], 56)
	binary.LittleEndian.PutUint32(header[20:24], 56)
	binary.LittleEndian.PutUint32(header[24:28], uint32(len(body)))
	binary.LittleEndian.PutUint32(header[28:32], 0x10050000)

	return append(header, body...)
}

func TestParseBookmarkTargetPath(t *testing.T) {
	tests := []struct {
		name       string
		volumePath string
		components []string
		want       string
	}{
		{
			name:       "boot volume folder",
			volumePath: "/",
			components: []string{"Users", "tech", "Desktop", "Projects"},
			want:       "/Users/tech/Desktop/Projects",
		},
		{
			// The reporter's case: a Desktop alias into iCloud Drive.
			name:       "icloud drive folder",
			volumePath: "/",
			components: []string{"Users", "tech", "Library", "Mobile Documents", "com~apple~CloudDocs", "Shared"},
			want:       "/Users/tech/Library/Mobile Documents/com~apple~CloudDocs/Shared",
		},
		{
			name:       "external volume",
			volumePath: "/Volumes/Backup Drive",
			components: []string{"Archive", "2026", "report.pdf"},
			want:       "/Volumes/Backup Drive/Archive/2026/report.pdf",
		},
		{
			name:       "single component",
			volumePath: "/",
			components: []string{"Applications"},
			want:       "/Applications",
		},
		{
			name:       "names with spaces and unicode",
			volumePath: "/",
			components: []string{"Users", "tech", "Ünïcode Dîr", "my file.txt"},
			want:       "/Users/tech/Ünïcode Dîr/my file.txt",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseBookmarkTargetPath(buildBookmark(t, tc.volumePath, tc.components))
			if err != nil {
				t.Fatalf("parseBookmarkTargetPath() error = %v", err)
			}
			if got != tc.want {
				t.Errorf("parseBookmarkTargetPath() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestParseBookmarkTargetPathRejectsNonBookmarks(t *testing.T) {
	valid := buildBookmark(t, "/", []string{"Users", "tech"})

	tests := []struct {
		name string
		blob []byte
	}{
		{"empty", nil},
		{"short", []byte("book")},
		{"wrong magic", append([]byte("junk\x00\x00\x00\x00junk\x00\x00\x00\x00"), valid[16:]...)},
		{"truncated body", valid[:40]},
		{"truncated mid-body", valid[:len(valid)-8]},
		{"plain text file", []byte(strings.Repeat("hello world\n", 40))},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got, err := parseBookmarkTargetPath(tc.blob); err == nil {
				t.Errorf("parseBookmarkTargetPath() = %q, want error", got)
			}
		})
	}
}

// A hostile blob must not be able to steer the resolved path somewhere else by
// smuggling separators or traversal segments into a path component.
func TestParseBookmarkTargetPathRejectsHostileComponents(t *testing.T) {
	for _, comp := range []string{"..", ".", "", "etc/shadow", "../../etc"} {
		t.Run(comp, func(t *testing.T) {
			blob := buildBookmark(t, "/", []string{"Users", comp})
			if got, err := parseBookmarkTargetPath(blob); err == nil {
				t.Errorf("parseBookmarkTargetPath() = %q, want error for component %q", got, comp)
			}
		})
	}
}

func TestParseBookmarkTargetPathRejectsRelativeVolumePath(t *testing.T) {
	blob := buildBookmark(t, "relative/volume", []string{"Users"})
	if got, err := parseBookmarkTargetPath(blob); err == nil {
		t.Errorf("parseBookmarkTargetPath() = %q, want error", got)
	}
}

// A malformed blob must fail fast rather than allocate or spin: the parser is
// fed bytes that came off a customer's disk.
func TestParseBookmarkTargetPathBoundsHostileHeaders(t *testing.T) {
	base := buildBookmark(t, "/", []string{"Users", "tech"})

	t.Run("header size beyond blob", func(t *testing.T) {
		blob := append([]byte(nil), base...)
		binary.LittleEndian.PutUint32(blob[16:20], 0xFFFFFFF0)
		if _, err := parseBookmarkTargetPath(blob); err == nil {
			t.Error("expected error for out-of-range header size")
		}
	})

	t.Run("header size below minimum", func(t *testing.T) {
		blob := append([]byte(nil), base...)
		binary.LittleEndian.PutUint32(blob[16:20], 8)
		if _, err := parseBookmarkTargetPath(blob); err == nil {
			t.Error("expected error for undersized header")
		}
	})

	t.Run("toc offset beyond body", func(t *testing.T) {
		blob := append([]byte(nil), base...)
		binary.LittleEndian.PutUint32(blob[56:60], 0xFFFFFF00)
		if _, err := parseBookmarkTargetPath(blob); err == nil {
			t.Error("expected error for out-of-range TOC offset")
		}
	})

	t.Run("toc entry count beyond body", func(t *testing.T) {
		blob := append([]byte(nil), base...)
		tocOff := 56 + binary.LittleEndian.Uint32(blob[56:60])
		binary.LittleEndian.PutUint32(blob[tocOff+16:tocOff+20], 64)
		if _, err := parseBookmarkTargetPath(blob); err == nil {
			t.Error("expected error for oversized TOC entry count")
		}
	})

	t.Run("toc entry count beyond cap", func(t *testing.T) {
		blob := append([]byte(nil), base...)
		tocOff := 56 + binary.LittleEndian.Uint32(blob[56:60])
		binary.LittleEndian.PutUint32(blob[tocOff+16:tocOff+20], maxBookmarkTOCEntries+1)
		if _, err := parseBookmarkTargetPath(blob); err == nil {
			t.Error("expected error for TOC entry count above the cap")
		}
	})

	t.Run("toc chain that loops forever", func(t *testing.T) {
		blob := append([]byte(nil), base...)
		tocOff := 56 + binary.LittleEndian.Uint32(blob[56:60])
		// Point the "next TOC" link back at this same TOC.
		binary.LittleEndian.PutUint32(blob[tocOff+12:tocOff+16], binary.LittleEndian.Uint32(blob[56:60]))
		// Must terminate; the self-referencing link is ignored, so the path
		// still parses from the single real TOC.
		if _, err := parseBookmarkTargetPath(blob); err != nil {
			t.Fatalf("parseBookmarkTargetPath() error = %v", err)
		}
	})

	t.Run("bad toc magic", func(t *testing.T) {
		blob := append([]byte(nil), base...)
		tocOff := 56 + binary.LittleEndian.Uint32(blob[56:60])
		binary.LittleEndian.PutUint32(blob[tocOff+4:tocOff+8], 0xDEADBEEF)
		if _, err := parseBookmarkTargetPath(blob); err == nil {
			t.Error("expected error for bad TOC magic")
		}
	})
}

func TestHasMacAliasMagic(t *testing.T) {
	if !hasMacAliasMagic([]byte(macAliasMagic + "trailing")) {
		t.Error("hasMacAliasMagic() = false for a blob with the magic")
	}
	if hasMacAliasMagic([]byte("book")) {
		t.Error("hasMacAliasMagic() = true for a too-short blob")
	}
	if hasMacAliasMagic([]byte("bookmark\x00\x00\x00\x00\x00\x00\x00\x00")) {
		t.Error("hasMacAliasMagic() = true for a blob without the exact magic")
	}
}
