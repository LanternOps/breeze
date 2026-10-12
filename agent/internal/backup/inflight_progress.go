package backup

import (
	"context"
	"sync"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// inFlightProgress tracks how far each in-flight upload has read its source,
// so createSnapshotWithProgress can report bytes WITHIN files instead of only
// when they complete (#5417). Without it a 1.5 GiB file pins the operator's
// progress bar for the whole transfer.
//
// The upload pool (#8381) has several files in flight at once, so each one
// holds its own slot, and load reports the sum across slots. Providers report
// absolute offsets through providers.WithUploadProgress from their own
// (possibly concurrent) goroutines. A slot keeps the file's maximum offset,
// capped at the file's walk-time size. That is the same number markDone later
// adds to bytesDone, so completing the file can never lower the total. The
// type has its own mutex, separate from the snapshot's progressMu, so a
// provider read never waits behind an onProgress IPC send that progressMu is
// held for.
type inFlightProgress struct {
	mu    sync.Mutex
	next  inFlightSlot
	slots map[inFlightSlot]int64

	// kick asks the snapshot's progress goroutine to emit (throttled). It is
	// buffered and written without blocking, so the upload never waits on it.
	kick chan struct{}
}

// inFlightSlot names one tracked file. The zero value tracks nothing.
type inFlightSlot uint64

// newInFlightProgress returns nil when nobody is watching progress. Every
// method is a no-op on a nil receiver and track then returns ctx unchanged,
// so an unwatched run's uploads are exactly what they were before.
func newInFlightProgress(watched bool) *inFlightProgress {
	if !watched {
		return nil
	}
	return &inFlightProgress{slots: map[inFlightSlot]int64{}, kick: make(chan struct{}, 1)}
}

// track starts a new file of walkSize bytes and returns ctx carrying the
// upload-progress callback for it, plus the slot to release once the file is
// counted or abandoned. Use the returned context for every upload attempt of
// that file (retry and reconcile re-upload included). Offsets are kept as a
// high-water mark, so re-reading from zero neither double counts nor moves
// the value backwards.
func (p *inFlightProgress) track(ctx context.Context, walkSize int64) (context.Context, inFlightSlot) {
	if p == nil {
		return ctx, 0
	}
	p.mu.Lock()
	p.next++
	slot := p.next
	p.slots[slot] = 0
	p.mu.Unlock()
	return providers.WithUploadProgress(ctx, func(offset int64) {
		if offset > walkSize {
			offset = walkSize
		}
		p.mu.Lock()
		current, live := p.slots[slot]
		advanced := live && offset > current
		if advanced {
			p.slots[slot] = offset
		}
		p.mu.Unlock()
		if advanced {
			select {
			case p.kick <- struct{}{}:
			default:
			}
		}
	}), slot
}

// release drops a slot's in-flight bytes, e.g. once the file's full size has
// been added to bytesDone, or once it failed. Late callbacks for that file
// are ignored from here on.
func (p *inFlightProgress) release(slot inFlightSlot) {
	if p == nil || slot == 0 {
		return
	}
	p.mu.Lock()
	delete(p.slots, slot)
	p.mu.Unlock()
}

// load returns the bytes read so far across every in-flight file.
func (p *inFlightProgress) load() int64 {
	if p == nil {
		return 0
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	var total int64
	for _, b := range p.slots {
		total += b
	}
	return total
}

// kicks returns the channel signalled when in-flight bytes advance; nil (so
// never ready in a select) on a nil receiver.
func (p *inFlightProgress) kicks() <-chan struct{} {
	if p == nil {
		return nil
	}
	return p.kick
}
