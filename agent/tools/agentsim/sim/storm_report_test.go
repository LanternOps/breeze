package sim

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func ptr[T any](v T) *T { return &v }

func flatBuckets(n int, live int64) []Bucket {
	b := make([]Bucket, n)
	for i := range b {
		b[i] = Bucket{T: float64(i), WSLive: live}
	}
	return b
}

func TestReconnectCurve(t *testing.T) {
	b := flatBuckets(200, 100)
	for i := 60; i < 70; i++ { // event 60..65, sockets gone until 70, back over 70..79
		b[i].WSLive = 0
	}
	for i := 70; i < 80; i++ {
		b[i].WSLive = int64((i - 69) * 10)
		b[i].WSConnects = 10
	}
	ev := EventWindow{Name: "kill", PreS: 30, StartS: 60, EndS: 65, RecoveryS: 60}
	rc := reconnectCurve(b, ev)
	if rc.Baseline != 100 || rc.Trough != 0 || rc.PeakConnectsPerSecond != 10 || rc.Connects != 100 {
		t.Fatalf("%+v", rc)
	}
	if *rc.T50S != 9 || *rc.T90S != 13 || *rc.T99S != 14 { // live ≥ 50 at t=74 (74−65), ≥ 90 at 78, ≥ 99 at 79
		t.Fatalf("t50/90/99 = %v/%v/%v", *rc.T50S, *rc.T90S, *rc.T99S)
	}
	if rc.ReconnectSpanS != 9 || rc.PeakToMean != 1 {
		t.Fatalf("span %v peak/mean %v, want 9 and 1 (flat 10/s from 70 to 79)", rc.ReconnectSpanS, rc.PeakToMean)
	}
}

func TestReconnectCurveNeverRecovered(t *testing.T) {
	b := flatBuckets(200, 100)
	for i := 60; i < 200; i++ {
		b[i].WSLive = 40
	}
	rc := reconnectCurve(b, EventWindow{Name: "x", PreS: 30, StartS: 60, EndS: 60, RecoveryS: 100})
	if rc.T50S != nil || rc.T90S != nil {
		t.Fatalf("never reached 50 %%, must be null: %+v", rc)
	}
}

func TestReconnectCurveNoDipIsZero(t *testing.T) {
	rc := reconnectCurve(flatBuckets(200, 100), EventWindow{Name: "x", PreS: 30, StartS: 60, EndS: 65, RecoveryS: 60})
	if rc.T99S == nil || *rc.T99S != 0 || rc.Trough != 100 {
		t.Fatalf("a curve that never dipped reports t99 0: %+v", rc)
	}
}

// Sub-second buckets: the per-second peak scales by the step.
func TestReconnectCurvePeakIsPerSecond(t *testing.T) {
	b := make([]Bucket, 100)
	for i := range b {
		b[i] = Bucket{T: float64(i) / 10, WSLive: 5}
	}
	b[50].WSConnects = 3
	rc := reconnectCurve(b, EventWindow{PreS: 1, StartS: 4, EndS: 4.5, RecoveryS: 3})
	if rc.PeakConnectsPerSecond != 30 {
		t.Fatalf("3 connects in a 0.1 s bucket is 30/s, got %v", rc.PeakConnectsPerSecond)
	}
}

func TestErrorBlock(t *testing.T) {
	b := flatBuckets(200, 0)
	b[50] = Bucket{T: 50, Heartbeats: 999, HeartbeatsLost: 999, Requests: 999, RequestsLost: 999} // before the event
	b[61] = Bucket{T: 61, Heartbeats: 10, HeartbeatsLost: 2, Requests: 40, RequestsLost: 4}
	b[100] = Bucket{T: 100, Heartbeats: 10, Requests: 60}
	e := errorBlock(b, EventWindow{StartS: 60, EndS: 65, RecoveryS: 60})
	if e.Heartbeats != 20 || e.HeartbeatsLost != 2 || e.Requests != 100 || e.RequestsLost != 4 || e.LostPct != 4 {
		t.Fatalf("%+v", e)
	}
}

func TestPoolRecovery(t *testing.T) {
	s := []PoolSample{
		{T: 55, OK: true, Permits: 30, Effective: 30},
		{T: 60, OK: false}, {T: 65, OK: false}, // API down
		{T: 70, OK: true, Permits: 30, Effective: 20, Waiting: 9, Wedged: 1},
		{T: 75, OK: true, Permits: 30, Effective: 30, Wedged: 1},
		{T: 80, OK: true, Permits: 30, Effective: 30},
	}
	p := poolBlock(s, EventWindow{StartS: 58, EndS: 62, RecoveryS: 60})
	if p.OKSamples != 3 || p.LongestScrapeGapS != 15 || p.MinEffectiveRatio != 20.0/30 || p.MaxWaiting != 9 || p.MaxWedged != 1 {
		t.Fatalf("%+v", p)
	}
	if p.RecoveryS == nil || *p.RecoveryS != 18 { // first ok, full, unwedged sample at 80; end at 62
		t.Fatalf("recovery %v", p.RecoveryS)
	}
}

// An API that never comes back: the gap runs to the last (failed) sample,
// and recovery is null.
func TestPoolNeverRecovered(t *testing.T) {
	s := []PoolSample{{T: 55, OK: true, Permits: 30, Effective: 30}, {T: 60}, {T: 65}, {T: 70}, {T: 75}}
	p := poolBlock(s, EventWindow{StartS: 58, EndS: 62, RecoveryS: 60})
	if p.OKSamples != 0 || p.LongestScrapeGapS != 20 || p.RecoveryS != nil {
		t.Fatalf("%+v", p)
	}
}

