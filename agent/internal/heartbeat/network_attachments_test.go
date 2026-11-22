package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/netattach"
)

var netAttachT0 = time.Date(2026, 11, 20, 15, 4, 5, 0, time.UTC)

// testNetAttachReporter replaces open with a real state in a temp dir and
// build with fn, counting how often build is entered.
func testNetAttachReporter(t *testing.T, fn func(ctx context.Context, n int32) netattach.Report) (*netAttachReporter, *atomic.Int32) {
	t.Helper()
	r := newNetAttachReporter(filepath.Join(t.TempDir(), "network-attachment-state.json"))
	entered := &atomic.Int32{}
	r.build = func(ctx context.Context, _ *netattach.State, _ string, _ time.Time) netattach.Report {
		return fn(ctx, entered.Add(1))
	}
	return r, entered
}

func sampleReport(seq int32) netattach.Report {
	return netattach.Report{Epoch: "9f2c1e7ab4d04c11", Sequence: uint64(seq), CapturedAt: "2026-11-20T15:04:05Z", Complete: true, Attachments: []netattach.ReportAttachment{}}
}

// waitNetAttachIdle waits until no read is in flight.
func waitNetAttachIdle(t *testing.T, r *netAttachReporter) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		busy := r.inflight
		r.mu.Unlock()
		if !busy {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("read still in flight")
}

func TestNetAttachReporter_SlowReadNeverBlocksBeat(t *testing.T) {
	release := []chan struct{}{make(chan struct{}), make(chan struct{})}
	r, entered := testNetAttachReporter(t, func(_ context.Context, n int32) netattach.Report {
		if n <= 2 {
			<-release[n-1]
		}
		return sampleReport(n)
	})
	stop := make(chan struct{})
	start := time.Now()
	if got := r.attach(netAttachT0, "breeze.example", stop); got != nil {
		t.Fatalf("first beat carried %+v", got)
	}
	if elapsed := time.Since(start); elapsed > 100*time.Millisecond {
		t.Fatalf("attach blocked for %v", elapsed)
	}
	close(release[0])
	waitNetAttachIdle(t, r)
	// The next beat takes the finished report and starts the next read.
	got := r.attach(netAttachT0.Add(time.Minute), "breeze.example", stop)
	if got == nil || got.Sequence != 1 {
		t.Fatalf("second beat = %+v, want the finished report", got)
	}
	for deadline := time.Now().Add(5 * time.Second); entered.Load() < 2; time.Sleep(time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("second read never started")
		}
	}
	// The one after, with that read still running, carries nothing: the
	// report is handed out once, and no other read starts.
	if got := r.attach(netAttachT0.Add(2*time.Minute), "breeze.example", stop); got != nil {
		t.Fatalf("report handed out twice: %+v", got)
	}
	close(release[1])
	waitNetAttachIdle(t, r)
	if entered.Load() != 2 {
		t.Fatalf("build entered %d times, want 2", entered.Load())
	}
	if got := r.attach(netAttachT0.Add(3*time.Minute), "breeze.example", stop); got == nil || got.Sequence != 2 {
		t.Fatalf("fourth beat = %+v, want the second read's report", got)
	}
}

func TestNetAttachReporter_OneReadAtATime(t *testing.T) {
	release := make(chan struct{})
	r, entered := testNetAttachReporter(t, func(_ context.Context, n int32) netattach.Report {
		<-release
		return sampleReport(n)
	})
	stop := make(chan struct{})
	for i := 0; i < 5; i++ {
		if got := r.attach(netAttachT0.Add(time.Duration(i)*time.Minute), "breeze.example", stop); got != nil {
			t.Fatalf("beat %d carried %+v", i, got)
		}
	}
	close(release)
	waitNetAttachIdle(t, r)
	if entered.Load() != 1 {
		t.Fatalf("build entered %d times, want 1", entered.Load())
	}
}

func TestNetAttachReporter_ReadPastBoundIsDiscarded(t *testing.T) {
	r, entered := testNetAttachReporter(t, func(_ context.Context, n int32) netattach.Report {
		if n == 1 {
			time.Sleep(100 * time.Millisecond) // ignores ctx
		}
		return sampleReport(n)
	})
	r.bound = 50 * time.Millisecond
	stop := make(chan struct{})
	r.attach(netAttachT0, "breeze.example", stop)
	waitNetAttachIdle(t, r)
	if got := r.attach(netAttachT0.Add(time.Minute), "breeze.example", stop); got != nil {
		t.Fatalf("overrun read was attached: %+v", got)
	}
	waitNetAttachIdle(t, r)
	if entered.Load() != 2 {
		t.Fatalf("build entered %d times, want a new read after the overrun", entered.Load())
	}
}

func TestNetAttachReporter_ContextIsBounded(t *testing.T) {
	var deadline atomic.Value
	r, _ := testNetAttachReporter(t, func(ctx context.Context, n int32) netattach.Report {
		d, ok := ctx.Deadline()
		if ok {
			deadline.Store(time.Until(d))
		}
		return sampleReport(n)
	})
	r.attach(netAttachT0, "breeze.example", make(chan struct{}))
	waitNetAttachIdle(t, r)
	d, _ := deadline.Load().(time.Duration)
	if d <= 0 || d > 3*time.Second {
		t.Fatalf("read context deadline in %v, want within 3s", d)
	}
}

