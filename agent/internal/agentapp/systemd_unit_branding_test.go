package agentapp

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/branding"
)

// Golden: the default description today. The branded build replaces exactly
// this line.
func TestLinuxUnitDefaultDescriptionIsGolden(t *testing.T) {
	if n := strings.Count(linuxUnit, "\nDescription="); n != 1 {
		t.Fatalf("linuxUnit has %d Description= lines, want exactly 1", n)
	}
	if !strings.Contains(linuxUnit, "\nDescription=Breeze RMM Agent\n") {
		t.Fatalf("linuxUnit default description is no longer %q", "Breeze RMM Agent")
	}
}

// With no branding the unit written to disk is the embedded constant, so
// TestStaticUnitMatchesEmbedded keeps holding and official output is unchanged.
func TestCurrentLinuxUnitWithoutBrandingIsEmbedded(t *testing.T) {
	restore := branding.SetForTest(branding.Values{})
	defer restore()
	if got := currentLinuxUnit(); got != linuxUnit {
		t.Fatal("currentLinuxUnit() must equal linuxUnit when no branding is set")
	}
}

// A brand changes the Description= line only. The unit-version marker must
// survive so the startup reconcile still compares versions correctly.
func TestCurrentLinuxUnitBrandedChangesOnlyDescription(t *testing.T) {
	restore := branding.SetForTest(branding.Values{AgentServiceDescription: "Example MSP Agent"})
	defer restore()
	got := currentLinuxUnit()
	want := strings.Replace(linuxUnit, "\nDescription=Breeze RMM Agent\n", "\nDescription=Example MSP Agent\n", 1)
	if got != want {
		t.Fatal("branded unit differs from the embedded one in more than the Description= line")
	}
	if v, ok := parseUnitVersion(got); !ok || v != currentUnitVersion {
		t.Fatalf("branded unit version = (%d, %v), want (%d, true)", v, ok, currentUnitVersion)
	}
}

// A value with a newline would inject directives into a unit that runs as
// root, so it must fall back to the default unit.
func TestCurrentLinuxUnitInvalidBrandFallsBack(t *testing.T) {
	restore := branding.SetForTest(branding.Values{AgentServiceDescription: "Example\nExecStart=/bin/sh"})
	defer restore()
	if got := currentLinuxUnit(); got != linuxUnit {
		t.Fatal("an invalid brand must fall back to the embedded unit")
	}
}
