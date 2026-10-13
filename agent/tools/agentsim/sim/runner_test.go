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

// apiDownExec plays an API kill against the fake API: "docker kill" refuses
// upgrades and drops every socket; "docker start" accepts upgrades again.
type apiDownExec struct{ f *fakeAPI }

func (e apiDownExec) Exec(_ context.Context, argv []string) (string, error) {
	switch argv[1] {
	case "kill":
		e.f.setRejectWS(true)
		e.f.dropSockets()
	case "start":
		e.f.setRejectWS(false)
	}
	return "", nil
}

func TestRunStormShowsTroughAndRecovery(t *testing.T) {
	f := newFakeAPI(t)
	cfg := runnerConfig(f, t.TempDir())
	cfg.Commander.PerMinute = 0
	cfg.Duration, cfg.Warmup = 6*time.Second, 200*ms
	cfg.Storm = &Scenario{Name: "kill", Events: []Event{{Name: "kill", At: Duration{1500 * ms}, Hold: Duration{500 * ms},
		Recovery: Duration{3 * time.Second},
		Start:    []Action{{Exec: []string{"docker", "kill", "api"}}},
		End:      []Action{{Exec: []string{"docker", "start", "api"}}}}}}
	cfg.StormPreWindow = 500 * ms // test-only; production is 60 s
	cfg.TimelineStep = 100 * ms   // a 6 s run needs finer buckets than 1 s
	cfg.executor = apiDownExec{f}
	rep, err := Run(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Timeline == nil || rep.Storm == nil || len(rep.Storm.Events) != 1 || len(rep.Storm.Steps) != 2 {
		t.Fatalf("storm sections missing: %+v", rep.Storm)
	}
	rc := rep.Storm.Events[0].Reconnect
	if rc.Baseline != 5 || rc.Trough != 0 || rc.ConnectFailures == 0 {
		t.Fatalf("5 sockets, all gone while upgrades are refused: %+v", rc)
	}
	// Refused connects back off 1 s ±30 % (the real agent's loop), so the
	// fleet is back within ~0.2-0.8 s of the end action (first retry 0.7-1.3 s
	// after the failed redial at the drop). 100 ms buckets can round t99 down,
	// so the bounds are loose; Trough == 0 above is what proves the dip.
	if rc.T99S == nil || *rc.T99S > 2 {
		t.Fatalf("t99 %v, want the backoff-shaped recovery", rc.T99S)
	}
	if rep.Pool != nil {
		t.Fatal("no scrape token: the pool section must be omitted")
	}
	if p := rep.Storm.Events[0].Pool; p.Samples != 0 || p.Note == "" {
		t.Fatalf("an unsampled pool says why: %+v", p)
	}
}

func TestRunStormSamplesThePool(t *testing.T) {
	f := newFakeAPI(t)
	healthy := strings.NewReplacer("_effective_permits 27", "_effective_permits 30", "_wedged_client_read_backends 1", "_wedged_client_read_backends 0").Replace(scrapeFixture)
	f.setScrape("tok", healthy)
	cfg := runnerConfig(f, t.TempDir())
	cfg.Commander.PerMinute = 0
	cfg.Duration, cfg.Warmup = 4*time.Second, 200*ms
	cfg.Storm = &Scenario{Name: "drop", Events: []Event{{Name: "drop", At: Duration{800 * ms}, Recovery: Duration{2 * time.Second},
		Start: []Action{{Internal: ActionDropSockets}}}}}
	cfg.StormPreWindow, cfg.TimelineStep = 300*ms, 100*ms
	cfg.ScrapeToken, cfg.ScrapeInterval = "tok", time.Second
	rep, err := Run(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Pool == nil || len(rep.Pool.Samples) < 2 || strings.Contains(rep.Pool.URL, "tok") {
		t.Fatalf("pool section: %+v", rep.Pool)
	}
	if p := rep.Storm.Events[0].Pool; p.OKSamples == 0 || p.RecoveryS == nil {
		t.Fatalf("event pool block: %+v", p)
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