func TestNetAttachReporter_StopCancelsRead(t *testing.T) {
	r, _ := testNetAttachReporter(t, func(ctx context.Context, n int32) netattach.Report {
		<-ctx.Done()
		return sampleReport(n)
	})
	r.bound = time.Hour
	stop := make(chan struct{})
	r.attach(netAttachT0, "breeze.example", stop)
	close(stop)
	waitNetAttachIdle(t, r)
	if got := r.attach(netAttachT0.Add(time.Minute), "breeze.example", stop); got != nil {
		t.Fatalf("report read during shutdown was attached: %+v", got)
	}
}

func TestNetAttachReporter_OldReportIsDropped(t *testing.T) {
	r, _ := testNetAttachReporter(t, func(_ context.Context, n int32) netattach.Report { return sampleReport(n) })
	stop := make(chan struct{})
	r.attach(netAttachT0, "breeze.example", stop)
	waitNetAttachIdle(t, r)
	if got := r.attach(netAttachT0.Add(6*time.Minute), "breeze.example", stop); got != nil {
		t.Fatalf("report started 6 minutes before the beat was attached: %+v", got)
	}
	waitNetAttachIdle(t, r)
	if got := r.attach(netAttachT0.Add(7*time.Minute), "breeze.example", stop); got == nil {
		t.Fatal("fresh report after the dropped one was not attached")
	}
}

func TestNetAttachReporter_ZeroReportNotAttached(t *testing.T) {
	r, _ := testNetAttachReporter(t, func(context.Context, int32) netattach.Report { return netattach.Report{} })
	stop := make(chan struct{})
	for i := 0; i < 4; i++ {
		if got := r.attach(netAttachT0.Add(time.Duration(i)*time.Minute), "breeze.example", stop); got != nil {
			t.Fatalf("beat %d carried %+v", i, got)
		}
		waitNetAttachIdle(t, r)
	}
}

func TestNetAttachReporter_PanicInReadIsRecovered(t *testing.T) {
	r, _ := testNetAttachReporter(t, func(_ context.Context, n int32) netattach.Report {
		if n == 1 {
			panic("boom")
		}
		return sampleReport(n)
	})
	stop := make(chan struct{})
	r.attach(netAttachT0, "breeze.example", stop)
	waitNetAttachIdle(t, r)
	if got := r.attach(netAttachT0.Add(time.Minute), "breeze.example", stop); got != nil {
		t.Fatalf("panicked read attached %+v", got)
	}
	waitNetAttachIdle(t, r)
	if got := r.attach(netAttachT0.Add(2*time.Minute), "breeze.example", stop); got == nil || got.Sequence != 2 {
		t.Fatalf("read after the panic = %+v", got)
	}
}

func TestNetAttachReporter_StateOpenFailure(t *testing.T) {
	r, entered := testNetAttachReporter(t, func(_ context.Context, n int32) netattach.Report { return sampleReport(n) })
	realOpen := r.open
	opens := 0
	r.open = func() (*netattach.State, error) {
		opens++
		if opens <= 2 {
			return nil, errors.New("no entropy")
		}
		return realOpen()
	}
	stop := make(chan struct{})
	for i := 0; i < 2; i++ {
		if got := r.attach(netAttachT0.Add(time.Duration(i)*time.Minute), "breeze.example", stop); got != nil {
			t.Fatalf("beat %d carried %+v", i, got)
		}
	}
	if entered.Load() != 0 {
		t.Fatalf("read started without a state")
	}
	r.attach(netAttachT0.Add(2*time.Minute), "breeze.example", stop)
	waitNetAttachIdle(t, r)
	if got := r.attach(netAttachT0.Add(3*time.Minute), "breeze.example", stop); got == nil {
		t.Fatal("no report once the state opened")
	}
	if opens != 3 {
		t.Fatalf("opened %d times, want 3 (kept once open)", opens)
	}
}

func TestHeartbeatPayload_NetworkAttachmentsV1Key(t *testing.T) {
	report := sampleReport(418)
	with, err := json.Marshal(HeartbeatPayload{NetworkAttachmentsV1: &report})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(with), `"networkAttachmentsV1":{"epoch":`) {
		t.Fatalf("payload = %s", with)
	}
	without, err := json.Marshal(HeartbeatPayload{})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(without), "networkAttachmentsV1") {
		t.Fatalf("absent report still sent the key: %s", without)
	}
}

func TestAttachNetworkAttachments_NilReporterIsNoop(t *testing.T) {
	var p HeartbeatPayload
	(&Heartbeat{}).attachNetworkAttachments(&p)
	if p.NetworkAttachmentsV1 != nil {
		t.Fatalf("field = %+v", p.NetworkAttachmentsV1)
	}
}
