package hwhealth

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestMergeRules(t *testing.T) {
	now := time.Unix(1000, 0)
	vendor := component("storcli", "physical_disk", "storcli:c0:e1:s1", "storcli:c0", "slot", "Onln", "online")
	vendor.Serial = ptr("S")
	smart := component("smartctl", "physical_disk", "smart:S", "", "disk", "SMART", "predictive_failure")
	smart.Serial = ptr("S")
	smart.PredictiveFailure = true
	smart.SmartPassed = ptr(false)
	smart.TemperatureC = ptr(42)
	smart.Attributes["smart"] = map[string]any{"observedAt": now.Format(time.RFC3339Nano)}

	cache := map[string]smartCacheEntry{}
	rows := merge([]Component{vendor, smart}, cache, now, time.Hour)
	if len(rows) != 1 || !rows[0].PredictiveFailure || rows[0].SmartPassed == nil || *rows[0].SmartPassed {
		t.Fatal(rows)
	}
	replay := merge([]Component{vendor}, cache, now.Add(time.Hour), time.Hour)
	if !replay[0].PredictiveFailure {
		t.Fatal("SMART lost on RAID tier")
	}
	expired := merge([]Component{vendor}, cache, now.Add(2*time.Hour), time.Hour)
	b, _ := json.Marshal(expired[0])
	if expired[0].PredictiveFailure || !strings.Contains(string(b), `"smartPassed":null`) || !strings.Contains(string(b), `"temperatureC":null`) {
		t.Fatal(string(b))
	}
	for _, serial := range []string{"", "S"} {
		v2 := vendor
		v2.ComponentKey += "2"
		v2.Serial = ptr(serial)
		v1 := vendor
		v1.Serial = ptr(serial)
		s := smart
		s.Serial = ptr(serial)
		got := merge([]Component{v1, v2, s}, map[string]smartCacheEntry{}, now, time.Hour)
		if len(got) != 3 {
			t.Fatal("ambiguous merge", got)
		}
	}
	s2 := smart
	s2.ComponentKey = "smart:dev:sat:/dev/second"
	if got := merge([]Component{vendor, smart, s2}, map[string]smartCacheEntry{}, now, time.Hour); len(got) != 3 {
		t.Fatal("duplicate smart serial merged")
	}
	win := component("windows_physical_disk", "physical_disk", "winpd:1", "", "disk", "OK", "online")
	win.Serial = ptr("S")
	if got := merge([]Component{vendor, win}, map[string]smartCacheEntry{}, now, time.Hour); len(got) != 1 {
		t.Fatal(got)
	}
	vd := component("storcli", "virtual_disk", "storcli:c0:v0", "storcli:c0", "VD", "Optl", "optimal")
	for _, model := range []string{"PERC H730", "LOGICAL VOLUME", "Virtual Disk", "MR9361", "Smart Array", "raid volume"} {
		win.Model = ptr(model)
		win.Serial = ptr("")
		got := merge([]Component{vd, win}, map[string]smartCacheEntry{}, now, time.Hour)
		if !got[1].AlertExempt || got[1].Attributes["backedByVd"] != true {
			t.Fatal(model)
		}
		got = merge([]Component{win}, map[string]smartCacheEntry{}, now, time.Hour)
		if got[0].AlertExempt {
			t.Fatal("no VD present")
		}
	}
}

func TestWindowsTopologyAcrossTiers(t *testing.T) {
	now := time.Unix(1000, 0)
	interval := 10 * time.Minute
	vd := component("storcli", "virtual_disk", "storcli:c0:v0", "", "VD", "Optl", "optimal")
	vd.Serial = ptr("VD-S")
	vd.Model = ptr("PERC volume")
	pd := component("storcli", "physical_disk", "storcli:c0:e1:s1", "", "PD", "Onln", "online")
	pd.Serial = ptr("PD-S")
	pd.Model = ptr("physical model")
	topology := updateVendorTopology(nil, []Component{vd, pd}, nil, now, interval)
	win := component("windows_physical_disk", "physical_disk", "winpd:1", "", "disk", "OK", "online")
	win.Model = ptr("PERC volume")
	for _, age := range []time.Duration{time.Minute, 2*interval - time.Nanosecond, 2 * interval} {
		fresh := updateVendorTopology(topology, nil, nil, now.Add(age), interval)
		got := merge([]Component{win}, map[string]smartCacheEntry{}, now.Add(age), time.Hour, fresh)
		if len(got) != 1 || got[0].AlertExempt != (age < 2*interval) {
			t.Fatal(age, got)
		}
	}
	for _, status := range []SourceStatus{"failed", "backing_off", "superseded", "disabled", "unavailable", "ok"} {
		got := updateVendorTopology(topology, nil, []SourceReport{{Source: "storcli", Status: status, Complete: ptr(false)}}, now.Add(time.Minute), interval)
		if len(got) != 2 || !got[pd.ComponentKey].ObservedAt.Equal(now) {
			t.Fatal(status, got)
		}
	}
	partial := updateVendorTopology(topology, []Component{pd}, []SourceReport{{Source: "storcli", Status: "ok", Complete: ptr(false)}}, now.Add(time.Minute), interval)
	if !partial[vd.ComponentKey].ObservedAt.Equal(now) || !partial[pd.ComponentKey].ObservedAt.Equal(now.Add(time.Minute)) {
		t.Fatal(partial)
	}
	win.Serial = ptr("PD-S")
	if got := merge([]Component{win}, map[string]smartCacheEntry{}, now, time.Hour, topology); len(got) != 0 {
		t.Fatal("cached PD was duplicated", got)
	}
	duplicate := pd
	duplicate.ComponentKey += "2"
	ambiguous := updateVendorTopology(topology, []Component{duplicate}, nil, now, interval)
	if got := merge([]Component{win}, map[string]smartCacheEntry{}, now, time.Hour, ambiguous); len(got) != 1 {
		t.Fatal("ambiguous serial dropped", got)
	}
	cleared := updateVendorTopology(topology, nil, []SourceReport{{Source: "storcli", Status: "ok", Complete: ptr(true)}}, now.Add(time.Minute), interval)
	if len(cleared) != 0 {
		t.Fatal("complete empty inventory did not replace topology", cleared)
	}
	if got := updateVendorTopology(topology, nil, nil, now.Add(-time.Second), interval); len(got) != 0 {
		t.Fatal("future evidence retained", got)
	}
}
