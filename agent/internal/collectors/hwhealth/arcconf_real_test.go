package hwhealth

import (
	"strings"
	"testing"
)

// Newer arcconf layout (synthetic): segment lines carry connector/device and the member
// serial rather than the drive's reported channel/device address.
func TestARCCONFModernSegments(t *testing.T) {
	s := newARCCONF(nil)
	r := s.parse(fixtureOutputs(t, "arcconf/modern.txt", [][]string{{"GETVERSION"}, {"GETCONFIG", "1", "AL"}}))
	if !r.Complete {
		t.Fatalf("%+v", r)
	}
	vd := w02bComponent(t, r, "arcconf:c1:v0")
	if got := strings.Join(vd.Attributes["memberKeys"].([]string), ","); got != "arcconf:c1:e-:s0-0,arcconf:c1:e-:s0-1" {
		t.Fatalf("serial-based membership=%q", got)
	}
	if spare := w02bComponent(t, r, "arcconf:c1:e-:s0-1"); spare.State != "hotspare" {
		t.Fatalf("hot-spare spelling: %+v", spare)
	}
	if last := w02bComponent(t, r, "arcconf:c1:e-:s0-0"); last.Model == nil || *last.Model != "Fixture disk" {
		t.Fatalf("%+v", last)
	}
	if zmm := w02bComponent(t, r, "arcconf:c1:cv"); zmm.State != "ok" || zmm.StateDetail == nil || *zmm.StateDetail != "ZMM Optimal" {
		t.Fatalf("%+v", zmm)
	}
}

func TestTextFieldsFirstValueWins(t *testing.T) {
	f := textFields("State: Online\nModel: Disk\nPort-0 :\nState: Standby\nModel: SEP\nName:\nName: later\n")
	if f["state"] != "Online" || f["model"] != "Disk" || f["name"] != "later" {
		t.Fatalf("%v", f)
	}
}
