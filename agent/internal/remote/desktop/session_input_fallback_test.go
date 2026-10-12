package desktop

import (
	"sync/atomic"
	"testing"
)

// A W3 viewer whose input-r closes falls back to the legacy protocol (see
// acceptViewerChannel). Legacy input must work again after that.
func TestLegacyInputWorksAfterInputRCloses(t *testing.T) {
	s, inner := newSafeSession(t)
	ch := new(int)
	s.onViewerChannelAttached("input-r", ch)
	sendR(s, rHandshake)
	sendR(s, `{"type":"key_down","key":"a","seq":2,"epoch":1}`)

	s.onViewerChannelClosed("input-r", ch)
	sendLossy(s, `{"type":"key_down","key":"b"}`)
	s.safeInput().sync()

	if got := lastCall(inner); got != "key_down:b" {
		t.Fatalf("legacy input dropped after input-r closed: %v", inner.snapshot())
	}
}

// While input-r is open, legacy input stays dropped: it would bypass the
// barrier.
func TestLegacyInputDroppedWhileInputROpen(t *testing.T) {
	s, inner := newSafeSession(t)
	s.onViewerChannelAttached("input-r", new(int))
	sendR(s, rHandshake)
	sendLossy(s, `{"type":"key_down","key":"b"}`)
	s.safeInput().sync()
	if c := inner.snapshot(); len(c) != 0 {
		t.Fatalf("legacy input injected while sequenced: %v", c)
	}
}

type availabilityRecorder struct {
	*workerRecorder
	off atomic.Bool
}

func (r *availabilityRecorder) InputAvailable() bool { return !r.off.Load() }

// A discrete input-r event dropped because input is unavailable must still
// move the barrier, or every later move waits for it.
func TestUnavailableInputDoesNotFreezeTheBarrier(t *testing.T) {
	inner := &availabilityRecorder{workerRecorder: &workerRecorder{}}
	si := NewSafeInput(inner, "session-1")
	t.Cleanup(si.Close)
	s := &Session{id: "session-1", inputHandler: si}

	sendR(s, rHandshake)
	inner.off.Store(true)
	sendR(s, `{"type":"key_down","key":"a","seq":2,"epoch":1}`)
	inner.off.Store(false)
	sendLossy(s, `{"type":"mouse_move","x":7,"y":7,"seq":3,"after":2,"epoch":1,"geoEpoch":1}`)
	si.sync()

	if got := lastCall(inner.workerRecorder); got != "mouse_move:7,7:" {
		t.Fatalf("pointer frozen behind an event dropped while input was unavailable: %v", inner.workerRecorder.snapshot())
	}
}
