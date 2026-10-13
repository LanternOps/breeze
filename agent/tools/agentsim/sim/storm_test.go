package sim

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestLoadScenarioExpandsOnlyStormVars(t *testing.T) {
	t.Setenv("STORM_API", "proj-api-1")
	dir := t.TempDir()
	path := filepath.Join(dir, "s.json")
	writeFile(t, path, `{"name":"api-kill","events":[{"name":"api-kill","at":"2m","hold":"5s","recovery":"3m",
	  "start":[{"exec":["docker","kill","--signal","KILL","${STORM_API}"]}],
	  "end":[{"exec":["docker","start","${STORM_API}"]}]}]}`)
	sc, err := LoadScenario(path, os.LookupEnv)
	if err != nil {
		t.Fatal(err)
	}
	if got := sc.Events[0].Start[0].Exec[4]; got != "proj-api-1" {
		t.Fatalf("expanded %q", got)
	}
	if sc.Events[0].At.D != 2*time.Minute || sc.Events[0].Recovery.D != 3*time.Minute {
		t.Fatalf("durations: %+v", sc.Events[0])
	}
}

func TestLoadScenarioDefaultsRecovery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s.json")
	writeFile(t, path, `{"name":"x","events":[{"name":"e","at":"2m","start":[{"internal":"drop-sockets"}]}]}`)
	sc, err := LoadScenario(path, os.LookupEnv)
	if err != nil {
		t.Fatal(err)
	}
	if sc.Events[0].Recovery.D != 3*time.Minute {
		t.Fatalf("default recovery %s, want 3m", sc.Events[0].Recovery.D)
	}
}

func TestLoadScenarioRefuses(t *testing.T) {
	t.Setenv("STORM_EMPTY", "")
	cases := map[string]string{
		"not docker":     `{"name":"x","events":[{"name":"e","at":"2m","start":[{"exec":["sh","-c","true"]}]}]}`,
		"non-STORM var":  `{"name":"x","events":[{"name":"e","at":"2m","start":[{"exec":["docker","kill","${HOME}"]}]}]}`,
		"unset var":      `{"name":"x","events":[{"name":"e","at":"2m","start":[{"exec":["docker","kill","${STORM_NOPE}"]}]}]}`,
		"empty var":      `{"name":"x","events":[{"name":"e","at":"2m","start":[{"exec":["docker","kill","${STORM_EMPTY}"]}]}]}`,
		"unknown action": `{"name":"x","events":[{"name":"e","at":"2m","start":[{"internal":"reboot-host"}]}]}`,
		"both kinds":     `{"name":"x","events":[{"name":"e","at":"2m","start":[{"exec":["docker","ps"],"internal":"drop-sockets"}]}]}`,
		"no start":       `{"name":"x","events":[{"name":"e","at":"2m"}]}`,
		"pre overlaps": `{"name":"x","events":[{"name":"a","at":"2m","recovery":"3m","start":[{"internal":"drop-sockets"}]},
		                   {"name":"b","at":"5m30s","start":[{"internal":"drop-sockets"}]}]}`,
		"unknown field":  `{"name":"x","bogus":1,"events":[{"name":"e","at":"2m","start":[{"internal":"drop-sockets"}]}]}`,
		"pre before run": `{"name":"x","events":[{"name":"e","at":"30s","start":[{"internal":"drop-sockets"}]}]}`,
		"negative":       `{"name":"x","events":[{"name":"e","at":"-2m","start":[{"internal":"drop-sockets"}]}]}`,
		"no events":      `{"name":"x","events":[]}`,
		"empty argv":     `{"name":"x","events":[{"name":"e","at":"2m","start":[{"exec":[]}]}]}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "s.json")
			writeFile(t, path, body)
			if _, err := LoadScenario(path, os.LookupEnv); err == nil {
				t.Fatal("want an error")
			}
		})
	}
}

func TestScenarioMustFitTheRun(t *testing.T) {
	sc := Scenario{Name: "x", Events: []Event{{Name: "e", At: Duration{2 * time.Minute}, Hold: Duration{time.Minute},
		Recovery: Duration{3 * time.Minute}, Start: []Action{{Internal: ActionDropSockets}}}}}
	if err := sc.FitsWindow(5 * time.Minute); err == nil {
		t.Fatal("2m + 1m + 3m does not fit a 5m window")
	}
	if err := sc.FitsWindow(6 * time.Minute); err != nil {
		t.Fatal(err)
	}
}
