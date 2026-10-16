package sim

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Every committed scenario must load with placeholder STORM_* values and fit
// a 40-minute window, so a typo in a JSON file fails CI, not a lab run.
func TestCommittedScenariosLoad(t *testing.T) {
	for _, k := range []string{"STORM_API", "STORM_CADDY", "STORM_CPUS"} {
		t.Setenv(k, "placeholder")
	}
	files, err := filepath.Glob("../../../../load-tests/agentsim/storms/*.json")
	if err != nil || len(files) < 7 {
		t.Fatalf("found %d scenario files (%v), want the 7 W06 ships", len(files), err)
	}
	for _, f := range files {
		sc, err := LoadScenario(f, os.LookupEnv)
		if err != nil {
			t.Errorf("%s: %v", f, err)
			continue
		}
		if want := strings.TrimSuffix(filepath.Base(f), ".json"); sc.Name != want {
			t.Errorf("%s: name %q must match the file name", f, sc.Name)
		}
		if sc.Description == "" {
			t.Errorf("%s: every scenario names its lever and what it does not model", f)
		}
		if err := sc.FitsWindow(40 * time.Minute); err != nil {
			t.Errorf("%s: %v", f, err)
		}
	}
}
