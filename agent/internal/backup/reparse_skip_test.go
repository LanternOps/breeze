package backup

import (
	"encoding/binary"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"
)

// mountPointBuffer builds a REPARSE_DATA_BUFFER for IO_REPARSE_TAG_MOUNT_POINT
// exactly as FSCTL_GET_REPARSE_POINT returns it: 8-byte header, then the
// MountPointReparseBuffer (four uint16 offset/length fields relative to
// PathBuffer, in bytes) and the UTF-16LE substitute + print names.
func mountPointBuffer(substitute, print string) []byte {
	enc := func(s string) []byte {
		u := utf16.Encode([]rune(s))
		b := make([]byte, 2*len(u))
		for i, c := range u {
			binary.LittleEndian.PutUint16(b[2*i:], c)
		}
		return b
	}
	sub, prn := enc(substitute), enc(print)
	pathBuf := append(append([]byte{}, sub...), 0, 0)
	pathBuf = append(pathBuf, prn...)
	pathBuf = append(pathBuf, 0, 0)
	buf := make([]byte, 16+len(pathBuf))
	binary.LittleEndian.PutUint32(buf[0:], ioReparseTagMountPoint)
	binary.LittleEndian.PutUint16(buf[4:], uint16(8+len(pathBuf)))
	binary.LittleEndian.PutUint16(buf[8:], 0)                   // SubstituteNameOffset
	binary.LittleEndian.PutUint16(buf[10:], uint16(len(sub)))   // SubstituteNameLength
	binary.LittleEndian.PutUint16(buf[12:], uint16(len(sub)+2)) // PrintNameOffset
	binary.LittleEndian.PutUint16(buf[14:], uint16(len(prn)))   // PrintNameLength
	copy(buf[16:], pathBuf)
	return buf
}

func TestParseReparseBuffer_Junction(t *testing.T) {
	tag, kind, target, err := parseReparseBuffer(mountPointBuffer(`\??\C:\Users\Public\Music`, `C:\Users\Public\Music`))
	if err != nil {
		t.Fatalf("parseReparseBuffer: %v", err)
	}
	if tag != ioReparseTagMountPoint || kind != reparseKindJunction || target != `C:\Users\Public\Music` {
		t.Fatalf("got tag=%#x kind=%q target=%q, want junction -> C:\\Users\\Public\\Music", tag, kind, target)
	}
}

func TestParseReparseBuffer_JunctionWithoutPrintNameFallsBackToSubstitute(t *testing.T) {
	_, kind, target, err := parseReparseBuffer(mountPointBuffer(`\??\D:\Data`, ""))
	if err != nil {
		t.Fatalf("parseReparseBuffer: %v", err)
	}
	if kind != reparseKindJunction || target != `D:\Data` {
		t.Fatalf("got kind=%q target=%q, want junction -> D:\\Data", kind, target)
	}
}

