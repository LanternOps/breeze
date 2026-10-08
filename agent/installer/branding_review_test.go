package installer

import (
	"os"
	"strings"
	"testing"
)

func readBuildEdition(t *testing.T) string {
	t.Helper()
	path := os.Getenv("BREEZE_BUILD_EDITION_PATH")
	if path == "" {
		path = "../scripts/build-edition.sh"
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

// The binaries take the brand from the BREEZE_BRAND_* variables and the MSI
// from build-msi.ps1 parameters. The collector only maps a display name that
// is identical in both, so a blank parameter falls back to the variable and
// two values that differ are refused: the two can never drift apart.
func TestBuildMsiFallsBackToTheBinaryBrandVariables(t *testing.T) {
	ps1 := readBuildMsi(t)
	sh := readBuildEdition(t)
	for _, name := range []string{
		"BREEZE_BRAND_AGENT_DISPLAY_NAME",
		"BREEZE_BRAND_AGENT_DESCRIPTION",
		"BREEZE_BRAND_WATCHDOG_DISPLAY_NAME",
		"BREEZE_BRAND_WATCHDOG_DESCRIPTION",
	} {
		if !strings.Contains(ps1, name) {
			t.Errorf("build-msi.ps1 must fall back to %s", name)
		}
		if !strings.Contains(sh, name) {
			t.Errorf("build-edition.sh no longer reads %s", name)
		}
	}
	if !strings.Contains(ps1, "must carry the same brand") {
		t.Error("build-msi.ps1 must refuse a parameter that differs from its BREEZE_BRAND_* variable")
	}
}
