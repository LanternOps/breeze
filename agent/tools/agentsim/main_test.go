package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/tools/agentsim/sim"
)

func TestParseFlagsTakesSecretsFromTheEnvironment(t *testing.T) {
	env := map[string]string{
		"AGENTSIM_SERVER":                "http://localhost:9",
		"AGENTSIM_ENROLLMENT_KEY":        "key-from-env",
		"BREEZE_AGENT_ENROLLMENT_SECRET": "secret-from-env",
	}
	cfg, err := parseFlags([]string{"--agents", "200", "--duration", "20m", "--cadence", "heartbeat=30s"},
		func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ServerURL != "http://localhost:9" || cfg.EnrollmentKey != "key-from-env" || cfg.EnrollmentSecret != "secret-from-env" {
		t.Fatalf("env defaults not applied: %+v", cfg)
	}
	if cfg.Agents != 200 || cfg.Duration != 20*time.Minute || cfg.Cadence.Heartbeat != 30*time.Second {
		t.Fatalf("flags not applied: agents %d duration %s heartbeat %s", cfg.Agents, cfg.Duration, cfg.Cadence.Heartbeat)
	}
}

func TestParseFlagsRejectsAnInvalidConfig(t *testing.T) {
	if _, err := parseFlags([]string{"--agents", "0"}, func(string) string { return "" }); err == nil {
		t.Fatal("want a validation error")
	}
}

func TestParseFlagsLoadsAStormAndGates(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.json")
	if err := os.WriteFile(path, []byte(`{"name":"drop","events":[{"name":"drop","at":"2m","start":[{"internal":"drop-sockets"}]}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"AGENTSIM_SERVER": "http://localhost:9", "METRICS_SCRAPE_TOKEN": "tok"}
	cfg, err := parseFlags([]string{"--duration", "10m", "--storm", path, "--gate-heartbeat-p95", "1s",
		"--gate-pool-min-ratio", "0.8", "--legacy-retry-fraction", "0.25"}, func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Storm == nil || cfg.Storm.Name != "drop" || cfg.ScrapeToken != "tok" || cfg.Gates.HeartbeatP95 != time.Second ||
		cfg.Gates.PoolMinRatio != 0.8 || cfg.LegacyRetryFraction != 0.25 || cfg.StormPath != path {
		t.Fatalf("%+v", cfg)
	}
}

// The scenario's ${STORM_*} expansion reads the same environment as every
// other flag default, not the process environment behind its back.
func TestParseFlagsExpandsStormVarsFromGetenv(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s.json")
	if err := os.WriteFile(path, []byte(`{"name":"k","events":[{"name":"k","at":"2m","start":[{"exec":["docker","kill","${STORM_API}"]}]}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"AGENTSIM_SERVER": "http://localhost:9", "STORM_API": "proj-api-1"}
	cfg, err := parseFlags([]string{"--duration", "10m", "--storm", path}, func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if got := cfg.Storm.Events[0].Start[0].Exec[2]; got != "proj-api-1" {
		t.Fatalf("expanded %q", got)
	}
	if _, err := parseFlags([]string{"--duration", "10m", "--storm", path}, func(k string) string {
		return map[string]string{"AGENTSIM_SERVER": "http://localhost:9"}[k]
	}); err == nil || !strings.Contains(err.Error(), "STORM_API") {
		t.Fatalf("an unset STORM_API must be refused, got %v", err)
	}
}

func TestExitCodeForAFailedStormGate(t *testing.T) {
	if exitCode(sim.Report{Storm: &sim.StormReport{Pass: false}}, nil) != 3 {
		t.Fatal("a failed gate exits 3")
	}
	if exitCode(sim.Report{Storm: &sim.StormReport{Pass: true}}, nil) != 0 || exitCode(sim.Report{}, nil) != 0 {
		t.Fatal("pass or no storm exits 0")
	}
	if exitCode(sim.Report{}, errors.New("x")) != 1 {
		t.Fatal("a run error exits 1")
	}
}

func TestPrintStormDryRun(t *testing.T) {
	sc := sim.Scenario{Name: "k", Events: []sim.Event{{Name: "k", At: sim.Duration{D: 3 * time.Minute}, Hold: sim.Duration{D: 5 * time.Second},
		Start: []sim.Action{{Exec: []string{"docker", "kill", "c1"}}}, End: []sim.Action{{Exec: []string{"docker", "start", "c1"}}}}}}
	var buf bytes.Buffer
	printDryRun(&buf, sc)
	out := buf.String()
	if !strings.Contains(out, "+3m0s") || !strings.Contains(out, "docker kill c1") || !strings.Contains(out, "+3m5s") || !strings.Contains(out, "docker start c1") {
		t.Fatalf("dry run output:\n%s", out)
	}
}
