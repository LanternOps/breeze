package hwhealth

import (
	"reflect"
	"testing"
	"time"
)

func TestOMReport(t *testing.T) {
	s := newOMReport(nil)
	if s.timeout != 60*time.Second {
		t.Fatal("timeout")
	}
	commands := append(append([][]string{}, s.commands...), []string{"storage", "pdisk", "controller=0", "-fmt", "ssv"})
	out := fixtureOutputs(t, "omreport/optimal.txt", commands)
	if !reflect.DeepEqual(s.expand(out[:3]), [][]string{{"storage", "pdisk", "controller=0", "-fmt", "ssv"}}) {
		t.Fatal("enumeration")
	}
	r := s.parse(out)
	if !r.Complete {
		t.Fatalf("%+v", r)
	}
	if w02bComponent(t, r, "omreport:c0:e0-1:s3").State != "online" {
		t.Fatal("disk")
	}
	rows, ok := ssvRows("ID;Name;State\n0;\"label;with separator\";Ready\n")
	if !ok || rows[0]["name"] != "label;with separator" {
		t.Fatal("SSV quoting")
	}
	if _, ok = ssvRows("ID;Name;State\n0;broken\n"); ok {
		t.Fatal("ragged row accepted")
	}
}
