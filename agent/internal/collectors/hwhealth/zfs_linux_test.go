//go:build linux

package hwhealth

import (
	"strings"
	"testing"
)

func TestZFSText(t *testing.T) {
	parts := strings.Split(string(w02bFixture(t, "zfs/optimal.txt")), "\n===\n")
	r := parseZFSText(parts[0], parts[1], func(s string) string { return strings.TrimPrefix(s, "/dev/disk/by-id/") })
	if !r.Complete || len(r.Components) != 4 {
		t.Fatalf("%+v", r)
	}
	vd := w02bComponent(t, r, "zfs:pool:tank")
	if len(vd.Attributes["memberKeys"].([]string)) != 2 {
		t.Fatal("leaf membership")
	}
	status := strings.ReplaceAll(parts[1], "scan: none requested", "scan: resilver in progress\n        42.5% done")
	r = parseZFSText(parts[0], status, stableZFSID)
	vd = w02bComponent(t, r, "zfs:pool:tank")
	if vd.State != "rebuilding" || vd.ProgressPercent == nil || *vd.ProgressPercent != 42 {
		t.Fatalf("%+v", vd)
	}
	status = strings.ReplaceAll(status, "ata-A     ONLINE       0", "ata-A     ONLINE       1")
	pd := w02bComponent(t, parseZFSText(parts[0], status, stableZFSID), "zfs:pool:tank:m:ata-A")
	if pd.MemberErrors == nil || !*pd.MemberErrors || pd.PredictiveFailure {
		t.Fatal("member errors are their own flag")
	}
	r = parseZFSText(parts[0], strings.ReplaceAll(status, "/dev/disk/by-id/ata-A", "/dev/sda"), func(s string) string {
		if s == "/dev/sda" {
			return ""
		}
		return strings.TrimPrefix(s, "/dev/disk/by-id/")
	})
	if r.Complete {
		t.Fatal("unstable identity must not permit staling")
	}
}
func TestZFSTextShortLeaves(t *testing.T) {
	parts := strings.Split(string(w02bFixture(t, "zfs/optimal.txt")), "\n===\n")
	original := "/dev/disk/by-id/ata-A     ONLINE       0     0     0"
	for _, leaf := range []string{"/dev/disk/by-id/ata-A", "12345"} {
		for _, suffix := range []string{"", " ONLINE", " ONLINE 0", " ONLINE 0 0"} {
			t.Run(leaf+suffix, func(t *testing.T) {
				status := strings.Replace(parts[1], original, leaf+suffix, 1)
				if status == parts[1] || !strings.Contains(status, "errors: No known data errors") {
					t.Fatal("fixture must retain footer and shorten a leaf")
				}
				r := parseZFSText(parts[0], status, stableZFSID)
				if r.Complete || len(r.Warnings) == 0 {
					t.Fatalf("short leaf must withhold staling: %+v", r)
				}
				if len(r.Components) != 3 {
					t.Fatalf("expected controller, pool and intact sibling: %+v", r)
				}
				if w02bComponent(t, r, "zfs:pool:tank:m:ata-B").State != "online" {
					t.Fatal("intact sibling lost")
				}
				members := w02bComponent(t, r, "zfs:pool:tank").Attributes["memberKeys"].([]string)
				if len(members) != 1 || members[0] != "zfs:pool:tank:m:ata-B" {
					t.Fatalf("fabricated membership: %v", members)
				}
			})
		}
	}
	// Non-leaf section labels have fewer columns and must not invalidate a complete table.
	status := strings.Replace(parts[1], "          mirror-0", "        logs\n          mirror-0", 1)
	r := parseZFSText(parts[0], status, stableZFSID)
	if !r.Complete || len(r.Components) != 4 {
		t.Fatalf("section label treated as malformed leaf: %+v", r)
	}
}
