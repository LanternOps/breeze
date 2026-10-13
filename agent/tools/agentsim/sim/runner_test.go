package sim

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func runnerConfig(f *fakeAPI, dir string) Config {
	cfg := testConfig(f, dir)
	cfg.Agents, cfg.RampPerSecond, cfg.EnrollConcurrency = 5, 50, 2
	cfg.Duration, cfg.Warmup = 2500*ms, 300*ms
	cfg.Commander = CommanderConfig{PerMinute: 600, Email: "admin@example.test", Password: "pw", CommandType: "refresh_inventory"}
	return cfg
}

func TestRunEnrollsOnceThenReusesTheStore(t *testing.T) {
	f := newFakeAPI(t)
	f.setEnroll429(1) // the first enrollment is rate limited and must be retried
	cfg := runnerConfig(f, t.TempDir())

	first, err := Run(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if f.count(RouteEnroll) != 6 || first.Agents.EnrolledThisRun != 5 || first.Agents.Started != 5 {
		t.Fatalf("enroll calls %d (want 5 + one 429), report %+v", f.count(RouteEnroll), first.Agents)
	}
	if first.Schema != ReportSchema || first.WS.Connects < 5 || first.Window.AgentMinutes <= 0 {
		t.Fatalf("report %+v / ws %+v / window %+v", first.Schema, first.WS, first.Window)
	}
	if first.Commands.Dispatched == 0 || first.Commands.ResultsSent["ws"] == 0 {
		t.Fatalf("commander round trip missing: %+v", first.Commands)
	}
	data, err := os.ReadFile(cfg.ReportPath)
	if err != nil {
		t.Fatal(err)
	}
	var onDisk Report
	if err := json.Unmarshal(data, &onDisk); err != nil || onDisk.RunID != first.RunID {
		t.Fatalf("report on disk: %v %+v", err, onDisk.RunID)
	}

	second, err := Run(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if f.count(RouteEnroll) != 6 || second.Agents.ReusedFromStore != 5 || second.Agents.EnrolledThisRun != 0 {
		t.Fatalf("the second run re-enrolled: enroll calls %d, agents %+v", f.count(RouteEnroll), second.Agents)
	}
}

func TestRunWithoutAStormHasNoStormSections(t *testing.T) {
	f := newFakeAPI(t)
	cfg := runnerConfig(f, t.TempDir())
	rep, err := Run(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(rep)
	for _, k := range []string{`"timeline"`, `"pool"`, `"storm"`} {
		if strings.Contains(string(data), k) {
			t.Fatalf("%s present in a plain run (W07 reads this schema; additive and omitted)", k)
		}
	}
}

// A storm run registers every agent socket with the hub and runs the
// scheduler: the internal drop-sockets action closes them all.
func TestRunStormDropsEverySocket(t *testing.T) {
	f := newFakeAPI(t)
	cfg := runnerConfig(f, t.TempDir())
	cfg.Commander.PerMinute = 0
	cfg.Duration, cfg.Warmup = 3*time.Second, 200*ms
	cfg.Storm = &Scenario{Name: "drop", Events: []Event{{Name: "drop", At: Duration{800 * ms}, Recovery: Duration{time.Second},
		Start: []Action{{Internal: ActionDropSockets}}}}}
	cfg.StormPreWindow = 300 * ms
	cfg.TimelineStep = 100 * ms
	if _, err := Run(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if got := f.count(RouteWSUpgrade); got < 10 {
		t.Fatalf("upgrades %d: 5 agents must each dial, be dropped, and redial", got)
	}
}

func TestRunRefusesAShortStoreWithoutAKey(t *testing.T) {
	f := newFakeAPI(t)
	cfg := runnerConfig(f, t.TempDir())
	cfg.EnrollmentKey = ""
	_, err := Run(context.Background(), cfg)
	if err == nil || !strings.Contains(err.Error(), "--enrollment-key") {
		t.Fatalf("want an --enrollment-key error, got %v", err)
	}
}

func TestRunInterruptedBeforeTheWindowStillWritesAReport(t *testing.T) {
	f := newFakeAPI(t)
	cfg := runnerConfig(f, t.TempDir())
	cfg.Duration, cfg.Warmup = time.Minute, 30*time.Second
	cfg.Commander.PerMinute = 0
	ctx, cancel := context.WithTimeout(context.Background(), 400*ms) // Ctrl-C long before the window opens
	defer cancel()
	rep, err := Run(ctx, cfg)
	if err != nil {
		t.Fatalf("an interrupted run must still succeed in writing its report: %v", err)
	}
	if rep.Window.AgentMinutes != 0 || rep.Totals.RequestsPerAgentMinute != 0 {
		t.Fatalf("empty window must report zero rates: %+v", rep.Totals)
	}
	if _, err := os.Stat(cfg.ReportPath); err != nil {
		t.Fatalf("report not written: %v", err)
	}
}
