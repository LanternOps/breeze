package hwhealth

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func fixture(t *testing.T, source, name string) []byte {
	t.Helper()
	b, e := os.ReadFile(filepath.Join("testdata", source, name))
	if e != nil {
		t.Fatal(e)
	}
	return b
}

func findComponent(t *testing.T, cs []Component, key string) Component {
	t.Helper()
	for _, c := range cs {
		if c.ComponentKey == key {
			return c
		}
	}
	t.Fatalf("missing %s in %+v", key, cs)
	return Component{}
}

func TestStorcliFixtures(t *testing.T) {
	for _, kind := range []Kind{"storcli", "perccli"} {
		for _, name := range []string{"optimal", "degraded", "failed", "rebuilding-with-progress", "predictive", "missing-member", "multi-controller", "unrecognized-state", "truncated", "64-drive"} {
			t.Run(string(kind)+"/"+name, func(t *testing.T) {
				b := fixture(t, string(kind), name+".json")
				r, e := parseStorcli(b, kind)
				if name == "truncated" {
					if e == nil {
						t.Fatal("truncated accepted")
					}
					return
				}
				if e != nil || !r.Complete {
					t.Fatalf("%+v %v", r, e)
				}
				c := findComponent(t, r.Components, string(kind)+":c0:e252:s0")
				if c.Source != kind {
					t.Fatal(c)
				}
				switch name {
				case "degraded":
					if findComponent(t, r.Components, string(kind)+":c0:v0").State != "degraded" {
						t.Fatal(r)
					}
				case "failed":
					if c.State != "failed" {
						t.Fatal(c)
					}
				case "predictive":
					if !c.PredictiveFailure {
						t.Fatal(c)
					}
				case "missing-member":
					if c.State != "missing" {
						t.Fatal(c)
					}
				case "unrecognized-state":
					v := findComponent(t, r.Components, string(kind)+":c0:v0")
					if v.State != "unknown" || *v.StateDetail != "NewVendorState" {
						t.Fatal(v)
					}
				case "multi-controller":
					findComponent(t, r.Components, string(kind)+":c1")
				case "rebuilding-with-progress":
					if c.ProgressPercent == nil || *c.ProgressPercent != 42 {
						t.Fatal(c)
					}
				case "64-drive":
					n := 0
					for _, p := range r.Components {
						if p.ComponentType == "physical_disk" {
							n++
						}
					}
					if n != 64 || len(b) < 1000000 {
						t.Fatalf("drives=%d bytes=%d", n, len(b))
					}
				}
			})
		}
	}
}

func TestStorcliIncompleteObservations(t *testing.T) {
	for _, kind := range []Kind{"storcli", "perccli"} {
		for _, bad := range []string{"response", "pd-list", "vd-list", "null-list", "wrong-list", "pd-row", "pd-missing-id", "pd-id", "pd-empty-slot", "pd-text-slot", "vd-id", "controller-id"} {
			t.Run(string(kind)+"/"+bad, func(t *testing.T) {
				var doc map[string]any
				if e := json.Unmarshal(fixture(t, string(kind), "multi-controller.json"), &doc); e != nil {
					t.Fatal(e)
				}
				ctl := doc["Controllers"].([]any)[0].(map[string]any)
				data := ctl["Response Data"].(map[string]any)
				pd := data["PD LIST"].([]any)[0].(map[string]any)
				switch bad {
				case "response":
					delete(ctl, "Response Data")
				case "pd-list":
					delete(data, "PD LIST")
				case "vd-list":
					delete(data, "VD LIST")
				case "null-list":
					data["PD LIST"] = nil
				case "wrong-list":
					data["PD LIST"] = map[string]any{}
				case "pd-row":
					data["PD LIST"] = []any{"invalid"}
				case "pd-missing-id":
					delete(pd, "EID:Slt")
				case "pd-id":
					pd["EID:Slt"] = "unparseable"
				case "pd-empty-slot":
					pd["EID:Slt"] = "252:"
				case "pd-text-slot":
					pd["EID:Slt"] = "252:slot"
				case "vd-id":
					data["VD LIST"].([]any)[0].(map[string]any)["DG/VD"] = "0/"
				case "controller-id":
					delete(ctl["Command Status"].(map[string]any), "Controller")
				}
				b, e := json.Marshal(doc)
				if e != nil {
					t.Fatal(e)
				}
				r, e := parseStorcli(b, kind)
				if e != nil || r.Complete || len(r.Warnings) == 0 {
					t.Fatalf("result=%+v error=%v", r, e)
				}
				findComponent(t, r.Components, string(kind)+":c1:e252:s0")
				if bad != "response" && bad != "controller-id" {
					findComponent(t, r.Components, string(kind)+":c0")
				}
			})
		}
	}
}

