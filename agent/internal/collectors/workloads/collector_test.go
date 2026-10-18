package workloads

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

type stubDriver struct {
	rt        Runtime
	detect    func(context.Context) Detection
	collect   func(context.Context, Detection) Result
	collected int
}

func (s *stubDriver) Runtime() Runtime                   { return s.rt }
func (s *stubDriver) Detect(c context.Context) Detection { return s.detect(c) }
func (s *stubDriver) Collect(c context.Context, d Detection) Result {
	s.collected++
	return s.collect(c, d)
}

func presentDriver(rt Runtime, ws ...Workload) *stubDriver {
	return &stubDriver{
		rt:     rt,
		detect: func(context.Context) Detection { return Detection{State: DetectionPresent, Version: "1.2.3"} },
		collect: func(context.Context, Detection) Result {
			return Result{Collection: CollectionOK, Complete: true, Workloads: ws, ObservedCount: len(ws)}
		},
	}
}

func wl(id string) Workload {
	return Workload{WorkloadID: id, Kind: KindContainer, Name: id, State: StateRunning}
}

func enabled() Settings { s := DefaultSettings(); s.Enabled = true; return s }

var fixedNow = func() time.Time { return time.Date(2026, 10, 6, 12, 0, 0, 123456789, time.UTC) }

func TestCollectorDetectsAlwaysButCollectsOnlyWhenEnabled(t *testing.T) {
	docker, podman := presentDriver(RuntimeDocker, wl("a")), presentDriver(RuntimePodman, wl("b"))
	c := New([]Driver{docker, podman}, WithClock(fixedNow))

	s := enabled()
	s.Podman = false
	rep := c.Collect(context.Background(), s)
	if rep.CollectedAt != "2026-10-06T12:00:00.123Z" || rep.ProtocolVersion != 1 {
		t.Fatalf("header = %+v", rep)
	}
	if docker.collected != 1 || podman.collected != 0 {
		t.Fatalf("collect calls docker=%d podman=%d", docker.collected, podman.collected)
	}
	d, p := rep.Runtimes[0], rep.Runtimes[1]
	if d.Collection != CollectionOK || len(d.Workloads) != 1 || d.RuntimeVersion == nil || *d.RuntimeVersion != "1.2.3" {
		t.Fatalf("docker = %+v", d)
	}
	if p.Detection != DetectionPresent || p.Collection != CollectionDisabled || !p.Complete || len(p.Workloads) != 0 || p.RuntimeVersion == nil {
		t.Fatalf("podman = %+v", p)
	}

	// Master switch off (the default): detection only, nothing enumerated.
	docker.collected = 0
	rep = c.Collect(context.Background(), DefaultSettings())
	if docker.collected != 0 {
		t.Fatal("Collect ran while the master switch is off")
	}
	for _, r := range rep.Runtimes {
		if r.Detection != DetectionPresent || r.Collection != CollectionDisabled || len(r.Workloads) != 0 {
			t.Fatalf("runtime = %+v", r)
		}
	}
}

func TestCollectorMapsDetectionStates(t *testing.T) {
	absent := &stubDriver{rt: RuntimeDocker, detect: func(context.Context) Detection { return Detection{State: DetectionAbsent} }}
	unknown := &stubDriver{rt: RuntimePodman, detect: func(context.Context) Detection {
		return Detection{State: DetectionUnknown, Reason: ReasonTimeout}
	}}
	garbage := &stubDriver{rt: RuntimeContainerd, detect: func(context.Context) Detection { return Detection{State: "maybe"} }}
	rep := New([]Driver{absent, unknown, garbage}, WithClock(fixedNow)).Collect(context.Background(), enabled())
	a, u, g := rep.Runtimes[0], rep.Runtimes[1], rep.Runtimes[2]
	if a.Detection != DetectionAbsent || a.Collection != CollectionUnavailable || !a.Complete || a.RuntimeVersion != nil {
		t.Fatalf("absent = %+v", a)
	}
	if u.Detection != DetectionUnknown || u.Complete || u.Error == nil || *u.Error != ReasonTimeout {
		t.Fatalf("unknown = %+v", u)
	}
	if g.Detection != DetectionUnknown {
		t.Fatalf("invalid detection state not coerced: %+v", g)
	}
	for _, r := range rep.Runtimes {
		if r.Workloads == nil {
			t.Fatal("workloads must serialize as [] never null")
		}
	}
}

