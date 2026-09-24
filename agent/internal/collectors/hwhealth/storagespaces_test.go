package hwhealth

import "testing"

func TestSpacesFixtures(t *testing.T) {
	for _, name := range []string{"optimal", "degraded", "failed", "rebuilding-with-progress", "predictive", "missing-member", "multi-controller", "unrecognized-state", "truncated"} {
		r, e := parseSpaces(fixture(t, "storage_spaces", name+".json"))
		if name == "truncated" {
			if e == nil {
				t.Fatal("truncation accepted")
			}
			continue
		}
		if e != nil || !r.Complete {
			t.Fatalf("%s %+v %v", name, r, e)
		}
		v := findComponent(t, r.Components, "storage_spaces:vd:"+objectHash("VD1"))
		want := map[string]string{"degraded": "degraded", "failed": "offline", "rebuilding-with-progress": "rebuilding", "unrecognized-state": "unknown"}[name]
		if want == "" {
			want = "optimal"
		}
		if v.State != want {
			t.Fatalf("%s %+v", name, v)
		}
		if name == "rebuilding-with-progress" && (v.ProgressPercent == nil || *v.ProgressPercent != 42) {
			t.Fatal(v)
		}
	}
}

func TestWindowsMappings(t *testing.T) {
	for raw, want := range map[string]string{"OK": "optimal", "InService": "rebuilding", "Degraded": "degraded", "Detached": "offline", "Incomplete": "degraded", "No Redundancy": "degraded", "new": "unknown"} {
		if windowsState("virtual_disk", []string{raw}, "", "Healthy") != want {
			t.Fatal(raw)
		}
	}
	for raw, want := range map[string]string{"OK": "online", "Predictive Failure": "predictive_failure", "Lost Communication": "missing", "Transient Error": "degraded", "Starting": "online", "new": "unknown"} {
		if windowsState("physical_disk", []string{raw}, "", "Healthy") != want {
			t.Fatal(raw)
		}
	}
	if windowsState("physical_disk", []string{"OK"}, "Retired", "Healthy") != "offline" || windowsState("physical_disk", []string{"OK"}, "HotSpare", "Healthy") != "hotspare" || windowsState("physical_disk", []string{"OK"}, "", "Unhealthy") != "failed" {
		t.Fatal("usage/health precedence")
	}
}

func TestSpacesMissingPoolIdentity(t *testing.T) {
	r, e := parseSpaces([]byte(`{"Pools":[{"FriendlyName":"partial","HealthStatus":"Healthy"}],"VirtualDisks":[],"PhysicalDisks":[],"Warnings":[]}`))
	if e != nil || r.Complete {
		t.Fatalf("%+v %v", r, e)
	}
	for _, c := range r.Components {
		if c.ComponentType == "enclosure" {
			t.Fatal("invented pool identity", c)
		}
	}
}
