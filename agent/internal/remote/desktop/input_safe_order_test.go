package desktop

import (
	"errors"
	"reflect"
	"sync"
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

func TestSafeInputReleaseAllStartsANewEpochAndGatesSequencedInput(t *testing.T) {
	inner := &workerRecorder{}
	s := NewSafeInput(inner, "t")
	defer s.Close()
	handshake(t, s, 1, 1)
	if err := s.HandleEvent(seqKey("key_down", "shift", 2)); err != nil {
		t.Fatal(err)
	}

	s.ReleaseAll("peer_disconnected")
	if r, g := s.Epochs(); r != 2 || g != 1 {
		t.Fatalf("Epochs() = %d,%d want 2,1", r, g)
	}
	if err := s.HandleEvent(seqKey("key_down", "a", 3)); !errors.Is(err, errInputDropped) {
		t.Fatalf("pre-reset epoch accepted: %v", err)
	}
	handshake(t, s, 4, 2)
	ev := seqKey("key_down", "b", 5)
	ev.Epoch = 2
	if err := s.HandleEvent(ev); err != nil {
		t.Fatal(err)
	}

	wantCalls(t, inner, []string{"key_down:shift", "key_up:shift", "key_down:b"})
}

// The race the epoch exists for: a press queued before a reset, or a
// retransmitted one delivered after it, must not re-latch a key just released.
func TestSafeInputSequencedPressCannotOutliveAReset(t *testing.T) {
	inner := newBlockingRecorder()
	s := NewSafeInput(inner, "t")
	defer s.Close()
	handshake(t, s, 1, 1)

	wedgeSeq(t, s, inner, "x", 2)
	queued := make(chan error, 1)
	go func() { queued <- s.HandleEvent(seqKey("key_down", "y", 3)) }()
	waitFor(t, "y to queue", func() bool { return len(s.jobs) == 1 })
	released := make(chan struct{})
	go func() { s.ReleaseAll("peer_disconnected"); close(released) }()
	waitFor(t, "the reset to queue", func() bool { return len(s.urgent) == 1 })
	close(inner.block)
	<-released

	if err := <-queued; !errors.Is(err, errInputReset) {
		t.Fatalf("queued press: err=%v, want errInputReset", err)
	}
	if err := s.HandleEvent(seqKey("key_down", "y", 4)); !errors.Is(err, errInputDropped) {
		t.Fatalf("retransmitted pre-reset press: err=%v, want errInputDropped", err)
	}
	wantCalls(t, inner, []string{"key_down:x", "key_up:x"})
}

// R1: the epochs move even when the worker is wedged, so monitor_switched
// (sent right after ResetGeometry returns) always announces the new geoEpoch,
// and the late release job does not move them a second time.
func TestSafeInputEpochsMoveEvenWhenTheWorkerIsWedged(t *testing.T) {
	inner := newBlockingRecorder()
	s := NewSafeInput(inner, "t")
	s.closeTimeout = 50 * time.Millisecond
	defer s.Close()
	handshake(t, s, 1, 1)
	wedgeSeq(t, s, inner, "x", 2)

	s.ResetGeometry("monitor_switch") // times out waiting for the release job
	if r, g := s.Epochs(); r != 2 || g != 2 {
		t.Fatalf("Epochs() right after a timed-out reset = %d,%d want 2,2", r, g)
	}
	close(inner.block)
	s.sync()
	if r, g := s.Epochs(); r != 2 || g != 2 {
		t.Fatalf("the late release job moved the epochs again: %d,%d", r, g)
	}
	wantCalls(t, inner, []string{"key_down:x", "key_up:x"})
}

// R1b: a handshake that arrives after a reset but is queued before its release
// job runs must survive that release.
func TestSafeInputHandshakeQueuedBehindAResetSurvivesIt(t *testing.T) {
	inner := newBlockingRecorder()
	s := NewSafeInput(inner, "t")
	defer s.Close()
	handshake(t, s, 1, 1)
	wedgeSeq(t, s, inner, "x", 2)

	released := make(chan struct{})
	go func() { s.ReleaseAll("peer_disconnected"); close(released) }()
	waitFor(t, "the epoch to move", func() bool { r, _ := s.Epochs(); return r == 2 })
	shook := make(chan error, 1)
	go func() { shook <- s.HandleEvent(InputEvent{Type: "input_reset", Seq: 3, Epoch: 2}) }()
	waitFor(t, "the release and the handshake to queue", func() bool { return len(s.urgent) == 1 && len(s.jobs) == 1 })
	close(inner.block)
	<-released

	if err := <-shook; err != nil {
		t.Fatalf("handshake queued after the reset was discarded: %v", err)
	}
	ev := seqKey("key_down", "b", 4)
	ev.Epoch = 2
	if err := s.HandleEvent(ev); err != nil {
		t.Fatalf("input after the surviving handshake: %v", err)
	}
	wantCalls(t, inner, []string{"key_down:x", "key_up:x", "key_down:b"})
}

// Compatibility: a viewer that never sends seq is never gated, whatever resets.
func TestSafeInputLegacyInputIsNeverGatedByAReset(t *testing.T) {
	inner := &workerRecorder{}
	s := NewSafeInput(inner, "t")
	defer s.Close()

	_ = s.HandleEvent(InputEvent{Type: "key_down", Key: "shift"})
	s.ReleaseAll("monitor_switch")
	s.ResetGeometry("monitor_switch")
	if err := s.HandleEvent(InputEvent{Type: "key_down", Key: "a"}); err != nil {
		t.Fatalf("legacy input gated after a reset: %v", err)
	}
	_ = s.HandleEvent(InputEvent{Type: "mouse_down", X: 1, Y: 1, Button: "left"})

	wantCalls(t, inner, []string{"key_down:shift", "key_up:shift", "key_down:a", "mouse_down:1,1:left"})
}

func TestSafeInputGeometryResetDropsOldCoordinates(t *testing.T) {
	inner := &workerRecorder{}
	s := NewSafeInput(inner, "t")
	defer s.Close()
	handshake(t, s, 1, 1)

	s.ResetGeometry("monitor_switch")
	if r, g := s.Epochs(); r != 2 || g != 2 {
		t.Fatalf("Epochs() = %d,%d want 2,2", r, g)
	}
	handshake(t, s, 2, 2)
	old := InputEvent{Type: "mouse_down", X: 1, Y: 1, Button: "left", Seq: 3, Epoch: 2, GeoEpoch: 1}
	if err := s.HandleEvent(old); !errors.Is(err, errInputDropped) {
		t.Fatalf("old-geometry press: err=%v, want errInputDropped", err)
	}
	key := InputEvent{Type: "key_down", Key: "a", Seq: 4, Epoch: 2, GeoEpoch: 1}
	if err := s.HandleEvent(key); err != nil {
		t.Fatalf("key events ignore geometry: %v", err)
	}
	cur := InputEvent{Type: "mouse_down", X: 2, Y: 2, Button: "left", Seq: 5, Epoch: 2, GeoEpoch: 2}
	if err := s.HandleEvent(cur); err != nil {
		t.Fatal(err)
	}
	wantCalls(t, inner, []string{"key_down:a", "mouse_down:2,2:left"})
}

func TestSafeInputAnnouncesAgentResetsButNotClose(t *testing.T) {
	s := NewSafeInput(&workerRecorder{}, "t")
	resets := make(chan string, 4)
	s.SetHooks(safeInputHooks{onReset: func(r string) { resets <- r }})

	s.ReleaseAll("input_channel_closed")
	s.ResetGeometry("monitor_switch")
	s.Close()

	close(resets)
	var got []string
	for r := range resets {
		got = append(got, r)
	}
	if !reflect.DeepEqual(got, []string{"input_channel_closed", "monitor_switch"}) {
		t.Fatalf("onReset calls = %v", got)
	}
}

func TestSafeInputAsksForResyncAtMostOncePerInterval(t *testing.T) {
	inner := &workerRecorder{}
	s := NewSafeInput(inner, "t")
	defer s.Close()
	var mu sync.Mutex
	now := time.Unix(1000, 0)
	s.now = func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	resyncs := make(chan struct{}, 10)
	s.SetHooks(safeInputHooks{onResync: func() { resyncs <- struct{}{} }})

	// No handshake yet, so sequenced input is gated and asks for a resync.
	for seq := uint64(1); seq <= 3; seq++ {
		_ = s.HandleEvent(seqKey("key_down", "a", seq))
	}
	if n := len(resyncs); n != 1 {
		t.Fatalf("resyncs after a burst = %d, want 1", n)
	}
	mu.Lock()
	now = now.Add(inputResyncInterval)
	mu.Unlock()
	_ = s.HandleEvent(seqKey("key_down", "a", 4))
	if n := len(resyncs); n != 2 {
		t.Fatalf("resyncs after the interval = %d, want 2", n)
	}
	// Barrier drops are the viewer's own reordering, not a stale epoch: no resync.
	handshake(t, s, 5, 1)
	_ = s.HandleEvent(seqMove(1, 6, 4))
	s.sync()
	if n := len(resyncs); n != 2 {
		t.Fatalf("a behind-barrier drop asked for a resync")
	}
	wantCalls(t, inner, nil)
}

// R2 at the worker level: after a reset, a viewer that only moves the mouse
// still learns the new epoch.
func TestSafeInputStaleMoveAsksForResync(t *testing.T) {
	s := NewSafeInput(&workerRecorder{}, "t")
	defer s.Close()
	resyncs := make(chan struct{}, 4)
	s.SetHooks(safeInputHooks{onResync: func() { resyncs <- struct{}{} }})
	handshake(t, s, 1, 1)
	s.ReleaseAll("peer_disconnected")

	_ = s.HandleEvent(seqMove(5, 4, 3)) // its barrier (3) was discarded by the reset
	s.sync()
	if len(resyncs) != 1 {
		t.Fatal("a stale-epoch move did not ask for a resync")
	}
}
