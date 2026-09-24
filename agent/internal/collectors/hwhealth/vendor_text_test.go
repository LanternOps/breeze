package hwhealth

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

func w02bFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func w02bComponent(t *testing.T, r Result, key string) Component {
	t.Helper()
	for _, c := range r.Components {
		if c.ComponentKey == key {
			return c
		}
	}
	t.Fatalf("missing %s in %+v", key, r)
	return Component{}
}
func TestCollectCLIPartial(t *testing.T) {
	s := &cliSource{kind: "megacli", timeout: 30 * time.Second, commands: [][]string{{"good"}, {"bad"}}}
	s.run = func(ctx context.Context, d time.Duration, path string, args ...string) (execResult, error) {
		if args[0] == "bad" {
			return execResult{}, errors.New("controller timeout")
		}
		return execResult{Stdout: []byte("observed"), ExitCode: 2}, nil
	}
	s.parse = func(outputs []commandOutput) Result {
		if len(outputs) != 1 {
			t.Fatalf("outputs=%d", len(outputs))
		}
		return Result{Complete: true, Components: []Component{textComponent("megacli", "controller", "megacli:c0", "", "adapter", "Optimal")}}
	}
	r, err := s.Collect(context.Background(), Availability{Available: true, Path: "fake"})
	if err != nil || r.Complete || len(r.Components) != 1 || len(r.Warnings) == 0 {
		t.Fatalf("lost partial observation: %+v %v", r, err)
	}
	s.kind = "ssacli"
	if _, err = s.Collect(context.Background(), Availability{Available: true, Path: "fake"}); err == nil {
		t.Fatal("non-MegaCli nonzero exit must fail")
	}
}
func TestOptionalNumericFields(t *testing.T) {
	for _, raw := range []string{"", " ", "unknown"} {
		if textInt(raw) != 0 {
			t.Fatalf("%q", raw)
		}
	}
}
func TestTextSizes(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want int64
	}{{"100 GB", 100000000000}, {"1 GiB", 1073741824}, {"100G", 107374182400}} {
		got := textSize(tc.raw)
		if got == nil || *got != tc.want {
			t.Fatalf("size %q=%v", tc.raw, got)
		}
	}
	if textSize("N/A") != nil {
		t.Fatal("unknown size fabricated")
	}
}
func TestTextFieldColonInKey(t *testing.T) {
	f := textFields("Reported Channel,Device(T:L): 0,3(3:0)\n")
	if f["reported channel,device(t:l)"] != "0,3(3:0)" {
		t.Fatalf("%v", f)
	}
}
func TestTextComponentUnknown(t *testing.T) {
	c := textComponent("ssacli", "physical_disk", "ssacli:c0:e1:s1", "ssacli:c0", "disk", "New State")
	if c.State != "unknown" || c.StateDetail == nil || *c.StateDetail != "New State" {
		t.Fatalf("%+v", c)
	}
}
func TestTextTemperature(t *testing.T) {
	for raw, want := range map[string]int{"35C (95.00 F)": 35, "31": 31, " 40 C": 40} {
		if got := textTemperature(raw); got == nil || *got != want {
			t.Fatalf("%q=%v", raw, got)
		}
	}
	for _, raw := range []string{"", "N/A", "unknown", "900C"} {
		if textTemperature(raw) != nil {
			t.Fatalf("%q fabricated a temperature", raw)
		}
	}
	if got := textSize("1.5 PB"); got == nil || *got != 1500000000000000 {
		t.Fatalf("petabytes=%v", got)
	}
}
