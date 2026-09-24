package hwhealth

import (
	"strings"
	"testing"
)

// Real MegaCli spellings that differ from the minimal fixture.
func TestMegaCLIRealSpellings(t *testing.T) {
	s := newMegaCLI(nil)
	outputs := fixtureOutputs(t, "megacli/optimal.txt", s.commands)
	outputs[2].text = strings.ReplaceAll(outputs[2].text, "Firmware state: Online, Spun Up", "Firmware state: Online, Spun down")
	outputs[2].text = strings.ReplaceAll(outputs[2].text, "Drive Temperature: 35C", "Drive Temperature :35C (95.00 F)")
	outputs[1].text = strings.ReplaceAll(outputs[1].text, "Name: mirror", "Name                :")
	outputs[1].text += "\nOngoing Progresses:\n  Check Consistency        : Completed 36%, Taken 42 min.\n"
	r := s.parse(outputs)
	pd := w02bComponent(t, r, "megacli:c0:e252:s3")
	if pd.State != "online" || pd.TemperatureC == nil || *pd.TemperatureC != 35 {
		t.Fatalf("pd %+v", pd)
	}
	vd := w02bComponent(t, r, "megacli:c0:v0")
	if vd.Name != "Virtual Drive 0" || vd.State != "checking" || vd.ProgressPercent == nil || *vd.ProgressPercent != 36 {
		t.Fatalf("vd %+v", vd)
	}
	outputs[2].text = strings.ReplaceAll(outputs[2].text, "Drive Temperature :35C (95.00 F)", "Drive Temperature :N/A")
	if w02bComponent(t, s.parse(outputs), pd.ComponentKey).TemperatureC != nil {
		t.Fatal("fabricated temperature")
	}
	for line, want := range map[string]string{
		"Pack is about to fail & should be replaced : Yes": "failed",
		"Battery Pack Missing                    : Yes":    "missing",
	} {
		outputs[3].text = "BBU status for Adapter: 0\nBattery State: Operational\n" + line + "\n"
		if got := w02bComponent(t, s.parse(outputs), "megacli:c0:bbu").State; got != want {
			t.Fatalf("%q -> %s", line, got)
		}
	}
	outputs[3].text = "BBU status for Adapter: 0\nBattery State: Operational\n"
	if got := w02bComponent(t, s.parse(outputs), "megacli:c0:bbu").State; got != "ok" {
		t.Fatalf("operational -> %s", got)
	}
}
