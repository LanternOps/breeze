package heartbeat

import (
	"context"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/hpwarrantyobserve"
)

// observeRig drives the observe schedule with a fake clock, a fake collector
// and a captured emitter.
type observeRig struct {
	h        *Heartbeat
	now      time.Time
	mu       sync.Mutex
	modes    []string
	emitted  []*hpwarrantyobserve.Observation
	block    chan struct{}
	collectN int
}

func newObserveRig(t *testing.T) *observeRig {
	t.Helper()
	orig := persistWarrantyCollectionEnabled
	t.Cleanup(func() { persistWarrantyCollectionEnabled = orig })
	persistWarrantyCollectionEnabled = func(bool) error { return nil }

	r := &observeRig{now: time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)}
	cfg := config.Default()
	cfg.AgentID = "agent-observe-test"
	r.h = &Heartbeat{config: cfg}
	r.h.hpWarrantyNow = func() time.Time {
		r.mu.Lock()
		defer r.mu.Unlock()
		return r.now
	}
	r.h.hpWarranty.collect = func(ctx context.Context, mode string) *hpwarrantyobserve.Observation {
		r.mu.Lock()
		r.collectN++
		r.modes = append(r.modes, mode)
		block := r.block
		r.mu.Unlock()
		if block != nil {
			<-block
		}
		if _, ok := ctx.Deadline(); !ok {
			t.Error("observe ran without a deadline")
		}
		return &hpwarrantyobserve.Observation{SchemaVersion: 1, Mode: mode}
	}
	r.h.hpWarranty.emit = func(o *hpwarrantyobserve.Observation) {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.emitted = append(r.emitted, o)
	}
	// The start-up delay is anchored at the first warranty block after start;
	// this is that block, with no mode.
	r.beat(map[string]any{"hp_cmsl_enabled": false})
	return r
}

func (r *observeRig) advance(d time.Duration) {
	r.mu.Lock()
	r.now = r.now.Add(d)
	r.mu.Unlock()
}

// beat applies a warranty block and waits for any observe it started.
func (r *observeRig) beat(block map[string]any) {
	r.h.applyConfigUpdate(map[string]any{"warranty_settings": block})
	r.h.inventoryWg.Wait()
}

func (r *observeRig) count() (collects, emits int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.collectN, len(r.emitted)
}

func modeBlock(mode string) map[string]any {
	return map[string]any{"hp_cmsl_enabled": mode == "act", "hp_cmsl_mode": mode, "hp_cmsl_tiers": []any{}}
}

func TestShipAlwaysRecordOncePer24h(t *testing.T) {
	r := newObserveRig(t)

	// The first beat is inside the start-up delay: nothing runs yet.
	r.beat(modeBlock("observe"))
	if c, _ := r.count(); c != 0 {
		t.Fatalf("observed %d times inside the first delay", c)
	}
	r.advance(hpObserveMaxFirstDelay)
	r.beat(modeBlock("observe"))
	if c, e := r.count(); c != 1 || e != 1 {
		t.Fatalf("after the first delay: collects=%d emits=%d, want 1/1", c, e)
	}

	// Every heartbeat for the next 24 h: no second record.
	for range 24 * 60 {
		r.advance(time.Minute - time.Second)
		r.beat(modeBlock("observe"))
	}
	if c, _ := r.count(); c != 1 {
		t.Fatalf("observed %d times within 24 h, want 1", c)
	}
	r.advance(time.Hour)
	r.beat(modeBlock("observe"))
	if c, e := r.count(); c != 2 || e != 2 {
		t.Fatalf("after 24 h: collects=%d emits=%d, want 2/2", c, e)
	}
}

func TestObserveOncePerModeChange(t *testing.T) {
	r := newObserveRig(t)
	r.advance(hpObserveMaxFirstDelay)
	r.beat(modeBlock("observe"))
	r.advance(time.Minute)
	r.beat(modeBlock("act"))
	r.advance(time.Minute)
	r.beat(modeBlock("act"))
	if c, _ := r.count(); c != 2 {
		t.Fatalf("collects = %d, want 2 (observe, then once on the change to act)", c)
	}
	if r.modes[0] != "observe" || r.modes[1] != "act" {
		t.Fatalf("modes = %v", r.modes)
	}
}