func TestCollectorPanicDegradesOnlyThatRuntime(t *testing.T) {
	bad := &stubDriver{
		rt:      RuntimeDocker,
		detect:  func(context.Context) Detection { return Detection{State: DetectionPresent} },
		collect: func(context.Context, Detection) Result { panic("driver bug") },
	}
	badDetect := &stubDriver{rt: RuntimeContainerd, detect: func(context.Context) Detection { panic("detect bug") }}
	good := presentDriver(RuntimePodman, wl("ok"))
	rep := New([]Driver{bad, good, badDetect}, WithClock(fixedNow)).Collect(context.Background(), enabled())
	if r := rep.Runtimes[0]; r.Collection != CollectionError || r.Error == nil || *r.Error != ReasonPanic || len(r.Workloads) != 0 {
		t.Fatalf("panicking collect = %+v", r)
	}
	if r := rep.Runtimes[1]; r.Collection != CollectionOK || len(r.Workloads) != 1 {
		t.Fatalf("healthy driver affected: %+v", r)
	}
	if r := rep.Runtimes[2]; r.Detection != DetectionUnknown || r.Error == nil || *r.Error != ReasonPanic {
		t.Fatalf("panicking detect = %+v", r)
	}
}

func TestCollectorGivesEachDriverItsOwnTimeout(t *testing.T) {
	slow := &stubDriver{
		rt: RuntimeDocker,
		detect: func(ctx context.Context) Detection {
			<-ctx.Done()
			return Detection{State: DetectionUnknown, Reason: ReasonTimeout}
		},
	}
	fast := presentDriver(RuntimePodman, wl("x"))
	start := time.Now()
	rep := New([]Driver{slow, fast}, WithDriverTimeout(50*time.Millisecond), WithClock(fixedNow)).Collect(context.Background(), enabled())
	if time.Since(start) > 5*time.Second {
		t.Fatal("slow driver was not bounded")
	}
	if rep.Runtimes[1].Collection != CollectionOK {
		t.Fatalf("fast driver starved by slow one: %+v", rep.Runtimes[1])
	}
}