// wedged -1 (detector idle) is unknown: it neither blocks recovery nor counts as wedged.
func TestPoolWedgedUnknown(t *testing.T) {
	s := []PoolSample{{T: 70, OK: true, Permits: 30, Effective: 30, Wedged: -1}}
	p := poolBlock(s, EventWindow{StartS: 58, EndS: 62, RecoveryS: 60})
	if p.RecoveryS == nil || *p.RecoveryS != 8 || p.MaxWedged != 0 || p.WedgedUnknown != 1 {
		t.Fatalf("%+v", p)
	}
}

func TestGates(t *testing.T) {
	ev := StormEvent{Name: "kill",
		Heartbeat: HeartbeatBlock{Storm: LatencyReport{Count: 50, P95: 1400}, Recovery: LatencyReport{Count: 80, P95: 300}, MaxGapS: 70},
		Pool:      PoolBlock{OKSamples: 3, MinEffectiveRatio: 0.9, RecoveryS: ptr(12.0)},
		Errors:    ErrorBlock{LostPct: 0.5}}
	g := Gates{HeartbeatP95: time.Second, PoolMinRatio: 0.8, PoolRecovery: 30 * time.Second, MaxGap: 180 * time.Second, LostPct: 1}
	res := evaluateGates([]StormEvent{ev}, g)
	if len(res) != 5 {
		t.Fatalf("five set gates, one event: want 5 results, got %+v", res)
	}
	failed := map[string]bool{}
	for _, r := range res {
		if !r.Pass {
			failed[r.Gate] = true
		}
	}
	if len(failed) != 1 || !failed["heartbeat-p95"] {
		t.Fatalf("only heartbeat-p95 (storm phase 1.4 s) should fail: %+v", res)
	}
	empty := StormEvent{Name: "x", Heartbeat: HeartbeatBlock{}}
	for _, r := range evaluateGates([]StormEvent{empty}, Gates{HeartbeatP95: time.Second, PoolMinRatio: 0.8, PoolRecovery: time.Minute, MaxGap: time.Minute}) {
		if r.Pass {
			t.Fatalf("a gate with no data must fail, not pass: %+v", r)
		}
	}
	if res := evaluateGates([]StormEvent{ev}, Gates{}); len(res) != 0 {
		t.Fatalf("no gate flags, no gates: %+v", res)
	}
	noRecovery := ev
	noRecovery.Pool.RecoveryS = nil
	for _, r := range evaluateGates([]StormEvent{noRecovery}, Gates{PoolRecovery: 30 * time.Second}) {
		if r.Pass || r.Value != nil {
			t.Fatalf("a pool that never recovered fails with a null value: %+v", r)
		}
	}
}

func TestBuildReportWithAStormFillsTheSections(t *testing.T) {
	t0 := time.Now().Add(-10 * time.Minute)
	rec := NewRecorder("r", t0, t0.Add(time.Minute), t0.Add(10*time.Minute))
	rec.EnableTimeline(time.Second, 10*time.Minute)
	cfg := validConfig()
	cfg.Storm = &Scenario{Name: "kill", Events: []Event{{Name: "kill", At: Duration{2 * time.Minute}, Start: []Action{{Internal: ActionDropSockets}}}}}
	cfg.Gates = Gates{PoolMinRatio: 0.8}
	in := &StormInputs{
		Events:  []ScheduledEvent{{Name: "kill", PreWindow: time.Minute, Start: t0.Add(3 * time.Minute), End: t0.Add(3 * time.Minute), Recovery: 3 * time.Minute}},
		Steps:   []StepRecord{{Event: "kill", Phase: "start", Internal: ActionDropSockets, OK: true}},
		Samples: []PoolSample{{T: 200, OK: true, Permits: 30, Effective: 10}}, URL: "http://x/metrics/scrape", Sampled: true,
	}
	r := BuildReport(rec, cfg, t0.Add(10*time.Minute), 1, in)
	if r.Timeline == nil || r.Pool == nil || r.Storm == nil || len(r.Storm.Events) != 1 {
		t.Fatalf("sections missing: %+v", r.Storm)
	}
	if r.Storm.Pass || len(r.Storm.Gates) != 1 || r.Storm.Gates[0].Gate != "pool-min-ratio" {
		t.Fatalf("pool at 1/3 must fail the 0.8 gate: %+v", r.Storm.Gates)
	}
	data, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "tok") {
		t.Fatal("the scrape token must never reach the report")
	}
}

func TestBuildReportStepFailureIsCounted(t *testing.T) {
	t0 := time.Now().Add(-10 * time.Minute)
	rec := NewRecorder("r", t0, t0.Add(time.Minute), t0.Add(10*time.Minute))
	rec.EnableTimeline(time.Second, 10*time.Minute)
	cfg := validConfig()
	cfg.Storm = &Scenario{Name: "kill", Events: []Event{{Name: "kill", At: Duration{2 * time.Minute}, Start: []Action{{Internal: ActionDropSockets}}}}}
	in := &StormInputs{Steps: []StepRecord{{Event: "kill", Phase: "start", Argv: []string{"docker", "kill", "c"}, OK: false, Output: "no such container"}}}
	r := BuildReport(rec, cfg, t0.Add(10*time.Minute), 1, in)
	if r.Storm.StepsFailed != 1 || r.Storm.EventsPlanned != 1 || len(r.Storm.Events) != 0 {
		t.Fatalf("a failed step and an event that never ran must be visible: %+v", r.Storm)
	}
}
