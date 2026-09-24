package hwhealth

import (
	"reflect"
	"strings"
	"testing"
)

func TestARCCONF(t *testing.T) {
	s := newARCCONF(nil)
	outputs := fixtureOutputs(t, "arcconf/optimal.txt", [][]string{{"GETVERSION"}, {"GETCONFIG", "1", "AL"}})
	if got := s.expand(outputs[:1]); !reflect.DeepEqual(got, [][]string{{"GETCONFIG", "1", "AL"}}) {
		t.Fatalf("%v", got)
	}
	r := s.parse(outputs)
	if !r.Complete {
		t.Fatalf("%+v", r)
	}
	pd := w02bComponent(t, r, "arcconf:c1:e-:s0-3")
	if pd.State != "online" {
		t.Fatalf("%+v", pd)
	}
	vd := w02bComponent(t, r, "arcconf:c1:v0")
	if vd.Attributes["memberKeys"].([]string)[0] != pd.ComponentKey {
		t.Fatal("segment membership")
	}
	if w02bComponent(t, r, "arcconf:c1:bbu").State != "ok" {
		t.Fatal("battery")
	}
	outputs[1].text = strings.ReplaceAll(outputs[1].text, "Battery Information", "Controller ZMM Information")
	if w02bComponent(t, s.parse(outputs), "arcconf:c1:cv").State != "ok" {
		t.Fatal("ZMM")
	}
	if !reflect.DeepEqual(arcControllers("Controllers found: 2\nController #1\nController #3\n"), []string{"1", "3"}) {
		t.Fatal("controller IDs must not be assumed contiguous")
	}
	outputs[1].text = strings.ReplaceAll(outputs[1].text, "   State: Online\n", "")
	if s.parse(outputs).Complete {
		t.Fatal("missing disk state is malformed, not unknown")
	}
}
