package hwhealth

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestStorcliCommands(t *testing.T) {
	calls := []string{}
	s := newStorcli("perccli", nil, func(_ context.Context, d time.Duration, p string, args ...string) (execResult, error) {
		calls = append(calls, strings.Join(args, " "))
		if d != 30*time.Second {
			t.Fatal(d)
		}
		if len(calls) == 3 {
			return execResult{}, errors.New("timeout")
		}
		if len(calls) > 5 {
			return execResult{Stdout: []byte(`{"Controllers":[{"Command Status":{"Controller":0,"Status":"Success"},"Response Data":{"Progress":[{"EID:Slt":"252:0","Progress%":42}]}}]}`)}, nil
		}
		return execResult{Stdout: fixture(t, "perccli", "optimal.json")}, nil
	})
	r, e := s.Collect(context.Background(), Availability{Path: "tool", Available: true})
	if e != nil || r.Complete || len(r.Components) == 0 || len(calls) != 8 {
		t.Fatalf("%+v %v %v", r, e, calls)
	}
	want := []string{"/call show all J", "/call/vall show all J", "/call/eall/sall show all J", "/call/cv show all J", "/call/bbu show all J", "/call/eall/sall show rebuild J", "/call/vall show init J", "/call/vall show cc J"}
	for i, w := range want {
		if calls[i] != w {
			t.Fatal(calls)
		}
	}
	c := findComponent(t, r.Components, "perccli:c0:e252:s0")
	if c.ProgressPercent == nil || *c.ProgressPercent != 42 {
		t.Fatal(c)
	}
}

func TestStorcliRequiredCommandSections(t *testing.T) {
	for _, kind := range []Kind{"storcli", "perccli"} {
		for _, bad := range []int{-1, 0, 1, 2} {
			t.Run(string(kind)+"/"+string(rune('A'+bad+1)), func(t *testing.T) {
				call := 0
				src := newStorcli(kind, nil, func(context.Context, time.Duration, string, ...string) (execResult, error) {
					i := call
					call++
					if i >= 5 {
						return execResult{Stdout: []byte(`{"Controllers":[]}`)}, nil
					}
					var doc map[string]any
					if e := json.Unmarshal(fixture(t, string(kind), "optimal.json"), &doc); e != nil {
						t.Fatal(e)
					}
					ctl := doc["Controllers"].([]any)[0].(map[string]any)
					data := ctl["Response Data"].(map[string]any)
					switch i {
					case 1:
						ctl["Response Data"] = map[string]any{"VD LIST": data["VD LIST"]}
					case 2:
						ctl["Response Data"] = map[string]any{"PD LIST": data["PD LIST"]}
					case 3:
						ctl["Response Data"] = map[string]any{"Cachevault_Info": data["Cachevault_Info"]}
					case 4:
						ctl["Response Data"] = map[string]any{"BBU_Info": []any{map[string]any{"State": "Optimal"}}}
					}
					if i == bad {
						if i == 0 {
							delete(ctl, "Response Data")
						} else {
							ctl["Response Data"] = map[string]any{}
						}
					}
					b, e := json.Marshal(doc)
					if e != nil {
						t.Fatal(e)
					}
					return execResult{Stdout: b}, nil
				})
				r, e := src.Collect(context.Background(), Availability{Available: true, Path: "fixture"})
				if e != nil || r.Complete != (bad == -1) || call != 8 {
					t.Fatalf("%+v %v calls=%d", r, e, call)
				}
				findComponent(t, r.Components, string(kind)+":c0:e252:s0")
				findComponent(t, r.Components, string(kind)+":c0:v0")
			})
		}
	}
}

