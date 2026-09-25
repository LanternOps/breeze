package hwhealth

import "testing"

func TestWinPDFixtures(t *testing.T) {
	for _, name := range []string{"optimal", "degraded", "failed", "rebuilding-with-progress", "predictive", "missing-member", "multi-controller", "unrecognized-state", "truncated"} {
		r, e := parseWinPD(fixture(t, "windows_physical_disk", name+".json"), map[string]string{})
		if name == "truncated" {
			if e == nil {
				t.Fatal("truncation accepted")
			}
			continue
		}
		if e != nil {
			t.Fatal(e)
		}
		c := findComponent(t, r.Components, "winpd:D1")
		want := map[string]string{"degraded": "degraded", "failed": "failed", "predictive": "predictive_failure", "missing-member": "missing", "unrecognized-state": "unknown", "rebuilding-with-progress": "unknown"}[name]
		if want == "" {
			want = "online"
		}
		if c.State != want || c.TemperatureC == nil || *c.TemperatureC != 31 {
			t.Fatalf("%s %+v", name, c)
		}
	}
}

func TestWinPDIncompleteIdentity(t *testing.T) {
	r, e := parseWinPD([]byte(`{"Disks":[{"FriendlyName":"no id"}],"Warnings":[]}`), map[string]string{})
	if e != nil || r.Complete || len(r.Components) != 0 {
		t.Fatalf("%+v %v", r, e)
	}
}
