package workloads

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// These tests pin the ingest rules W01 added to workloadsReportSchema after the
// plan was written. Each one, if broken, makes the server reject the whole
// report with a 400, so an agent would silently stop reporting for that host.

// Postgres text columns reject U+0000, so the schema refuses any string that
// contains it. Every bounded field goes through clip, so stripping there covers
// workload fields and the runtime version alike.
func TestBoundStripsNULFromEveryString(t *testing.T) {
	nul := "a\x00b"
	w := Workload{
		WorkloadID: "id\x00", Name: nul, RawState: ptr(nul), ImageRef: ptr(nul),
		ImageRepository: ptr(nul), ImageTag: ptr(nul), ImageDigest: ptr(nul), ImageID: ptr(nul),
		GuestOS: ptr(nul), ComposeProject: ptr(nul), ComposeService: ptr(nul),
		ComposeWorkingDir: ptr(nul), RestartPolicy: ptr(nul),
	}
	w.Bound()
	raw, err := json.Marshal(w)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `\u0000`) {
		t.Fatalf("NUL survived Bound: %s", raw)
	}
	if w.Name != "ab" || w.WorkloadID != "id" {
		t.Fatalf("NUL not stripped: name=%q id=%q", w.Name, w.WorkloadID)
	}
	if got := ptr("\x00"); clipPtr(got, 10) != nil {
		t.Fatal("a value that is only NUL must become null")
	}
}

func TestCollectorStripsNULFromRuntimeVersion(t *testing.T) {
	d := presentDriver(RuntimeDocker, wl("a"))
	d.detect = func(context.Context) Detection { return Detection{State: DetectionPresent, Version: "27\x00.1"} }
	rep := New([]Driver{d}, WithClock(fixedNow)).Collect(context.Background(), enabled())
	if v := rep.Runtimes[0].RuntimeVersion; v == nil || *v != "27.1" {
		t.Fatalf("runtimeVersion = %v", v)
	}
}

// workloadId and name are min(1) on the server. A workload with no usable id
// cannot be keyed and is dropped; one with no name falls back to its id.
func TestCollectorDropsWorkloadsWithoutIDAndNamesTheNameless(t *testing.T) {
	noName := wl("bbbbbbbbbbbbbbbbbbbb")
	noName.Name = "\x00"
	d := presentDriver(RuntimeDocker, wl(""), wl("\x00"), noName, wl("a"))
	rep := New([]Driver{d}, WithClock(fixedNow)).Collect(context.Background(), enabled())
	rt := rep.Runtimes[0]
	if len(rt.Workloads) != 2 {
		t.Fatalf("workloads = %+v", rt.Workloads)
	}
	for _, w := range rt.Workloads {
		if w.WorkloadID == "" || w.Name == "" {
			t.Fatalf("empty id or name reached the report: %+v", w)
		}
	}
	if rt.Workloads[0].Name != "bbbbbbbbbbbb" {
		t.Fatalf("nameless workload name = %q, want the 12-char id prefix", rt.Workloads[0].Name)
	}
}

// Two ids that only differ beyond the 128-byte bound are the same id on the
// server; dedupe must run on the bounded value.
func TestCollectorDedupesOnTheBoundedID(t *testing.T) {
	base := strings.Repeat("c", 128)
	d := presentDriver(RuntimeDocker, wl(base+"1"), wl(base+"2"))
	rep := New([]Driver{d}, WithClock(fixedNow)).Collect(context.Background(), enabled())
	if n := len(rep.Runtimes[0].Workloads); n != 1 {
		t.Fatalf("workloads = %d, want 1 after bounding", n)
	}
}

// collection "ok" is authoritative on the server (it deletes by absence), so it
// is accepted only with detection "present" on an enumerated runtime.
// containerd is detect-only: even a driver that claims ok must not say so.
func TestCollectorNeverReportsOKOutsidePresentEnumeratedRuntimes(t *testing.T) {
	ctrd := presentDriver(RuntimeContainerd, wl("x"))
	unknown := presentDriver(RuntimePodman, wl("y"))
	unknown.detect = func(context.Context) Detection { return Detection{State: "weird"} }
	absent := presentDriver(RuntimeDocker, wl("z"))
	absent.detect = func(context.Context) Detection { return Detection{State: DetectionAbsent} }

	rep := New([]Driver{ctrd, unknown, absent}, WithClock(fixedNow)).Collect(context.Background(), enabled())
	for _, rt := range rep.Runtimes {
		if rt.Collection == CollectionOK && (rt.Detection != DetectionPresent || rt.Runtime == RuntimeContainerd) {
			t.Fatalf("%s reported ok with detection %s", rt.Runtime, rt.Detection)
		}
		if rt.Collection != CollectionOK && len(rt.Workloads) != 0 {
			t.Fatalf("%s carried workloads on collection %s", rt.Runtime, rt.Collection)
		}
	}
	if c := rep.Runtimes[0].Collection; c != CollectionUnsupported {
		t.Fatalf("containerd collection = %s, want unsupported", c)
	}
	if unknown.collected != 0 || absent.collected != 0 {
		t.Fatalf("Collect ran without a present detection: unknown=%d absent=%d", unknown.collected, absent.collected)
	}
}

// A shutdown that lands while the last driver runs turns its in-flight requests
// into errors; that report describes the cancellation, not the host, and must
// not be returned.
func TestCollectorReturnsNilWhenCancelledDuringTheLastDriver(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	last := presentDriver(RuntimePodman)
	last.collect = func(context.Context, Detection) Result {
		cancel()
		return Result{Collection: CollectionError, Error: "request_failed"}
	}
	if rep := New([]Driver{presentDriver(RuntimeDocker, wl("a")), last}, WithClock(fixedNow)).Collect(ctx, enabled()); rep != nil {
		t.Fatalf("report built during shutdown was returned: %+v", rep.Runtimes)
	}
}