func TestObserveNeedsFreshMode(t *testing.T) {
	r := newObserveRig(t)
	r.advance(hpObserveMaxFirstDelay)

	// off, or a block from an older server with the legacy flag only.
	r.beat(modeBlock("off"))
	r.beat(map[string]any{"hp_cmsl_enabled": true})
	if c, _ := r.count(); c != 0 {
		t.Fatalf("observed %d times without a fresh observe/act mode", c)
	}

	// A persisted legacy true alone, through any number of beats without the
	// block, never observes.
	r.h.config.HPWarrantyCollectionEnabled = true
	r.h.applyConfigUpdate(map[string]any{"event_log_settings": map[string]any{}})
	r.h.maybeStartHpWarrantyObserve()
	r.h.inventoryWg.Wait()
	if c, _ := r.count(); c != 0 {
		t.Fatalf("observed %d times on the persisted flag alone", c)
	}
}

func TestObserveSingleFlight(t *testing.T) {
	r := newObserveRig(t)
	r.block = make(chan struct{})
	r.advance(hpObserveMaxFirstDelay)
	r.h.applyConfigUpdate(map[string]any{"warranty_settings": modeBlock("observe")})
	// While it runs, a mode change and a day passing start nothing more.
	r.advance(25 * time.Hour)
	r.h.applyConfigUpdate(map[string]any{"warranty_settings": modeBlock("act")})
	close(r.block)
	r.h.inventoryWg.Wait()
	if c, _ := r.count(); c != 1 {
		t.Fatalf("collects = %d, want 1 while one is in flight", c)
	}
}

// Review #5: shutdown (DrainAndWait runs stopHpWarrantyObserve before it
// waits) cancels a run in flight and starts no new one.
func TestStopHpWarrantyObserveCancelsAndBlocksNew(t *testing.T) {
	r := newObserveRig(t)
	cancelled := make(chan struct{})
	r.h.hpWarranty.collect = func(ctx context.Context, mode string) *hpwarrantyobserve.Observation {
		<-ctx.Done()
		close(cancelled)
		return nil
	}
	r.advance(hpObserveMaxFirstDelay)
	r.h.applyConfigUpdate(map[string]any{"warranty_settings": modeBlock("observe")})
	r.h.stopHpWarrantyObserve()
	select {
	case <-cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("stop did not cancel the run in flight")
	}
	r.h.inventoryWg.Wait()

	ran := false
	r.h.hpWarranty.collect = func(context.Context, string) *hpwarrantyobserve.Observation { ran = true; return nil }
	r.advance(25 * time.Hour)
	r.beat(modeBlock("act"))
	if ran {
		t.Fatal("an observe started after stop")
	}
}

func TestObserveNotHPEmitsNothing(t *testing.T) {
	r := newObserveRig(t)
	r.h.hpWarranty.collect = func(context.Context, string) *hpwarrantyobserve.Observation { return nil }
	r.advance(hpObserveMaxFirstDelay)
	r.beat(modeBlock("observe"))
	if _, e := r.count(); e != 0 {
		t.Fatalf("emitted %d records for a machine that is not HP", e)
	}
}

func TestObserveFirstDelayBounds(t *testing.T) {
	for _, id := range []string{"", "a", "agent-1", "00000000-0000-4000-8000-000000000001"} {
		d := hpObserveFirstDelay(id)
		if d < time.Minute || d > hpObserveMaxFirstDelay {
			t.Errorf("hpObserveFirstDelay(%q) = %s, outside [1m, %s]", id, d, hpObserveMaxFirstDelay)
		}
		if d != hpObserveFirstDelay(id) {
			t.Errorf("hpObserveFirstDelay(%q) is not deterministic", id)
		}
	}
}

// The production emitter writes one record under the observe component and
// message, through EmitShipAlways.
func TestEmitHpWarrantyObservationRecordShape(t *testing.T) {
	var gotMsg string
	var gotArgs []any
	orig := emitShipAlways
	t.Cleanup(func() { emitShipAlways = orig })
	emitShipAlways = func(_ *slog.Logger, msg string, args ...any) {
		gotMsg, gotArgs = msg, args
	}
	o := &hpwarrantyobserve.Observation{SchemaVersion: 1, Mode: "observe"}
	emitHpWarrantyObservation(o)
	if gotMsg != hpwarrantyobserve.Message || len(gotArgs) != 2 || gotArgs[0] != "observation" || gotArgs[1] != o {
		t.Fatalf("emitted %q %v", gotMsg, gotArgs)
	}
	if hpObserveLog == nil {
		t.Fatal("no observe logger")
	}
}
