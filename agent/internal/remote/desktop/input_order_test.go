package desktop

import (
	"math"
	"testing"
)

func oKey(seq uint64, epoch uint32) InputEvent {
	return InputEvent{Type: "key_down", Key: "a", Seq: seq, Epoch: epoch}
}
func oReset(seq uint64, epoch uint32) InputEvent {
	return InputEvent{Type: "input_reset", Seq: seq, Epoch: epoch}
}
func oDown(seq uint64, geo uint32) InputEvent {
	return InputEvent{Type: "mouse_down", Seq: seq, Epoch: 1, GeoEpoch: geo}
}
func oMove(seq, after uint64) InputEvent {
	return InputEvent{Type: "mouse_move", Seq: seq, After: after, Epoch: 1, GeoEpoch: 1}
}

func wantDiscrete(t *testing.T, o *inputOrder, ev InputEvent, want orderVerdict, wantReason string) {
	t.Helper()
	got, reason := o.discrete(ev)
	if got != want || reason != wantReason {
		t.Fatalf("discrete(%+v) = (%v, %q), want (%v, %q)", ev, got, reason, want, wantReason)
	}
}

func wantMove(t *testing.T, o *inputOrder, ev InputEvent, want moveVerdict, wantReason string) {
	t.Helper()
	got, reason := o.move(ev)
	if got != want || reason != wantReason {
		t.Fatalf("move(%+v) = (%v, %q), want (%v, %q)", ev, got, reason, want, wantReason)
	}
}

func TestInputOrderLegacyBeforeHandshakeIsInjected(t *testing.T) {
	o := newInputOrder()
	wantDiscrete(t, o, InputEvent{Type: "key_down", Key: "a"}, orderInject, "")
	wantMove(t, o, InputEvent{Type: "mouse_move", X: 1}, moveReady, "")
	o.agentReset(false) // an old viewer is never gated
	wantDiscrete(t, o, InputEvent{Type: "key_down", Key: "a"}, orderInject, "")
}

func TestInputOrderSequencedInputNeedsTheHandshake(t *testing.T) {
	o := newInputOrder()
	wantDiscrete(t, o, oKey(1, 1), orderDrop, dropAwaitingReset)
	wantDiscrete(t, o, oReset(2, 1), orderAcceptReset, "")
	wantDiscrete(t, o, oKey(3, 1), orderInject, "")
}

func TestInputOrderStaleHandshakeIsRefused(t *testing.T) {
	o := newInputOrder()
	wantDiscrete(t, o, oReset(1, 2), orderDrop, dropStaleEpoch)
	wantDiscrete(t, o, oKey(2, 1), orderDrop, dropAwaitingReset)
}

func TestInputOrderUnsequencedInputResetIsInvalid(t *testing.T) {
	o := newInputOrder()
	wantDiscrete(t, o, InputEvent{Type: "input_reset", Epoch: 1}, orderDrop, dropInvalidReset)
}

func TestInputOrderLegacyAfterHandshakeIsDropped(t *testing.T) {
	o := newInputOrder()
	wantDiscrete(t, o, oReset(1, 1), orderAcceptReset, "")
	wantDiscrete(t, o, InputEvent{Type: "key_up", Key: "a"}, orderDrop, dropLegacyAfterV2)
	wantMove(t, o, InputEvent{Type: "mouse_move", X: 1}, moveStale, dropLegacyAfterV2)
}

func TestInputOrderDuplicateOrReorderedSeqIsDropped(t *testing.T) {
	o := newInputOrder()
	wantDiscrete(t, o, oReset(1, 1), orderAcceptReset, "")
	wantDiscrete(t, o, oKey(3, 1), orderInject, "")
	wantDiscrete(t, o, oKey(2, 1), orderDrop, dropDuplicateSeq)
	wantDiscrete(t, o, oKey(3, 1), orderDrop, dropDuplicateSeq)
}

func TestInputOrderAgentResetGatesUntilAcknowledged(t *testing.T) {
	o := newInputOrder()
	wantDiscrete(t, o, oReset(1, 1), orderAcceptReset, "")
	o.agentReset(false)
	if o.resetEpoch != 2 || !o.awaitingReset {
		t.Fatalf("after agentReset: epoch=%d awaiting=%v", o.resetEpoch, o.awaitingReset)
	}
	wantDiscrete(t, o, oKey(2, 1), orderDrop, dropAwaitingReset)
	wantDiscrete(t, o, oReset(3, 1), orderDrop, dropStaleEpoch)
	wantDiscrete(t, o, oReset(4, 2), orderAcceptReset, "")
	wantDiscrete(t, o, oKey(5, 1), orderDrop, dropStaleEpoch)
	wantDiscrete(t, o, oKey(6, 2), orderInject, "")
}

func TestInputOrderViewerResetDoesNotBumpTheEpoch(t *testing.T) {
	o := newInputOrder()
	wantDiscrete(t, o, oReset(1, 1), orderAcceptReset, "")
	wantDiscrete(t, o, oReset(2, 1), orderAcceptReset, "")
	if o.resetEpoch != 1 || o.awaitingReset {
		t.Fatalf("viewer reset changed agent state: epoch=%d awaiting=%v", o.resetEpoch, o.awaitingReset)
	}
}

