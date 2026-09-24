package hwhealth

import "testing"

// PowerEdge-style layout (synthetic): "(Embedded)" and "(Slot 4)" section headers whose
// slot differs from the controller ID, plus a controller that has no battery.
func TestOMReportSectionsResolveByControllerTable(t *testing.T) {
	s := newOMReport(nil)
	commands := append(append([][]string{}, s.commands...),
		[]string{"storage", "pdisk", "controller=0", "-fmt", "ssv"},
		[]string{"storage", "pdisk", "controller=1", "-fmt", "ssv"})
	r := s.parse(fixtureOutputs(t, "omreport/embedded.txt", commands))
	if !r.Complete {
		t.Fatalf("%+v", r)
	}
	perc := w02bComponent(t, r, "omreport:c0:v0")
	if perc.Name != "Data" || perc.SizeBytes == nil || *perc.SizeBytes != 1198562263040 {
		t.Fatalf("PERC vdisk %+v", perc)
	}
	if boss := w02bComponent(t, r, "omreport:c1:v0"); boss.Name != "OS" {
		t.Fatalf("slot 4 section must resolve to controller ID 1: %+v", boss)
	}
	w02bComponent(t, r, "omreport:c0:bbu")
	for _, c := range r.Components {
		if c.ComponentKey == "omreport:c1:bbu" || c.ComponentKey == "omreport:c4:v0" {
			t.Fatalf("fabricated %s", c.ComponentKey)
		}
	}
	w02bComponent(t, r, "omreport:c1:e0-1:s0")
}

func TestOMSAResolveAmbiguity(t *testing.T) {
	two := []map[string]string{{"id": "0", "name": "PERC", "slot id": "PCI Slot 2"}, {"id": "3", "name": "PERC", "slot id": "PCI Slot 5"}}
	if got := omsaResolve("PERC", "Slot 5", two); got != "3" {
		t.Fatalf("slot narrowing=%q", got)
	}
	if got := omsaResolve("PERC", "Embedded", two); got != "" {
		t.Fatalf("ambiguous header assigned to %q", got)
	}
	if got := omsaResolve("Unknown", "Slot 2", two); got != "" {
		t.Fatalf("unknown name assigned to %q", got)
	}
}
