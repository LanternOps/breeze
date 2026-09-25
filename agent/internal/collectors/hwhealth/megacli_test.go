package hwhealth

import (
	"strings"
	"testing"
)

func fixtureOutputs(t *testing.T, path string, commands [][]string) []commandOutput {
	t.Helper()
	parts := strings.Split(string(w02bFixture(t, path)), "\n===\n")
	if len(parts) != len(commands) {
		t.Fatalf("%s: %d captures, want %d", path, len(parts), len(commands))
	}
	out := make([]commandOutput, len(parts))
	for i, p := range parts {
		out[i] = commandOutput{commands[i], p}
	}
	return out
}
func TestMegaCLI(t *testing.T) {
	s := newMegaCLI(nil)
	outputs := fixtureOutputs(t, "megacli/optimal.txt", s.commands)
	r := s.parse(outputs)
	if !r.Complete {
		t.Fatalf("%+v", r)
	}
	pd := w02bComponent(t, r, "megacli:c0:e252:s3")
	if pd.State != "online" || pd.Serial == nil || *pd.Serial != "DISK-TEST" {
		t.Fatalf("%+v", pd)
	}
	vd := w02bComponent(t, r, "megacli:c0:v0")
	if strings.Join(vd.Attributes["memberKeys"].([]string), ",") != pd.ComponentKey {
		t.Fatal("membership lost")
	}
	outputs[2].text = strings.ReplaceAll(outputs[2].text, "Predictive Failure Count: 0", "Predictive Failure Count: 1")
	if !w02bComponent(t, s.parse(outputs), pd.ComponentKey).PredictiveFailure {
		t.Fatal("predictive flag lost")
	}
	outputs[1].text += "\nOngoing Progresses:\nRebuild: 42%"
	vd = w02bComponent(t, s.parse(outputs), vd.ComponentKey)
	if vd.State != "rebuilding" || vd.ProgressPercent == nil || *vd.ProgressPercent != 42 {
		t.Fatalf("%+v", vd)
	}
	outputs[2].text += "\nEnclosure Device ID: 252\nSlot Number: 4\n"
	if s.parse(outputs).Complete {
		t.Fatal("malformed second disk grants completeness")
	}
	outputs = fixtureOutputs(t, "megacli/optimal.txt", s.commands)
	outputs[3].text = "BBU status for Adapter: 0\nBBU is not present\n"
	if w02bComponent(t, s.parse(outputs), "megacli:c0:bbu").State != "missing" {
		t.Fatal("explicitly absent battery lost")
	}
	for _, tc := range []struct{ line, state string }{{"Learn Cycle Active: Yes", "learning"}, {"Battery Replacement required: Yes", "failed"}, {"Pack is about to fail: Yes", "failed"}} {
		outputs[3].text = "BBU status for Adapter: 0\nBattery State: Optimal\n" + tc.line + "\n"
		if w02bComponent(t, s.parse(outputs), "megacli:c0:bbu").State != tc.state {
			t.Fatal(tc)
		}
	}
	outputs[2].text = strings.ReplaceAll(outputs[2].text, "S.M.A.R.T alert: No", "S.M.A.R.T alert: Yes")
	if !w02bComponent(t, s.parse(outputs), pd.ComponentKey).PredictiveFailure {
		t.Fatal("SMART alert flag lost")
	}
}
