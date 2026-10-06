package branding

import (
	"strings"
	"testing"
)

const sampleUnit = "[Unit]\nDescription=Breeze RMM Agent\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=/usr/local/bin/breeze-agent start\n"

// An unset (empty or blank) description leaves the unit exactly as it is.
func TestUnitWithDescriptionUnsetKeepsUnit(t *testing.T) {
	for _, desc := range []string{"", "   "} {
		got, err := UnitWithDescription(sampleUnit, desc)
		if err != nil {
			t.Fatalf("description %q: unexpected error %v", desc, err)
		}
		if got != sampleUnit {
			t.Errorf("description %q: unit changed", desc)
		}
	}
}

// A branded description changes the Description= line and nothing else.
func TestUnitWithDescriptionReplacesOnlyTheDescriptionLine(t *testing.T) {
	got, err := UnitWithDescription(sampleUnit, "Example MSP Agent")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	gotLines := strings.Split(got, "\n")
	wantLines := strings.Split(sampleUnit, "\n")
	if len(gotLines) != len(wantLines) {
		t.Fatalf("line count changed: got %d, want %d", len(gotLines), len(wantLines))
	}
	diffs := 0
	for i := range gotLines {
		if gotLines[i] == wantLines[i] {
			continue
		}
		diffs++
		if gotLines[i] != "Description=Example MSP Agent" {
			t.Errorf("line %d = %q, want %q", i, gotLines[i], "Description=Example MSP Agent")
		}
	}
	if diffs != 1 {
		t.Fatalf("%d lines changed, want exactly 1", diffs)
	}
}

// A newline in the value would inject directives into a unit that runs as
// root, so invalid values fall back to the unchanged unit and report an error
// the caller can log.
func TestUnitWithDescriptionRejectsInvalidValues(t *testing.T) {
	for _, desc := range []string{
		"Example\nExecStart=/bin/sh",
		"100% Agent",
		"Example's Agent",
		`Example\Agent`,
		strings.Repeat("a", MaxLen+1),
	} {
		got, err := UnitWithDescription(sampleUnit, desc)
		if err == nil {
			t.Errorf("description %q: expected an error", desc)
		}
		if got != sampleUnit {
			t.Errorf("description %q: unit must stay unchanged", desc)
		}
	}
}

func TestUnitWithDescriptionOnlyFirstDescriptionLine(t *testing.T) {
	unit := "[Unit]\nDescription=A\n\n[Service]\nDescription=B\n"
	got, err := UnitWithDescription(unit, "X")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := "[Unit]\nDescription=X\n\n[Service]\nDescription=B\n"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

// A unit with no Description= line cannot be branded; the caller must hear
// about it instead of silently losing the brand.
func TestUnitWithoutDescriptionLineReportsAnError(t *testing.T) {
	unit := "[Service]\nType=simple\n"
	got, err := UnitWithDescription(unit, "X")
	if err == nil {
		t.Fatal("expected an error for a unit without Description=")
	}
	if got != unit {
		t.Fatalf("unit must stay unchanged, got %q", got)
	}
}