func TestInputOrderGeometryResetDropsOldCoordinatesOnly(t *testing.T) {
	o := newInputOrder()
	wantDiscrete(t, o, oReset(1, 1), orderAcceptReset, "")
	o.agentReset(true)
	if o.resetEpoch != 2 || o.geoEpoch != 2 {
		t.Fatalf("geometry reset: epoch=%d geo=%d", o.resetEpoch, o.geoEpoch)
	}
	wantDiscrete(t, o, oReset(2, 2), orderAcceptReset, "")
	stale := InputEvent{Type: "mouse_down", Seq: 3, Epoch: 2, GeoEpoch: 1}
	wantDiscrete(t, o, stale, orderDrop, dropStaleGeometry)
	wantDiscrete(t, o, InputEvent{Type: "key_down", Key: "a", Seq: 4, Epoch: 2, GeoEpoch: 1}, orderInject, "")
	wantDiscrete(t, o, InputEvent{Type: "mouse_down", Seq: 5, Epoch: 2, GeoEpoch: 2}, orderInject, "")
}

func TestInputOrderMoveBarrier(t *testing.T) {
	o := newInputOrder()
	wantDiscrete(t, o, oReset(1, 1), orderAcceptReset, "")
	wantDiscrete(t, o, oDown(3, 1), orderInject, "") // lastDiscrete = 3

	wantMove(t, o, oMove(5, 4), moveWait, "")                 // depends on 4, not handled yet
	wantMove(t, o, oMove(4, 2), moveStale, dropBehindBarrier) // sent before 3
	wantMove(t, o, oMove(6, 3), moveReady, "")                // sent right after 3
	wantMove(t, o, oMove(6, 3), moveStale, dropOlderMove)     // already injected one at seq 6
	wantMove(t, o, oMove(5, 3), moveStale, dropOlderMove)     // arrived after a newer move
}

func TestInputOrderMoveGates(t *testing.T) {
	o := newInputOrder()
	// Waiting on the handshake itself: ready once it is handled.
	wantMove(t, o, oMove(2, 1), moveWait, "")
	wantDiscrete(t, o, oReset(1, 1), orderAcceptReset, "")
	wantMove(t, o, oMove(2, 1), moveReady, "")

	o.agentReset(true) // epoch 2, geo 2, gate closed
	wantMove(t, o, InputEvent{Type: "mouse_move", Seq: 3, After: 1, Epoch: 1, GeoEpoch: 1}, moveStale, dropStaleEpoch)
	wantMove(t, o, InputEvent{Type: "mouse_move", Seq: 4, After: 1, Epoch: 2, GeoEpoch: 1}, moveStale, dropStaleGeometry)
	wantMove(t, o, InputEvent{Type: "mouse_move", Seq: 5, After: 1, Epoch: 2, GeoEpoch: 2}, moveStale, dropAwaitingReset)
	wantMove(t, o, InputEvent{Type: "mouse_move", Seq: 7, After: 6, Epoch: 2, GeoEpoch: 2}, moveWait, "") // waits for the re-handshake
	wantDiscrete(t, o, oReset(6, 2), orderAcceptReset, "")
	wantMove(t, o, InputEvent{Type: "mouse_move", Seq: 7, After: 6, Epoch: 2, GeoEpoch: 2}, moveReady, "")
}

// Review amendment R2: a move whose barrier is a discrete event the reset
// discarded must be dropped (and so ask for a resync), not wait forever.
func TestInputOrderStaleEpochMoveDoesNotWaitOnADiscardedBarrier(t *testing.T) {
	o := newInputOrder()
	wantDiscrete(t, o, oReset(1, 1), orderAcceptReset, "")
	wantDiscrete(t, o, oKey(2, 1), orderInject, "")
	o.agentReset(false) // discrete event 3 was queued and is discarded by the reset
	wantMove(t, o, oMove(4, 3), moveStale, dropStaleEpoch)
	if !resyncNeeded(dropStaleEpoch) {
		t.Fatal("a stale-epoch move must ask for a resync")
	}
}

func TestInputOrderSkipAdvancesTheBarrier(t *testing.T) {
	o := newInputOrder()
	wantDiscrete(t, o, oReset(1, 1), orderAcceptReset, "")
	wantMove(t, o, oMove(3, 2), moveWait, "")
	o.skip(2)
	wantMove(t, o, oMove(3, 2), moveReady, "")
	o.skip(1) // never moves backwards
	if o.lastDiscrete != 2 {
		t.Fatalf("lastDiscrete = %d, want 2", o.lastDiscrete)
	}
}

func TestInputOrderEpochsNeverWrapToZero(t *testing.T) {
	o := newInputOrder()
	o.resetEpoch, o.geoEpoch = math.MaxUint32, math.MaxUint32
	o.agentReset(true)
	if o.resetEpoch != 1 || o.geoEpoch != 1 {
		t.Fatalf("wrapped to %d/%d; 0 means 'absent' on the wire", o.resetEpoch, o.geoEpoch)
	}
}

func TestResyncNeeded(t *testing.T) {
	for reason, want := range map[string]bool{
		dropStaleEpoch: true, dropAwaitingReset: true,
		dropStaleGeometry: false, dropBehindBarrier: false, dropDuplicateSeq: false,
		dropLegacyAfterV2: false, dropOlderMove: false, dropInvalidReset: false,
	} {
		if got := resyncNeeded(reason); got != want {
			t.Errorf("resyncNeeded(%q) = %v, want %v", reason, got, want)
		}
	}
}
