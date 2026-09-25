package hwhealth

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestSSACLI(t *testing.T) {
	s := newSSACLI(nil)
	if s.timeout != 60*time.Second || !reflect.DeepEqual(s.names, []string{"ssacli", "hpssacli", "hpacucli"}) {
		t.Fatal("aliases or timeout")
	}
	outputs := fixtureOutputs(t, "ssacli/optimal.txt", s.commands)
	r := s.parse(outputs)
	if !r.Complete || len(r.Components) != 4 {
		t.Fatalf("%+v", r)
	}
	pd := w02bComponent(t, r, "ssacli:c0:e1I-1:s3")
	vd := w02bComponent(t, r, "ssacli:c0:v1")
	if vd.Attributes["memberKeys"].([]string)[0] != pd.ComponentKey {
		t.Fatal("array membership")
	}
	outputs[0].text = strings.ReplaceAll(outputs[0].text, "Cache Status: OK", "Cache Status: Temporarily Disabled")
	outputs[1].text = strings.ReplaceAll(outputs[1].text, "   Cache Status: OK\n", "")
	r = s.parse(outputs)
	if w02bComponent(t, r, "ssacli:c0").State != "degraded" {
		t.Fatal("cache does not degrade controller")
	}
	for i := range outputs {
		outputs[i].text = strings.ReplaceAll(outputs[i].text, "Battery/Capacitor Status: OK", "Battery/Capacitor Status: Failed")
	}
	if w02bComponent(t, s.parse(outputs), "ssacli:c0:bbu").State != "failed" {
		t.Fatal("battery lost")
	}
	outputs[1].text += "\nSmart Array fixture in Slot 1\nController Status: OK\nphysicaldrive 1I:1:4\nModel: broken record\n"
	outputs[1].text += "\nSmart Array fixture in Slot 2\nController Status: OK\n"
	if s.parse(outputs).Complete {
		t.Fatal("later valid controller concealed malformed disk")
	}
}