func TestCollectorReturnsNilWithoutDriversOrWhenCancelled(t *testing.T) {
	if New(nil).Collect(context.Background(), enabled()) != nil {
		t.Fatal("no drivers must mean no report")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if New([]Driver{presentDriver(RuntimeDocker)}).Collect(ctx, enabled()) != nil {
		t.Fatal("cancelled collection must not produce a report")
	}
}

func TestCollectorBoundsDriverOutput(t *testing.T) {
	long := wl("id")
	long.Name = strings.Repeat("n", 1000)
	many := make([]Workload, 0, MaxWorkloadsPerRuntime+10)
	for i := 0; i < MaxWorkloadsPerRuntime+5; i++ {
		many = append(many, wl(fmt.Sprintf("w%04d", i)))
	}
	// Explicit duplicates: the API rejects a whole report that repeats a
	// workloadId, so the first occurrence (priority order) must win.
	dupFirst, dupSecond := wl("w0000"), wl("w0001")
	dupFirst.Name, dupSecond.Name = "later-duplicate-0", "later-duplicate-1"
	many = append(many, dupFirst, dupSecond, many[10])
	d := &stubDriver{
		rt:     RuntimeDocker,
		detect: func(context.Context) Detection { return Detection{State: DetectionPresent} },
		collect: func(context.Context, Detection) Result {
			return Result{Collection: CollectionOK, Complete: true, Workloads: append(append([]Workload(nil), many...), long), Error: "line1\nline2"}
		},
	}
	r := New([]Driver{d}, WithClock(fixedNow)).Collect(context.Background(), enabled()).Runtimes[0]
	if len(r.Workloads) != MaxWorkloadsPerRuntime || r.Complete {
		t.Fatalf("cap not enforced: len=%d complete=%v", len(r.Workloads), r.Complete)
	}
	if r.ObservedCount < MaxWorkloadsPerRuntime+5 || *r.Error != "line1 line2" {
		t.Fatalf("observed=%d error=%q", r.ObservedCount, *r.Error)
	}
	seen := map[string]bool{}
	for _, w := range r.Workloads {
		if seen[w.WorkloadID] {
			t.Fatalf("duplicate workloadId %q reached the report", w.WorkloadID)
		}
		seen[w.WorkloadID] = true
		if strings.HasPrefix(w.Name, "later-duplicate") {
			t.Fatalf("a later duplicate replaced the first occurrence of %q", w.WorkloadID)
		}
	}
	d.collect = func(context.Context, Detection) Result { return Result{Collection: "weird"} }
	if r := New([]Driver{d}, WithClock(fixedNow)).Collect(context.Background(), enabled()).Runtimes[0]; r.Collection != CollectionError {
		t.Fatalf("invalid collection state not coerced: %+v", r)
	}
}

func TestFailedCollectionNeverCarriesWorkloads(t *testing.T) {
	d := &stubDriver{
		rt:     RuntimeDocker,
		detect: func(context.Context) Detection { return Detection{State: DetectionPresent} },
		collect: func(context.Context, Detection) Result {
			return Result{Collection: CollectionUnavailable, Workloads: []Workload{wl("stale")}, Error: "daemon_unreachable"}
		},
	}
	r := New([]Driver{d}, WithClock(fixedNow)).Collect(context.Background(), enabled()).Runtimes[0]
	if len(r.Workloads) != 0 || r.ObservedCount != 0 || r.Complete {
		t.Fatalf("runtime = %+v", r)
	}
}

func TestFitPayloadKeepsReportUnderTheBodyLimit(t *testing.T) {
	big := func(rt Runtime, n int) RuntimeReport {
		ws := make([]Workload, n)
		for i := range ws {
			ws[i] = wl(strings.Repeat("z", 100) + string(rune('A'+i%26)))
			ws[i].Name = strings.Repeat("n", 250)
		}
		return RuntimeReport{Runtime: rt, Detection: DetectionPresent, Collection: CollectionOK, Complete: true, Workloads: ws, ObservedCount: n}
	}
	r := &Report{ProtocolVersion: 1, CollectedAt: "2026-10-06T12:00:00Z", Runtimes: []RuntimeReport{big(RuntimeDocker, 1000), big(RuntimePodman, 100)}}
	r.fitPayload(200_000)
	raw, _ := json.Marshal(r)
	if len(raw) > 200_000 {
		t.Fatalf("payload = %d bytes", len(raw))
	}
	if r.Runtimes[0].Complete || len(r.Runtimes[0].Workloads) >= 1000 {
		t.Fatal("largest runtime must be trimmed and marked incomplete")
	}
	if len(r.Runtimes[1].Workloads) == 0 {
		t.Fatal("the smaller runtime should not be emptied")
	}
	if r.Runtimes[0].ObservedCount != 1000 {
		t.Fatal("observedCount must keep the true count")
	}
}

func TestHashIgnoresCollectedAtAndOrderButNotContent(t *testing.T) {
	mk := func(at string, ids ...string) *Report {
		var ws []Workload
		for _, id := range ids {
			ws = append(ws, wl(id))
		}
		return &Report{ProtocolVersion: 1, CollectedAt: at, Runtimes: []RuntimeReport{
			{Runtime: RuntimePodman, Detection: DetectionAbsent, Collection: CollectionUnavailable, Complete: true, Workloads: []Workload{}},
			{Runtime: RuntimeDocker, Detection: DetectionPresent, Collection: CollectionOK, Complete: true, Workloads: ws},
		}}
	}
	base := mk("2026-10-06T12:00:00Z", "a", "b")
	if base.Hash() != mk("2026-10-06T13:00:00Z", "b", "a").Hash() {
		t.Fatal("hash must ignore collectedAt, runtime order and workload order")
	}
	if base.Hash() == mk("2026-10-06T12:00:00Z", "a", "b", "c").Hash() {
		t.Fatal("added workload must change the hash")
	}
	changed := mk("2026-10-06T12:00:00Z", "a", "b")
	changed.Runtimes[1].Workloads[0].State = StateStopped
	if base.Hash() == changed.Hash() {
		t.Fatal("state change must change the hash")
	}
	status := mk("2026-10-06T12:00:00Z", "a", "b")
	status.Runtimes[1].Complete = false
	if base.Hash() == status.Hash() {
		t.Fatal("completeness change must change the hash")
	}
	status = mk("2026-10-06T12:00:00Z", "a", "b")
	status.Runtimes[1].Collection = CollectionDisabled
	if base.Hash() == status.Hash() {
		t.Fatal("collection change must change the hash")
	}
	// Hash must not reorder the caller's slices.
	if base.Runtimes[0].Runtime != RuntimePodman {
		t.Fatal("Hash mutated the report")
	}
}

// End to end through the collector: a stopped daemon is reported as present +
// unavailable when enumeration is on, as disabled when it is off, and neither
// path dials.
func TestCollectorReportsStoppedDaemonWithoutDialing(t *testing.T) {
	h := newDockerHost(t)
	c := New([]Driver{h.driver(noDial(t))}, WithClock(fixedNow))

	on := c.Collect(context.Background(), enabled()).Runtimes[0]
	if on.Detection != DetectionPresent || on.Collection != CollectionUnavailable || on.Error == nil || *on.Error != "daemon not running" || len(on.Workloads) != 0 || on.RuntimeVersion != nil {
		t.Fatalf("enabled = %+v", on)
	}
	off := c.Collect(context.Background(), DefaultSettings()).Runtimes[0]
	if off.Detection != DetectionPresent || off.Collection != CollectionDisabled {
		t.Fatalf("disabled = %+v", off)
	}
}
