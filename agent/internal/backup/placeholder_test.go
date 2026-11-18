package backup

import (
	"fmt"
	"strings"
	"testing"
)

// #7326: the data-file reparse tags the collector reads like regular files.
func TestIsDataReparseTag(t *testing.T) {
	cases := []struct {
		tag  uint32
		want bool
		name string
	}{
		{ioReparseTagWOF, true, "WOF (CompactOS, compact /exe)"},
		{0x9000001A, true, "IO_REPARSE_TAG_CLOUD"},
		{0x9000101A, true, "IO_REPARSE_TAG_CLOUD_1"},
		{0x9000601A, true, "IO_REPARSE_TAG_CLOUD_6 (OneDrive)"},
		{0x9000F01A, true, "IO_REPARSE_TAG_CLOUD_F"},
		{ioReparseTagMountPoint, false, "mount point / junction"},
		{0xA000000C, false, "symlink"},
		{0x8000001B, false, "APPEXECLINK (app execution alias)"},
		{0x9000001C, false, "PROJFS"},
		{0x9000F01B, false, "cloud-shaped but not a cloud tag"},
		{0, false, "no tag"},
	}
	for _, c := range cases {
		if got := isDataReparseTag(c.tag); got != c.want {
			t.Errorf("isDataReparseTag(0x%08X) [%s] = %v, want %v", c.tag, c.name, got, c.want)
		}
	}
}

// #7326: any of these attributes means the data is not on this machine and
// reading (or, for RECALL_ON_OPEN, opening) the file would fetch it.
func TestNotStoredLocallyReason(t *testing.T) {
	if r := notStoredLocallyReason(winAttrReparsePoint | winAttrSparseFile); r != "" {
		t.Fatalf("a hydrated cloud file (reparse+sparse only) is local, got %q", r)
	}
	if r := notStoredLocallyReason(0); r != "" {
		t.Fatalf("no attributes is local, got %q", r)
	}
	for attrs, want := range map[uint32]string{
		winAttrRecallOnDataAccess: "recall on data access",
		winAttrRecallOnOpen:       "recall on open",
		winAttrOffline:            "offline",
		winAttrOffline | winAttrRecallOnDataAccess | 0x400: "offline",
	} {
		r := notStoredLocallyReason(attrs)
		if !strings.Contains(r, want) {
			t.Errorf("notStoredLocallyReason(0x%08X) = %q, want it to mention %q", attrs, r, want)
		}
	}
}

func TestSummarizeNotStoredLocally(t *testing.T) {
	if got := summarizeNotStoredLocally(newReparseSkips()); got != "" {
		t.Fatalf("no placeholders → no warning, got %q", got)
	}
	r := newReparseSkips()
	for i := range maxUploadFailureDetails + 3 {
		r.addNotLocal(skippedReparsePoint{path: `C:\Users\a\OneDrive\f` + string(rune('a'+i)), kind: reparseKindNotLocal, detail: "cloud placeholder: recall on data access"})
	}
	got := summarizeNotStoredLocally(r)
	wantPrefix := fmt.Sprintf("%d file(s) were not backed up because their data is not stored on this machine", maxUploadFailureDetails+3)
	if !strings.HasPrefix(got, wantPrefix) {
		t.Fatalf("summary = %q, want prefix %q", got, wantPrefix)
	}
	if !strings.Contains(got, `C:\Users\a\OneDrive\fa (cloud placeholder: recall on data access)`) {
		t.Fatalf("summary must name the first placeholder: %q", got)
	}
	if !strings.HasSuffix(got, "(+3 more)") {
		t.Fatalf("summary must count the rest: %q", got)
	}
	if r.total != 0 {
		t.Fatalf("placeholders are not reparse-point skips: total = %d", r.total)
	}
}
