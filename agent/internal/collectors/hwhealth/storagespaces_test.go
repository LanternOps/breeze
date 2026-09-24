package hwhealth

import (
	"testing"
	"time"
)

// The member map must survive an agent restart: a disk that drops out while
// the agent is down comes back as a stand-in on the first post-restart poll.
func TestSpacesMemberMemoryPersists(t *testing.T) {
	dir := t.TempDir()
	now := time.Unix(1_800_000_000, 0)
	s, _ := loadState(dir, now)
	if _, e := parseSpaces(fixture(t, "storage_spaces", "lab-6895-healthy.json"), s.SpacesMembers); e != nil {
		t.Fatal(e)
	}
	if e := reserveSequence(dir, &s); e != nil {
		t.Fatal(e)
	}
	restarted, e := loadState(dir, now)
	if e != nil {
		t.Fatal(e)
	}
	r, e := parseSpaces(fixture(t, "storage_spaces", "lab-6895-missing.json"), restarted.SpacesMembers)
	if e != nil {
		t.Fatal(e)
	}
	c := findComponent(t, r.Components, slotKey("storage_spaces:ctrl", "-", objectHash("60022480CFCA9CD7995F7E79FEF2B2F9")))
	if c.State != "missing" {
		t.Fatal(c)
	}
}

func TestSpacesFixtures(t *testing.T) {
	for _, name := range []string{"optimal", "degraded", "failed", "rebuilding-with-progress", "predictive", "missing-member", "multi-controller", "unrecognized-state", "truncated"} {
		r, e := parseSpaces(fixture(t, "storage_spaces", name+".json"), map[string]string{})
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
	r, e := parseSpaces([]byte(`{"Pools":[{"FriendlyName":"partial","HealthStatus":"Healthy"}],"VirtualDisks":[],"PhysicalDisks":[],"Warnings":[]}`), map[string]string{})
	if e != nil || r.Complete {
		t.Fatalf("%+v %v", r, e)
	}
	for _, c := range r.Components {
		if c.ComponentType == "enclosure" {
			t.Fatal("invented pool identity", c)
		}
	}
}

// Real Get-PhysicalDisk output from a two-member mirror on Windows Server 2022
// (#6895): while a pool member is in Lost Communication, Windows replaces its
// UniqueId with the pool-member GUID, but the ObjectId's PD:{guid} segment is
// the same in every state. The missing member must land on its original key.
func TestSpacesLostCommunicationKeepsMemberKey(t *testing.T) {
	ck := "storage_spaces:ctrl"
	keyA := slotKey(ck, "-", objectHash("60022480B4C7526392E9530DABDCE67F"))
	keyB := slotKey(ck, "-", objectHash("60022480CFCA9CD7995F7E79FEF2B2F9"))
	vdKey := "storage_spaces:vd:" + objectHash(`{1}\\HOST\root/Microsoft/Windows/Storage/Providers_v2\SPACES_VirtualDisk.ObjectId="{51d89d4d-36bf-11f1-97ce-806e6f6e6963}:VD:{58685b05-2d13-47d9-92b8-15c62d6c1bc6}{4b23193e-6843-4c72-87f2-88f346cc0a38}"`)
	remembered := map[string]string{}
	for _, tc := range []struct {
		state, vdState string
		wantB          string
	}{
		{"healthy", "optimal", "online"},
		{"missing", "degraded", "missing"},
		{"recovered", "optimal", "online"},
	} {
		r, e := parseSpaces(fixture(t, "storage_spaces", "lab-6895-"+tc.state+".json"), remembered)
		if e != nil || !r.Complete {
			t.Fatalf("%s: %+v %v", tc.state, r, e)
		}
		disks := map[string]Component{}
		for _, c := range r.Components {
			if c.ComponentType == "physical_disk" {
				disks[c.ComponentKey] = c
			}
		}
		if len(disks) != 2 {
			t.Fatalf("%s: want exactly the two member keys, got %v", tc.state, disks)
		}
		if disks[keyA].State != "online" || disks[keyB].State != tc.wantB {
			t.Fatalf("%s: A=%+v B=%+v", tc.state, disks[keyA], disks[keyB])
		}
		v := findComponent(t, r.Components, vdKey)
		if v.State != tc.vdState {
			t.Fatalf("%s: vd %+v", tc.state, v)
		}
		members, _ := v.Attributes["memberKeys"].([]string)
		if len(members) != 2 || members[0] != keyA || members[1] != keyB {
			t.Fatalf("%s: memberKeys %v", tc.state, members)
		}
	}
}

// Without a remembered identity (first run after install, or quarantined state)
// the stand-in keeps the pre-#6895 behaviour: keyed by the UniqueId it reports.
func TestSpacesLostCommunicationWithoutMemory(t *testing.T) {
	remembered := map[string]string{}
	r, e := parseSpaces(fixture(t, "storage_spaces", "lab-6895-missing.json"), remembered)
	if e != nil {
		t.Fatal(e)
	}
	c := findComponent(t, r.Components, slotKey("storage_spaces:ctrl", "-", objectHash("{97978214-4542-a5b2-308f-43ed169c97b9}")))
	if c.State != "missing" {
		t.Fatal(c)
	}
	if _, ok := remembered["{97978214-4542-a5b2-308f-43ed169c97b9}"]; ok {
		t.Fatal("stand-in identity must not be remembered as the member's key")
	}
}

func TestSpacesMemberMemoryPrunesDepartedMembers(t *testing.T) {
	remembered := map[string]string{"{00000000-0000-0000-0000-000000000000}": "gone"}
	if _, e := parseSpaces(fixture(t, "storage_spaces", "lab-6895-healthy.json"), remembered); e != nil {
		t.Fatal(e)
	}
	if len(remembered) != 2 || remembered["{00000000-0000-0000-0000-000000000000}"] != "" {
		t.Fatalf("%v", remembered)
	}
}
