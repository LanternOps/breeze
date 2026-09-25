//go:build linux

package hwhealth

import (
	"strings"
	"testing"
)

func TestZFSJSON(t *testing.T) {
	for _, tc := range []struct {
		version string
		want    bool
	}{{"zfs-2.2.9", false}, {"zfs-2.3.0-1", true}, {"zfs-2.10.0", true}, {"zfs-3.0.0", true}, {"zfs-kmod-2.3.0", false}, {"unknown", false}} {
		if zfsJSONCapable(tc.version) != tc.want {
			t.Fatalf("version %q", tc.version)
		}
	}
	r, err := parseZFSJSON("tank ONLINE 100G 20G 80G", w02bFixture(t, "zfs/optimal.json"), stableZFSID)
	if err != nil || !r.Complete {
		t.Fatalf("%+v %v", r, err)
	}
	vd := w02bComponent(t, r, "zfs:pool:tank")
	if vd.State != "checking" || vd.ProgressPercent == nil || *vd.ProgressPercent != 42 {
		t.Fatalf("%+v", vd)
	}
	pd := w02bComponent(t, r, "zfs:pool:tank:m:ata-A")
	if pd.MemberErrors == nil || !*pd.MemberErrors {
		t.Fatal("counters")
	}
	if _, err = parseZFSJSON("tank ONLINE 100G 20G 80G", []byte(`{"pools":`), stableZFSID); err == nil {
		t.Fatal("truncated JSON")
	}
	raw := strings.ReplaceAll(string(w02bFixture(t, "zfs/optimal.json")), "/dev/disk/by-id/ata-A", "/dev/sda")
	r, err = parseZFSJSON("tank ONLINE 100G 20G 80G", []byte(raw), func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	w02bComponent(t, r, "zfs:pool:tank:m:12345")
	raw = strings.ReplaceAll(raw, `"vdev_type":"disk"`, `"vdev_type":"future"`)
	r, err = parseZFSJSON("tank ONLINE 100G 20G 80G", []byte(raw), stableZFSID)
	if err != nil || r.Complete {
		t.Fatalf("unrecognized topology: %+v %v", r, err)
	}
}
func TestZFSJSONMemberStates(t *testing.T) {
	fixture := string(w02bFixture(t, "zfs/cant-open.json"))
	for _, tc := range []struct{ raw, want string }{
		{"ONLINE", "online"}, {"DEGRADED", "degraded"}, {"FAULTED", "failed"},
		{"OFFLINE", "offline"}, {"UNAVAIL", "missing"}, {"REMOVED", "missing"},
		{"CANT_OPEN", "missing"}, {"FUTURE_STATE", "unknown"},
	} {
		t.Run(tc.raw, func(t *testing.T) {
			data := []byte(strings.Replace(fixture, "CANT_OPEN", tc.raw, 1))
			r, err := parseZFSJSON("tank DEGRADED 100G 20G 80G", data, stableZFSID)
			if err != nil || !r.Complete || len(r.Components) != 4 {
				t.Fatalf("%+v %v", r, err)
			}
			pd := w02bComponent(t, r, "zfs:pool:tank:m:ata-B")
			if pd.State != tc.want || pd.StateDetail == nil || *pd.StateDetail != tc.raw {
				t.Fatalf("state/detail lost: %+v", pd)
			}
			if pd.MemberErrors == nil || *pd.MemberErrors || pd.PredictiveFailure {
				t.Fatalf("zero counters fabricated flags: %+v", pd)
			}
			if w02bComponent(t, r, "zfs:pool:tank:m:ata-A").State != "online" {
				t.Fatal("healthy sibling lost")
			}
			vd := w02bComponent(t, r, "zfs:pool:tank")
			members := vd.Attributes["memberKeys"].([]string)
			if vd.State != "degraded" || len(members) != 2 || members[0] != "zfs:pool:tank:m:ata-A" || members[1] != pd.ComponentKey {
				t.Fatalf("pool/membership lost: %+v", vd)
			}
		})
	}
	r, err := parseZFSJSON("tank DEGRADED 100G 20G 80G", []byte(fixture), func(string) string { return "" })
	if err != nil || !r.Complete {
		t.Fatalf("GUID fallback: %+v %v", r, err)
	}
	pd := w02bComponent(t, r, "zfs:pool:tank:m:67890")
	if pd.State != "missing" || pd.StateDetail == nil || *pd.StateDetail != "CANT_OPEN" {
		t.Fatalf("GUID missing evidence lost: %+v", pd)
	}
}