func TestParseReparseBuffer_VolumeMountPoint(t *testing.T) {
	vol := `\??\Volume{3f1b6a8e-0000-0000-0000-100000000000}\`
	_, kind, target, err := parseReparseBuffer(mountPointBuffer(vol, ""))
	if err != nil {
		t.Fatalf("parseReparseBuffer: %v", err)
	}
	if kind != reparseKindMountPoint {
		t.Fatalf("kind = %q, want %q", kind, reparseKindMountPoint)
	}
	if target != `\\?\Volume{3f1b6a8e-0000-0000-0000-100000000000}\` {
		t.Fatalf("target = %q", target)
	}
}

func TestParseReparseBuffer_OtherTag(t *testing.T) {
	buf := make([]byte, 8)
	binary.LittleEndian.PutUint32(buf, 0x80000017) // IO_REPARSE_TAG_WOF
	tag, kind, target, err := parseReparseBuffer(buf)
	if err != nil {
		t.Fatalf("parseReparseBuffer: %v", err)
	}
	if tag != 0x80000017 || kind != reparseKindOther || target != "" {
		t.Fatalf("got tag=%#x kind=%q target=%q, want other/0x80000017/no target", tag, kind, target)
	}
}

func TestParseReparseBuffer_Malformed(t *testing.T) {
	good := mountPointBuffer(`\??\C:\x`, `C:\x`)
	cases := map[string][]byte{
		"empty":           nil,
		"short header":    good[:6],
		"short mount hdr": good[:12],
		"names past end":  good[:18],
	}
	for name, buf := range cases {
		t.Run(name, func(t *testing.T) {
			if _, _, _, err := parseReparseBuffer(buf); err == nil {
				t.Fatalf("expected error for %s buffer", name)
			}
		})
	}
}

func TestReparseSkips_CapsSampleButCountsAll(t *testing.T) {
	r := newReparseSkips()
	for i := 0; i < maxSkippedReparseSample+7; i++ {
		kind := reparseKindJunction
		if i%3 == 0 {
			kind = reparseKindOther
		}
		r.add(skippedReparsePoint{path: fmt.Sprintf(`C:\p%d`, i), kind: kind})
	}
	if r.total != maxSkippedReparseSample+7 {
		t.Fatalf("total = %d, want %d", r.total, maxSkippedReparseSample+7)
	}
	if len(r.sample) != maxSkippedReparseSample {
		t.Fatalf("sample = %d, want cap %d", len(r.sample), maxSkippedReparseSample)
	}
	if r.byKind[reparseKindJunction]+r.byKind[reparseKindOther] != r.total {
		t.Fatalf("byKind %v does not add up to total %d", r.byKind, r.total)
	}
}

func TestSummarizeSkippedReparsePoints(t *testing.T) {
	if got := summarizeSkippedReparsePoints(nil); got != "" {
		t.Fatalf("nil skips should summarize to empty, got %q", got)
	}
	if got := summarizeSkippedReparsePoints(newReparseSkips()); got != "" {
		t.Fatalf("empty skips should summarize to empty, got %q", got)
	}

	r := newReparseSkips()
	r.add(skippedReparsePoint{path: `C:\Users\a\My Music`, kind: reparseKindJunction, target: `C:\Users\a\Music`})
	r.add(skippedReparsePoint{path: `C:\Mounts\Data`, kind: reparseKindMountPoint, target: `\\?\Volume{x}\`})
	r.add(skippedReparsePoint{path: `C:\Windows\x.dll`, kind: reparseKindOther, tag: 0x80000017})
	for i := 0; i < 5; i++ {
		r.add(skippedReparsePoint{path: fmt.Sprintf(`C:\j%d`, i), kind: reparseKindJunction, target: `C:\t`})
	}
	got := summarizeSkippedReparsePoints(r)
	for _, want := range []string{
		"8 reparse point(s) were not backed up",
		"6 junction",
		"1 volume mount point",
		"1 other",
		`C:\Users\a\My Music (junction -> C:\Users\a\Music)`,
		`C:\Mounts\Data (volume mount point -> \\?\Volume{x}\)`,
		`C:\Windows\x.dll (other reparse point, tag 0x80000017)`,
		"(+3 more)",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("summary missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, `C:\j2`) {
		t.Errorf("summary should cap details at %d entries:\n%s", maxUploadFailureDetails, got)
	}
}

func TestReportSkippedReparsePoints_WarningOnlyNoErrorCount(t *testing.T) {
	job := &BackupJob{Warning: "earlier note"}
	r := newReparseSkips()
	r.add(skippedReparsePoint{path: `C:\x`, kind: reparseKindJunction, target: `C:\y`})
	reportSkippedReparsePoints(job, r)
	if job.ErrorCount != 0 {
		t.Fatalf("skipped reparse points are a Warning, not errors; ErrorCount = %d", job.ErrorCount)
	}
	if !strings.HasPrefix(job.Warning, "earlier note; 1 reparse point(s) were not backed up") {
		t.Fatalf("Warning = %q", job.Warning)
	}

	clean := &BackupJob{}
	reportSkippedReparsePoints(clean, newReparseSkips())
	reportSkippedReparsePoints(clean, nil)
	if clean.Warning != "" {
		t.Fatalf("no skips must add no Warning, got %q", clean.Warning)
	}
}

func TestLivePathForVSS(t *testing.T) {
	live := filepath.Join("vol", "live")
	shadow := filepath.Join("vol", "shadow")
	shadows := map[string]string{live: shadow}

	if got := livePathForVSS(filepath.Join(shadow, "a", "b"), shadows); got != filepath.Join(live, "a", "b") {
		t.Fatalf("child path not mapped back to the live volume: %q", got)
	}
	if got := livePathForVSS(shadow, shadows); got != live {
		t.Fatalf("shadow root not mapped to live root: %q", got)
	}
	if p := filepath.Join("vol", "elsewhere", "x"); livePathForVSS(p, shadows) != p {
		t.Fatal("unrelated path must pass through unchanged")
	}
	if p := filepath.Join("vol", "shadowish", "x"); livePathForVSS(p, shadows) != p {
		t.Fatal("a sibling that merely shares the string prefix must not be rewritten")
	}
	if p := filepath.Join(shadow, "x"); livePathForVSS(p, nil) != p {
		t.Fatal("no VSS session must pass the path through unchanged")
	}
}
