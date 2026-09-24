package hwhealth

import "testing"

func TestMDFixtures(t *testing.T) {
	for _, name := range []string{"optimal", "degraded", "failed", "rebuilding-with-progress", "predictive", "missing-member", "multi-controller", "unrecognized-state", "truncated"} {
		t.Run(name, func(t *testing.T) {
			r, e := parseMD("md0", string(fixture(t, "mdadm", name+".mdstat.txt")), string(fixture(t, "mdadm", name+".detail.txt")), func(string) string { return "ata-S1-part1" }, map[string]string{"md0/0": "ata-S1-part1"})
			if name == "truncated" {
				if e == nil {
					t.Fatal("accepted truncation")
				}
				return
			}
			if e != nil {
				t.Fatal(e)
			}
			v := findComponent(t, r.Components, "mdadm:md0")
			p := findComponent(t, r.Components, "mdadm:md0:m:ata-S1-part1")
			want := map[string]string{"degraded": "degraded", "failed": "failed", "rebuilding-with-progress": "rebuilding", "unrecognized-state": "unknown"}[name]
			if want == "" {
				want = "optimal"
			}
			if v.State != want {
				t.Fatal(v)
			}
			if name == "rebuilding-with-progress" && (v.ProgressPercent == nil || *v.ProgressPercent != 42) {
				t.Fatal(v)
			}
			if name == "missing-member" && p.State != "missing" {
				t.Fatal(p)
			}
			if name == "predictive" && p.PredictiveFailure {
				t.Fatal("mdadm must not invent prediction")
			}
		})
	}
}

func TestMDUnidentifiedRemovedMember(t *testing.T) {
	r, e := parseMD("md0", string(fixture(t, "mdadm", "missing-member.mdstat.txt")), string(fixture(t, "mdadm", "missing-member.detail.txt")), func(string) string { return "" }, map[string]string{})
	if e != nil || r.Complete {
		t.Fatalf("%+v %v", r, e)
	}
}

func TestMDMappings(t *testing.T) {
	for raw, want := range map[string]string{"clean": "optimal", "active": "optimal", "clean, degraded": "degraded", "recovering": "rebuilding", "resyncing": "rebuilding", "checking": "checking", "reshaping": "migrating", "inactive": "failed", "new": "unknown"} {
		if mdArrayState(raw) != want {
			t.Fatal(raw)
		}
	}
	for raw, want := range map[string]string{"active sync": "online", "faulty": "failed", "spare": "hotspare", "spare rebuilding": "rebuilding", "removed": "missing", "writemostly": "online", "new": "unknown"} {
		if mdMemberState(raw) != want {
			t.Fatal(raw)
		}
	}
}

func TestMDSpareWithoutRaidRole(t *testing.T) {
	detail := "/dev/md0:\n State : clean\n Number Major Minor RaidDevice State\n 2 8 3 - spare /dev/sdc1\n"
	r, e := parseMD("md0", "md0 : active raid1\n", detail, func(string) string { return "ata-SPARE" }, map[string]string{})
	if e != nil || !r.Complete {
		t.Fatalf("%+v %v", r, e)
	}
	if findComponent(t, r.Components, "mdadm:md0:m:ata-SPARE").State != "hotspare" {
		t.Fatal(r)
	}
}
