package hwhealth

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSequenceAndCachePersistence(t *testing.T) {
	dir := t.TempDir()
	s := diskState{MDMembers: map[string]string{"md0/0": "ata-S1"}, Next: "smartctl"}
	if e := reserveSequence(dir, &s); e != nil {
		t.Fatal(e)
	}
	var restored diskState
	if e := readJSON(filepath.Join(dir, "hwhealth_state.json"), &restored); e != nil {
		t.Fatal(e)
	}
	if restored.Sequence != 1 || restored.Next != "smartctl" || restored.MDMembers["md0/0"] != "ata-S1" {
		t.Fatal(restored)
	}
	if e := reserveSequence(dir, &restored); e != nil || restored.Sequence != 2 {
		t.Fatal(e)
	}
	cache := map[string]smartCacheEntry{"S": {ObservedAt: time.Unix(100, 0), Component: Component{ComponentKey: "smart:S", Serial: ptr("S"), Attributes: map[string]any{}}}}
	p := filepath.Join(dir, "hwhealth_smart_cache.json")
	if e := writeJSON(p, cache); e != nil {
		t.Fatal(e)
	}
	var got map[string]smartCacheEntry
	if e := readJSON(p, &got); e != nil || len(got) != 1 {
		t.Fatal(e)
	}
	if _, e := os.Stat(p + ".tmp"); !os.IsNotExist(e) {
		t.Fatal("temp stranded")
	}
}

func TestVendorTopologyPersistence(t *testing.T) {
	dir := t.TempDir()
	now := time.Unix(1000, 0)
	state := diskState{VendorTopology: vendorTopology{
		"storcli:c0:v0":    {Source: "storcli", Type: "virtual_disk", Serial: "VD-S", Model: "PERC volume", ObservedAt: now},
		"storcli:c0:e1:s1": {Source: "storcli", Type: "physical_disk", Serial: "PD-S", Model: "physical model", ObservedAt: now},
	}}
	if e := reserveSequence(dir, &state); e != nil {
		t.Fatal(e)
	}
	var got diskState
	if e := readJSON(filepath.Join(dir, "hwhealth_state.json"), &got); e != nil {
		t.Fatal(e)
	}
	if len(got.VendorTopology) != 2 {
		t.Fatal(got)
	}
	for key, want := range state.VendorTopology {
		have := got.VendorTopology[key]
		if have.Source != want.Source || have.Type != want.Type || have.Serial != want.Serial || have.Model != want.Model || !have.ObservedAt.Equal(want.ObservedAt) {
			t.Fatal(key, have)
		}
	}
}

func TestSequenceFailureDoesNotPublish(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "file")
	if e := os.WriteFile(p, []byte("x"), 0600); e != nil {
		t.Fatal(e)
	}
	s := diskState{Sequence: 12}
	if e := reserveSequence(p, &s); e == nil || s.Sequence != 12 {
		t.Fatalf("state=%+v error=%v", s, e)
	}
}
