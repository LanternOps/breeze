package backup

import (
	"context"
	"sync"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// inFlightProgress tracks how far the upload of the file currently in flight
// has read its source, so createSnapshotWithProgress can report bytes WITHIN a
// single large file instead of only when it completes (#5417) — without it a
// 1.5 GiB file pins the operator's progress bar for the whole transfer.
//
// Providers report absolute offsets through providers.WithUploadProgress from
// their own (possibly concurrent) goroutines; this type keeps the per-file
// maximum, capped at the file's walk-time size (the same number markDone later
// adds to bytesDone, so completing the file can never lower the total). It
// has its own mutex, separate from the snapshot's progressMu, so a provider
// read never waits behind an onProgress IPC send that progressMu is held for.
type inFlightProgress struct {
	mu    sync.Mutex
	gen   uint64 // bumped per file so a straggling callback from an earlier file is ignored
	bytes int64

	// kick asks the snapshot's progress goroutine to emit (throttled). It is
	// buffered and written without blocking, so the upload never waits on it.
	kick chan struct{}
}

// newInFlightProgress returns nil when nobody is watching progress; every
// method is a no-op on a nil receiver and track then returns ctx unchanged,
// so an unwatched run's uploads are exactly what they were before.
func newInFlightProgress(watched bool) *inFlightProgress {
	if !watched {
		return nil
	}
	return &inFlightProgress{kick: make(chan struct{}, 1)}
}

// track starts a new file of walkSize bytes and returns ctx carrying the
// upload-progress callback for it. Use the returned context for every upload
// attempt of that file (retry and reconcile re-upload included): offsets are
// kept as a high-water mark, so re-reading from zero neither double counts
// nor moves the value backwards.
func (p *inFlightProgress) track(ctx context.Context, walkSize int64) context.Context {
	if p == nil {
		return ctx
	}
	p.mu.Lock()
	p.gen++
	gen := p.gen
	p.bytes = 0
	p.mu.Unlock()
	return providers.WithUploadProgress(ctx, func(offset int64) {
		if offset > walkSize {
			offset = walkSize
		}
		p.mu.Lock()
		advanced := gen == p.gen && offset > p.bytes
		if advanced {
			p.bytes = offset
		}
		p.mu.Unlock()
		if advanced {
			select {
			case p.kick <- struct{}{}:
			default:
			}
		}
	})
}

// reset drops the in-flight bytes, e.g. once the file's full size has been
// added to bytesDone. Late callbacks for that file are ignored from here on.
func (p *inFlightProgress) reset() {
	if p == nil {
		return
	}
	p.mu.Lock()
	p.gen++
	p.bytes = 0
	p.mu.Unlock()
}

func (p *inFlightProgress) load() int64 {
	if p == nil {
		return 0
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.bytes
}

// kicks returns the channel signalled when in-flight bytes advance; nil (so
// never ready in a select) on a nil receiver.
func (p *inFlightProgress) kicks() <-chan struct{} {
	if p == nil {
		return nil
	}
	return p.kick
}
