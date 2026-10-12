package backup

import (
	"context"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// Each in-flight file keeps its own high-water mark, load sums them, and a
// callback that outlives its file's release (an SDK goroutine that outlived
// its upload) changes nothing.
func TestInFlightProgress_PerFileSlotsAndStaleCallbacks(t *testing.T) {
	p := newInFlightProgress(true)
	firstCtx, first := p.track(context.Background(), 100)
	firstFn := providers.UploadProgressFunc(firstCtx)
	firstFn(40)
	if got := p.load(); got != 40 {
		t.Fatalf("load() = %d, want 40", got)
	}

	secondCtx, second := p.track(context.Background(), 10)
	secondFn := providers.UploadProgressFunc(secondCtx)
	secondFn(7)
	secondFn(3) // re-read after a rewind: high-water mark holds
	if got := p.load(); got != 47 {
		t.Fatalf("load() = %d with two files in flight, want 40+7", got)
	}
	secondFn(1 << 20) // capped at the file's walk-time size
	if got := p.load(); got != 50 {
		t.Fatalf("load() = %d, want 40+10 (offset capped at walk size)", got)
	}

	p.release(first)
	firstFn(90) // straggler from the released file
	if got := p.load(); got != 10 {
		t.Fatalf("a callback after release moved in-flight bytes to %d, want 10", got)
	}
	p.release(second)
	p.release(second) // idempotent
	p.release(0)      // the zero slot tracks nothing
	if got := p.load(); got != 0 {
		t.Fatalf("load() = %d after every file was released, want 0", got)
	}
}

func TestInFlightProgress_NilWhenUnwatched(t *testing.T) {
	p := newInFlightProgress(false)
	ctx := context.Background()
	got, slot := p.track(ctx, 10)
	if got != ctx {
		t.Fatal("an unwatched run must not attach an upload-progress callback")
	}
	p.release(slot)
	if p.load() != 0 || p.kicks() != nil {
		t.Fatal("nil inFlightProgress must be inert")
	}
}