func TestStorcliMalformedControllerSiblings(t *testing.T) {
	for _, kind := range []Kind{"storcli", "perccli"} {
		for _, bad := range []string{"string-id", "fractional-id", "negative-id", "null-id", "status-scalar", "response-scalar", "response-array", "controller-scalar"} {
			for _, badIndex := range []int{0, 1} {
				t.Run(string(kind)+"/"+bad+"/"+string(rune('0'+badIndex)), func(t *testing.T) {
					var doc map[string]any
					if e := json.Unmarshal(fixture(t, string(kind), "multi-controller.json"), &doc); e != nil {
						t.Fatal(e)
					}
					controllers := doc["Controllers"].([]any)
					ctl := controllers[badIndex].(map[string]any)
					status := ctl["Command Status"].(map[string]any)
					switch bad {
					case "string-id":
						status["Controller"] = "0"
					case "fractional-id":
						status["Controller"] = 0.5
					case "negative-id":
						status["Controller"] = -1
					case "null-id":
						status["Controller"] = nil
					case "status-scalar":
						ctl["Command Status"] = true
					case "response-scalar":
						ctl["Response Data"] = 42
					case "response-array":
						ctl["Response Data"] = []any{}
					case "controller-scalar":
						controllers[badIndex] = "bad"
					}
					b, e := json.Marshal(doc)
					if e != nil {
						t.Fatal(e)
					}
					r, e := parseStorcli(b, kind)
					if e != nil || r.Complete || len(r.Warnings) == 0 {
						t.Fatalf("result=%+v error=%v", r, e)
					}
					valid := string(kind) + ":c" + string(rune('0'+1-badIndex))
					findComponent(t, r.Components, valid)
					findComponent(t, r.Components, valid+":v0")
					findComponent(t, r.Components, valid+":e252:s0")
					for _, c := range r.Components {
						if c.ComponentKey == string(kind)+":c"+string(rune('0'+badIndex)) {
							t.Fatal("invalid controller emitted", c)
						}
					}
				})
			}
		}
	}
}

func TestStorcliBatterySections(t *testing.T) {
	cases := []struct {
		name     string
		value    any
		complete bool
		state    string
	}{
		{"empty-record", []any{map[string]any{}}, false, ""},
		{"null-section", nil, false, ""},
		{"object-section", map[string]any{"State": "Failed"}, false, ""},
		{"scalar-section", "bad", false, ""},
		{"null-row", []any{nil}, false, ""},
		{"scalar-row", []any{"Failed"}, false, ""},
		{"null-state", []any{map[string]any{"State": nil}}, false, ""},
		{"numeric-state", []any{map[string]any{"State": 0}}, false, ""},
		{"present-only", []any{map[string]any{"Present": true}}, false, ""},
		{"wrong-present", []any{map[string]any{"Present": "false", "State": "Failed"}}, false, ""},
		{"mixed", []any{map[string]any{"State": "Failed"}, map[string]any{}}, false, "failed"},
		{"empty-list", []any{}, true, ""},
		{"absent", []any{map[string]any{"Present": false}}, true, "missing"},
		{"empty-state", []any{map[string]any{"State": ""}}, true, "missing"},
		{"failed", []any{map[string]any{"State": "Failed"}}, true, "failed"},
		{"unknown-state", []any{map[string]any{"State": "NewVendorState"}}, true, "unknown"},
	}
	for _, kind := range []Kind{"storcli", "perccli"} {
		for section, suffix := range map[string]string{"Cachevault_Info": "cv", "BBU_Info": "bbu"} {
			for _, tc := range cases {
				t.Run(string(kind)+"/"+section+"/"+tc.name, func(t *testing.T) {
					var doc map[string]any
					if e := json.Unmarshal(fixture(t, string(kind), "optimal.json"), &doc); e != nil {
						t.Fatal(e)
					}
					data := doc["Controllers"].([]any)[0].(map[string]any)["Response Data"].(map[string]any)
					delete(data, "Cachevault_Info")
					data[section] = tc.value
					b, e := json.Marshal(doc)
					if e != nil {
						t.Fatal(e)
					}
					r, e := parseStorcliSections(b, kind, "PD LIST", "VD LIST", section)
					if e != nil || r.Complete != tc.complete || (!tc.complete && len(r.Warnings) == 0) {
						t.Fatalf("result=%+v error=%v", r, e)
					}
					findComponent(t, r.Components, string(kind)+":c0:e252:s0")
					key := string(kind) + ":c0:" + suffix
					found := false
					for _, c := range r.Components {
						if c.ComponentKey == key {
							found = true
							if c.State != tc.state {
								t.Fatal(c)
							}
						}
					}
					if found != (tc.state != "") {
						t.Fatal("malformed battery emitted or valid battery lost", r)
					}
				})
			}
		}
	}
}

func TestStorcliExplicitEmptyLists(t *testing.T) {
	r, e := parseStorcli([]byte(`{"Controllers":[{"Command Status":{"Controller":0,"Status":"Success"},"Response Data":{"Status":{"Controller Status":"Optimal"},"PD LIST":[],"VD LIST":[]}}]}`), "storcli")
	if e != nil || !r.Complete || len(r.Components) != 1 {
		t.Fatalf("%+v %v", r, e)
	}
}

func TestStorcliMapping(t *testing.T) {
	for typ, rows := range map[ComponentType]map[string]string{
		"virtual_disk":  {"Optl": "optimal", "Dgrd": "degraded", "Pdgd": "partially_degraded", "OfLn": "offline", "Rec": "rebuilding"},
		"physical_disk": {"Onln": "online", "GHS": "hotspare", "DHS": "hotspare", "UGood": "ready", "UBad": "failed", "Rbld": "rebuilding", "CpyBck": "copyback", "JBOD": "jbod", "Offln": "offline", "Msng": "missing", "UGShld": "shielded", "UGUnsp": "unknown"},
		"cache_battery": {"Optimal": "ok", "Learning": "learning", "Learn cycle active": "learning", "Charging": "charging", "Degraded": "degraded", "Needs Attention": "degraded", "Failed": "failed", "": "missing"},
		"controller":    {"Optimal": "ok", "Needs Attention": "degraded", "Failed": "failed"},
	} {
		for raw, want := range rows {
			if got := vendorState(typ, raw); got != want {
				t.Fatalf("%s %s=%s want %s", typ, raw, got, want)
			}
		}
	}
}
