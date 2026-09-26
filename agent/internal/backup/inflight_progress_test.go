package backup

import (
	"context"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// A callback from an earlier file (an SDK goroutine that outlived its upload)
// must not land on the file now in flight, and must not survive a reset.
func TestInFlightProgress_StaleCallbackFromEarlierFileIsIgnored(t *testing.T) {
	p := newInFlightProgress(true)
	first := providers.UploadProgressFunc(p.track(context.Background(), 100))
	first(40)
	if got := p.load(); got != 40 {
		t.Fatalf("load() = %d, want 40", got)
	}

	second := providers.UploadProgressFunc(p.track(context.Background(), 10))
	first(90) // straggler from the first file
	if got := p.load(); got != 0 {
		t.Fatalf("a stale callback from the previous file moved the new file's bytes to %d", got)
	}
	second(7)
	second(3) // re-read after a rewind: high-water mark holds
	if got := p.load(); got != 7 {
		t.Fatalf("load() = %d, want 7", got)
	}

	p.reset()
	second(9)
	if got := p.load(); got != 0 {
		t.Fatalf("a callback after reset() (file already counted in bytesDone) moved in-flight bytes to %d", got)
	}
}

func TestInFlightProgress_NilWhenUnwatched(t *testing.T) {
	p := newInFlightProgress(false)
	ctx := context.Background()
	if got := p.track(ctx, 10); got != ctx {
		t.Fatal("an unwatched run must not attach an upload-progress callback")
	}
	p.reset()
	if p.load() != 0 || p.kicks() != nil {
		t.Fatal("nil inFlightProgress must be inert")
	}
}
