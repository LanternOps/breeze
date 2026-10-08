package sim

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func sum(m map[string]float64) float64 {
	var s float64
	for _, v := range m {
		s += v
	}
	return s
}

// The documented mix (plan §"Open item 2"): 1 heartbeat + 2 UniFi polls + 1/3
// process sample + security and sessions every 5.5 min + posture, event logs
// and the six-PUT inventory batch every 15.5 min = 4.213, and 5.213 with
// crawl-config. A tick-gated stream fires on tick n or n+1 about equally
// often (the agent reads `now` after the heartbeat returns), so its mean
// interval is period + tick/2.
func TestExpectedMixMatchesTheAgentCadences(t *testing.T) {
	absent := sum(ExpectedPerAgentMinute(DefaultCadence(), true))
	present := sum(ExpectedPerAgentMinute(DefaultCadence(), false))
	if math.Abs(absent-4.2131) > 0.001 || math.Abs(present-5.2131) > 0.001 {
		t.Fatalf("expected mix = %.4f (crawl-config absent) / %.4f (present), want 4.2131 / 5.2131", absent, present)
	}
}

func TestBuildReportRatesAndDeviation(t *testing.T) {
	t0 := time.Now()
	rec := NewRecorder("run-1", t0, t0, t0.Add(10*time.Minute))
	rec.AgentOnline(0, t0)
	rec.AgentOnline(1, t0)
	for i := 0; i < 20; i++ { // 2 agents × 10 min × 1/min
		rec.ObserveHTTP(RouteHeartbeat, true, t0.Add(time.Duration(i)*time.Second), 20*time.Millisecond, 200, nil)
	}
	rec.ObserveHTTP(RouteCrawlConfig, true, t0, time.Millisecond, 404, nil)
	cfg := validConfig()
	r := BuildReport(rec, cfg, t0.Add(10*time.Minute), 2)

	if r.Schema != ReportSchema || r.Window.AgentMinutes != 20 {
		t.Fatalf("schema %q agent-minutes %.2f", r.Schema, r.Window.AgentMinutes)
	}
	var hb *RouteReport
	for i := range r.Routes {
		if r.Routes[i].Route == RouteHeartbeat {
			hb = &r.Routes[i]
		}
	}
	if hb == nil || hb.PerAgentMinute != 1 || hb.ExpectedPerAgentMinute != 1 || hb.Status[200] != 20 {
		t.Fatalf("heartbeat route report wrong: %+v", hb)
	}
	// crawl-config only ever 404'd, so the model expects 0 from it.
	if math.Abs(r.Totals.ExpectedRequestsPerAgentMinute-4.2131) > 0.001 {
		t.Fatalf("expected total %.4f, want 4.2131", r.Totals.ExpectedRequestsPerAgentMinute)
	}
	if r.Totals.Non2xx != 1 {
		t.Fatalf("non2xx = %d, want the one 404", r.Totals.Non2xx)
	}
}

func TestBuildReportWithNoAgentMinutesHasZeroRates(t *testing.T) {
	t0 := time.Now()
	rec := NewRecorder("run-2", t0, t0.Add(time.Hour), t0.Add(2*time.Hour)) // window never opened
	rec.AgentOnline(0, t0)
	r := BuildReport(rec, validConfig(), t0.Add(time.Minute), 1)
	if r.Window.AgentMinutes != 0 || r.Totals.RequestsPerAgentMinute != 0 || r.Totals.DeviationPct != 0 {
		t.Fatalf("empty window must report zeros, got %+v", r.Totals)
	}
	path := filepath.Join(t.TempDir(), "nested", "report.json")
	if err := WriteReport(path, r); err != nil {
		t.Fatalf("an empty-window report must still serialise: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var back Report
	if err := json.Unmarshal(data, &back); err != nil || back.RunID != "run-2" {
		t.Fatalf("round trip: %v %+v", err, back)
	}
}
