package desktop

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

func seqEv(typ string, seq uint64) InputEvent {
	return InputEvent{Type: typ, Seq: seq, Epoch: 1, GeoEpoch: 1}
}

func seqKey(typ, key string, seq uint64) InputEvent {
	ev := seqEv(typ, seq)
	ev.Key = key
	return ev
}

func seqMove(x int, seq, after uint64) InputEvent {
	ev := seqEv("mouse_move", seq)
	ev.X, ev.Y, ev.After = x, x, after
	return ev
}

func seqDown(x int, seq uint64) InputEvent {
	ev := seqEv("mouse_down", seq)
	ev.X, ev.Y, ev.Button = x, x, "left"
	return ev
}

// handshake opens a sequenced stream the way a W3 viewer does. With nothing
// held it injects nothing, so it does not touch a blocking recorder.
func handshake(t *testing.T, s *SafeInput, seq uint64, epoch uint32) {
	t.Helper()
	if err := s.HandleEvent(InputEvent{Type: "input_reset", Seq: seq, Epoch: epoch}); err != nil {
		t.Fatalf("input_reset seq=%d epoch=%d: %v", seq, epoch, err)
	}
}

// wedgeSeq parks the worker inside the platform handler on a sequenced key_down.
func wedgeSeq(t *testing.T, s *SafeInput, inner *workerRecorder, key string, seq uint64) {
	t.Helper()
	go func() { _ = s.HandleEvent(seqKey("key_down", key, seq)) }()
	select {
	case <-inner.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("worker never reached the platform handler")
	}
}

func wantCalls(t *testing.T, inner *workerRecorder, want []string) {
	t.Helper()
	if got := inner.snapshot(); !reflect.DeepEqual(got, want) {
		t.Fatalf("calls:\n got %v\nwant %v", got, want)
	}
}

func TestSafeInputSequencedMoveSentBeforeADiscreteEventGoesFirst(t *testing.T) {
	inner := newBlockingRecorder()
	s := NewSafeInput(inner, "t")
	defer s.Close()
	handshake(t, s, 1, 1)

	wedgeSeq(t, s, inner, "x", 2)
	_ = s.HandleEvent(seqMove(5, 3, 2)) // sent after key x, before the press
	downDone := make(chan error, 1)
	go func() { downDone <- s.HandleEvent(seqDown(9, 4)) }()
	waitFor(t, "the mouse_down to queue", func() bool { return len(s.jobs) == 1 })
	close(inner.block)
	if err := <-downDone; err != nil {
		t.Fatal(err)
	}

	wantCalls(t, inner, []string{"key_down:x", "mouse_move:5,5:", "mouse_down:9,9:left"})
}

// The bug the barrier exists for (spec §1): the press was retransmitting on
// input-r while a newer move on the lossy channel arrived first.
func TestSafeInputSequencedMoveThatOvertookAPressWaitsForIt(t *testing.T) {
	inner := newBlockingRecorder()
	s := NewSafeInput(inner, "t")
	defer s.Close()
	handshake(t, s, 1, 1)

	wedgeSeq(t, s, inner, "x", 2)
	_ = s.HandleEvent(seqMove(5, 4, 3)) // sent after mouse_down 3, arrived before it
	downDone := make(chan error, 1)
	go func() { downDone <- s.HandleEvent(seqDown(9, 3)) }()
	waitFor(t, "the mouse_down to queue", func() bool { return len(s.jobs) == 1 })
	close(inner.block)
	if err := <-downDone; err != nil {
		t.Fatal(err)
	}

	wantCalls(t, inner, []string{"key_down:x", "mouse_down:9,9:left", "mouse_move:5,5:"})
}

func TestSafeInputDropsAMoveOlderThanTheLastDiscreteEvent(t *testing.T) {
	inner := &workerRecorder{}
	s := NewSafeInput(inner, "t")
	defer s.Close()
	handshake(t, s, 1, 1)

	if err := s.HandleEvent(seqDown(9, 3)); err != nil {
		t.Fatal(err)
	}
	_ = s.HandleEvent(seqMove(5, 2, 1)) // sent before the press, arrived after it
	s.sync()

	wantCalls(t, inner, []string{"mouse_down:9,9:left"})
	if n := s.droppedCount(dropBehindBarrier); n != 1 {
		t.Fatalf("behind_barrier drops = %d, want 1", n)
	}
}

func TestSafeInputKeepsOnlyTheNewestSequencedMove(t *testing.T) {
	inner := &workerRecorder{}
	s := NewSafeInput(inner, "t")
	defer s.Close()
	handshake(t, s, 1, 1)

	_ = s.HandleEvent(seqMove(5, 5, 1))
	s.sync()
	_ = s.HandleEvent(seqMove(4, 4, 1)) // older, delivered late
	s.sync()

	wantCalls(t, inner, []string{"mouse_move:5,5:"})
}

func TestSafeInputSkippedSeqReleasesAWaitingMove(t *testing.T) {
	inner := &workerRecorder{}
	s := NewSafeInput(inner, "t")
	defer s.Close()
	handshake(t, s, 1, 1)

	_ = s.HandleEvent(seqMove(5, 3, 2)) // waits for discrete event 2
	s.sync()
	wantCalls(t, inner, nil)

	s.SkipSeq(2) // event 2 was rejected before it reached the worker
	wantCalls(t, inner, []string{"mouse_move:5,5:"})
}

func TestSafeInputDropsUnsequencedInputOnceSequenced(t *testing.T) {
	inner := &workerRecorder{}
	s := NewSafeInput(inner, "t")
	defer s.Close()
	handshake(t, s, 1, 1)

	if err := s.HandleEvent(InputEvent{Type: "key_down", Key: "a"}); !errors.Is(err, errInputDropped) {
		t.Fatalf("legacy key_down after handshake: err=%v, want errInputDropped", err)
	}
	_ = s.HandleEvent(InputEvent{Type: "mouse_move", X: 1, Y: 1})
	s.sync()
	wantCalls(t, inner, nil)
}

// input_reset from the viewer releases what is held behind the events sent
// before it, not ahead of them.
func TestSafeInputViewerResetReleasesInOrder(t *testing.T) {
	inner := &workerRecorder{}
	s := NewSafeInput(inner, "t")
	defer s.Close()
	handshake(t, s, 1, 1)

	for _, ev := range []InputEvent{seqKey("key_down", "shift", 2), seqKey("key_down", "a", 3)} {
		if err := s.HandleEvent(ev); err != nil {
			t.Fatal(err)
		}
	}
	handshake(t, s, 4, 1)
	if err := s.HandleEvent(seqKey("key_down", "b", 5)); err != nil {
		t.Fatalf("input after a viewer reset was gated: %v", err)
	}

	wantCalls(t, inner, []string{"key_down:shift", "key_down:a", "key_up:a", "key_up:shift", "key_down:b"})
}
