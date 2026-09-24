package hwhealth

import (
	"strings"
	"testing"
)

// `ctrl all show config detail` uses "Array: A" / "Logical Drive: 1" headers, repeats
// member drives as one-line references inside the logical drive, lists unassigned
// drives after the arrays and ends with SEP/expander records. Synthetic sample.
func TestSSACLIConfigDetailLayout(t *testing.T) {
	s := newSSACLI(nil)
	r := s.parse(fixtureOutputs(t, "ssacli/detail.txt", s.commands))
	if !r.Complete {
		t.Fatalf("detail layout not recognized: %+v", r)
	}
	c := w02bComponent(t, r, "ssacli:c0")
	if c.State != "ok" || c.Serial == nil || *c.Serial != "CTRL-TEST" {
		t.Fatalf("controller %+v", c)
	}
	vd := w02bComponent(t, r, "ssacli:c0:v1")
	members := strings.Join(vd.Attributes["memberKeys"].([]string), ",")
	if vd.State != "optimal" || members != "ssacli:c0:e1I-1:s1,ssacli:c0:e1I-1:s2" {
		t.Fatalf("logical drive %+v members=%s", vd, members)
	}
	unassigned := w02bComponent(t, r, "ssacli:c0:e1I-1:s3")
	if unassigned.Model == nil || *unassigned.Model != "Fixture disk" {
		t.Fatalf("SEP fields bled into the last disk: %+v", unassigned)
	}
	if pd := w02bComponent(t, r, "ssacli:c0:e1I-1:s1"); pd.TemperatureC == nil || *pd.TemperatureC != 31 {
		t.Fatalf("disk %+v", pd)
	}
}