func TestStorcliSplitMembershipAndProgressFailure(t *testing.T) {
	replies := []string{
		`{"Controllers":[{"Command Status":{"Controller":0,"Status":"Success"},"Response Data":{"Status":{"Controller Status":"Optimal"}}}]}`,
		`{"Controllers":[{"Command Status":{"Controller":0,"Status":"Success"},"Response Data":{"VD LIST":[{"DG/VD":"0/0","State":"Optl"}]}}]}`,
		`{"Controllers":[{"Command Status":{"Controller":0,"Status":"Success"},"Response Data":{"PD LIST":[{"EID:Slt":"1:2","DG":0,"State":"Onln"}]}}]}`,
		`{"Controllers":[{"Command Status":{"Controller":0,"Status":"Success"},"Response Data":{"Cachevault_Info":[{"Present":false}]}}]}`,
		`{"Controllers":[]}`, "",
		`{"Controllers":[{"Command Status":{"Controller":0,"Status":"Success"},"Response Data":{"Progress":[{"VD":0,"Progress%":23}]}}]}`,
		`{"Controllers":[]}`,
	}
	call := 0
	src := newStorcli("storcli", nil, func(context.Context, time.Duration, string, ...string) (execResult, error) {
		i := call
		call++
		if i == 5 {
			return execResult{}, errors.New("rebuild query failed")
		}
		return execResult{Stdout: []byte(replies[i])}, nil
	})
	r, e := src.Collect(context.Background(), Availability{Available: true, Path: "fixture"})
	if e != nil || r.Complete {
		t.Fatalf("%+v %v", r, e)
	}
	vd := findComponent(t, r.Components, "storcli:c0:v0")
	if vd.State != "initializing" || vd.ProgressPercent == nil || *vd.ProgressPercent != 23 {
		t.Fatal(vd)
	}
	keys, ok := vd.Attributes["memberKeys"].([]string)
	if !ok || len(keys) != 1 || keys[0] != "storcli:c0:e1:s2" {
		t.Fatal(vd.Attributes)
	}
	if findComponent(t, r.Components, "storcli:c0:cv").State != "missing" {
		t.Fatal("confirmed absent cache battery lost")
	}
}

func TestStorcliProgressIdentity(t *testing.T) {
	cases := []struct {
		name       string
		controller any
		row        map[string]any
		valid      bool
		pd         bool
	}{
		{"missing-controller", nil, map[string]any{"VD": 0}, false, false},
		{"string-controller", "0", map[string]any{"VD": 0}, false, false},
		{"negative-controller", -1, map[string]any{"VD": 0}, false, false},
		{"fractional-controller", 0.5, map[string]any{"VD": 0}, false, false},
		{"missing-vd", 0, map[string]any{}, false, false},
		{"null-vd", 0, map[string]any{"VD": nil}, false, false},
		{"negative-vd", 0, map[string]any{"VD": -1}, false, false},
		{"fractional-vd", 0, map[string]any{"VD": 0.5}, false, false},
		{"object-vd", 0, map[string]any{"VD": map[string]any{}}, false, false},
		{"cross-controller-vd", 0, map[string]any{"VD": "/c1/v0"}, false, false},
		{"conflicting-vd", 0, map[string]any{"VD": 0, "VD ID": 1}, false, false},
		{"unobserved-vd", 0, map[string]any{"VD": 1}, false, false},
		{"missing-slot", 0, map[string]any{"EID:Slt": "252:"}, false, true},
		{"text-slot", 0, map[string]any{"EID:Slt": "252:slot"}, false, true},
		{"cross-controller-drive", 0, map[string]any{"Drive-ID": "/c1/e252/s0"}, false, true},
		{"invalid-drive-fallback", 0, map[string]any{"Drive-ID": "bad", "EID:Slt": "252:0"}, false, true},
		{"conflicting-drive", 0, map[string]any{"Drive-ID": "/c0/e252/s1", "EID:Slt": "252:0"}, false, true},
		{"valid-vd-zero", 0, map[string]any{"VD": 0}, true, false},
		{"valid-vd-path", 0, map[string]any{"VD ID": "/c0/v0"}, true, false},
		{"valid-slot", 0, map[string]any{"EID:Slt": "252:0"}, true, true},
		{"valid-drive", 0, map[string]any{"Drive-ID": "/c0/e252/s0"}, true, true},
	}
	for _, kind := range []Kind{"storcli", "perccli"} {
		for _, operation := range []int{1, 2} {
			for _, tc := range cases {
				t.Run(string(kind)+"/"+tc.name+"/"+string(rune('0'+operation)), func(t *testing.T) {
					r, e := parseStorcli(fixture(t, string(kind), "multi-controller.json"), kind)
					if e != nil {
						t.Fatal(e)
					}
					status := map[string]any{"Status": "Success"}
					if tc.controller != nil {
						status["Controller"] = tc.controller
					}
					row := map[string]any{"Progress%": 23}
					for k, v := range tc.row {
						row[k] = v
					}
					// Keep a valid sibling AFTER the bad controller to prove parsing continues on errors.
					controllers := []any{
						map[string]any{"Command Status": status, "Response Data": map[string]any{"Progress": []any{row}}},
						map[string]any{"Command Status": map[string]any{"Controller": 1, "Status": "Success"}, "Response Data": map[string]any{"Progress": []any{map[string]any{"VD": 0, "Progress%": 61}}}},
					}
					b, e := json.Marshal(map[string]any{"Controllers": controllers})
					if e != nil {
						t.Fatal(e)
					}
					e = applyStorcliProgress(b, kind, &r, operation)
					if (e == nil) != tc.valid || r.Complete != tc.valid {
						t.Fatalf("valid=%v result=%+v error=%v", tc.valid, r, e)
					}
					key := string(kind) + ":c0:v0"
					wantState := "optimal"
					if tc.pd {
						key = string(kind) + ":c0:e252:s0"
						wantState = "online"
					}
					if tc.valid && !tc.pd {
						wantState = "initializing"
						if operation == 2 {
							wantState = "checking"
						}
					}
					c := findComponent(t, r.Components, key)
					if c.State != wantState || (c.ProgressPercent != nil) != tc.valid {
						t.Fatal(c)
					}
					if tc.valid && *c.ProgressPercent != 23 {
						t.Fatal(c)
					}
					sibling := findComponent(t, r.Components, string(kind)+":c1:v0")
					if sibling.ProgressPercent == nil || *sibling.ProgressPercent != 61 {
						t.Fatal("valid sibling lost", sibling)
					}
				})
			}
		}
	}
}

