package patching

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

// #6910: an update that was in the scan set but is no longer offered at
// install time (a Defender definition superseded between scan and install,
// KB2267602) is skipped, not failed.
func TestNotOfferedInstallResult(t *testing.T) {
	cases := []struct {
		name       string
		installed  bool
		wantReason string
		wantText   string
	}{
		{name: "no longer offered", installed: false, wantReason: SkipReasonNotOffered, wantText: "superseded"},
		{name: "already installed", installed: true, wantReason: SkipReasonAlreadyInstalled, wantText: "already installed"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := notOfferedInstallResult("KB2267602", tc.installed)
			if !res.Skipped {
				t.Fatalf("want Skipped, got %+v", res)
			}
			if res.SkipReason != tc.wantReason {
				t.Fatalf("SkipReason = %q, want %q", res.SkipReason, tc.wantReason)
			}
			if res.PatchID != "KB2267602" || res.RebootRequired {
				t.Fatalf("got %+v", res)
			}
			if !strings.Contains(res.Message, "KB2267602") || !strings.Contains(res.Message, tc.wantText) {
				t.Fatalf("message %q must name the update and say %q", res.Message, tc.wantText)
			}
		})
	}
}

// Only the WUA "not in the search results" outcome is a skip; a search that
// failed outright must stay an error.
func TestIsUpdateNotFound(t *testing.T) {
	if !isUpdateNotFound(fmt.Errorf("wrap: %w", errUpdateNotFound)) {
		t.Fatal("wrapped errUpdateNotFound must match")
	}
	if isUpdateNotFound(errors.New("search failed: 0x80072EE2")) {
		t.Fatal("a search failure is not a not-found")
	}
	if isUpdateNotFound(nil) {
		t.Fatal("nil is not a not-found")
	}
}

// A miss is only a skippable "not offered" when findUpdate inspected every
// search result. If any result was unreadable, the target may be among them,
// so the miss must stay a real (alerting) install error.
func TestUpdateNotFoundErrorRequiresCompleteEnumeration(t *testing.T) {
	complete := updateNotFoundError("KB2267602", 0, 5)
	if !isUpdateNotFound(complete) {
		t.Fatalf("complete enumeration must be a not-found, got %v", complete)
	}
	if complete.Error() != "update KB2267602 not found" {
		t.Fatalf("error text changed: %q", complete.Error())
	}

	partial := updateNotFoundError("KB2267602", 2, 5)
	if partial == nil || isUpdateNotFound(partial) {
		t.Fatalf("partial enumeration must NOT be a skippable not-found, got %v", partial)
	}
	if !strings.Contains(partial.Error(), "2 of 5") {
		t.Fatalf("error should say how many results were unreadable: %q", partial.Error())
	}
}