func TestStorcliProgressTargetIdentity(t *testing.T) {
	for _, bad := range []string{"source", "type", "parent", "missing-parent"} {
		t.Run(bad, func(t *testing.T) {
			c := component("storcli", "virtual_disk", "storcli:c0:v0", "storcli:c0", "VD", "Optl", "optimal")
			switch bad {
			case "source":
				c.Source = "perccli"
			case "type":
				c.ComponentType = "physical_disk"
			case "parent":
				c.ParentKey = ptr("storcli:c1")
			case "missing-parent":
				c.ParentKey = nil
			}
			r := Result{Complete: true, Components: []Component{c}}
			b := []byte(`{"Controllers":[{"Command Status":{"Controller":0,"Status":"Success"},"Response Data":{"Progress":[{"VD":0,"Progress%":23}]}}]}`)
			if e := applyStorcliProgress(b, "storcli", &r, 1); e == nil || r.Complete {
				t.Fatal("mismatched target accepted", r, e)
			}
			if r.Components[0].State != "optimal" || r.Components[0].ProgressPercent != nil {
				t.Fatal("mismatched target changed", r.Components[0])
			}
		})
	}
}

func TestStorcliProgressMalformedResponseAndPath(t *testing.T) {
	for _, data := range []any{42, []any{}, nil, map[string]any{"Drive /c1/e252/s0": map[string]any{"Progress%": 23}}} {
		r, e := parseStorcli(fixture(t, "storcli", "multi-controller.json"), "storcli")
		if e != nil {
			t.Fatal(e)
		}
		doc := map[string]any{"Controllers": []any{
			map[string]any{"Command Status": map[string]any{"Controller": 0, "Status": "Success"}, "Response Data": data},
			map[string]any{"Command Status": map[string]any{"Controller": 1, "Status": "Success"}, "Response Data": map[string]any{"Drive /c1/e252/s0": map[string]any{"Progress%": 61}}},
		}}
		b, e := json.Marshal(doc)
		if e != nil {
			t.Fatal(e)
		}
		if e = applyStorcliProgress(b, "storcli", &r, 0); e == nil || r.Complete {
			t.Fatal("invalid identity accepted", r, e)
		}
		if findComponent(t, r.Components, "storcli:c0:e252:s0").ProgressPercent != nil {
			t.Fatal("wrong controller changed")
		}
		c := findComponent(t, r.Components, "storcli:c1:e252:s0")
		if c.ProgressPercent == nil || *c.ProgressPercent != 61 {
			t.Fatal(c)
		}
	}
}
