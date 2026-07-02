package desktop

import (
	"testing"
	"time"
)

// sameEvent compares the scalar fields of two InputEvents. InputEvent holds a
// []string (Modifiers) so it is not comparable with ==; none of these tests set
// modifiers, so scalar comparison is sufficient.
func sameEvent(a, b InputEvent) bool {
	return a.Type == b.Type && a.X == b.X && a.Y == b.Y &&
		a.Button == b.Button && a.Key == b.Key && a.Delta == b.Delta
}

// drainAll pops every currently-queued event in order.
func drainAll(q *inputEventQueue) []InputEvent {
	var out []InputEvent
	for {
		ev, ok := q.pop()
		if !ok {
			return out
		}
		out = append(out, ev)
	}
}

func TestInputQueue_FIFOOrderPreserved(t *testing.T) {
	q := newInputEventQueue()
	in := []InputEvent{
		{Type: "key_down", Key: "a"},
		{Type: "mouse_down", Button: "left", X: 1, Y: 2},
		{Type: "mouse_up", Button: "left", X: 1, Y: 2},
		{Type: "key_up", Key: "a"},
	}
	for _, ev := range in {
		q.push(ev)
	}
	got := drainAll(q)
	if len(got) != len(in) {
		t.Fatalf("want %d events, got %d (%+v)", len(in), len(got), got)
	}
	for i := range in {
		if !sameEvent(got[i], in[i]) {
			t.Errorf("event %d: want %+v, got %+v", i, in[i], got[i])
		}
	}
}

func TestInputQueue_ConsecutiveMovesCoalesce(t *testing.T) {
	q := newInputEventQueue()
	q.push(InputEvent{Type: "mouse_move", X: 1, Y: 1})
	q.push(InputEvent{Type: "mouse_move", X: 2, Y: 2})
	q.push(InputEvent{Type: "mouse_move", X: 3, Y: 3})
	got := drainAll(q)
	if len(got) != 1 {
		t.Fatalf("consecutive moves should coalesce to 1, got %d (%+v)", len(got), got)
	}
	if got[0].X != 3 || got[0].Y != 3 {
		t.Errorf("coalesced move should hold the LATEST position (3,3), got (%d,%d)", got[0].X, got[0].Y)
	}
	if q.coalesced != 2 {
		t.Errorf("want 2 coalesced, got %d", q.coalesced)
	}
}

func TestInputQueue_MovesSeparatedByClickDoNotCoalesce(t *testing.T) {
	// A move → click → move sequence must keep BOTH moves and the click, in
	// order (dragging depends on the move that precedes a mouse_down).
	q := newInputEventQueue()
	q.push(InputEvent{Type: "mouse_move", X: 1, Y: 1})
	q.push(InputEvent{Type: "mouse_down", Button: "left", X: 1, Y: 1})
	q.push(InputEvent{Type: "mouse_move", X: 5, Y: 5})
	got := drainAll(q)
	want := []string{"mouse_move", "mouse_down", "mouse_move"}
	if len(got) != len(want) {
		t.Fatalf("want %d events, got %d (%+v)", len(want), len(got), got)
	}
	for i := range want {
		if got[i].Type != want[i] {
			t.Errorf("event %d: want type %s, got %s", i, want[i], got[i].Type)
		}
	}
	if got[0].X != 1 || got[2].X != 5 {
		t.Errorf("moves either side of the click must keep their own positions, got %+v", got)
	}
}

func TestInputQueue_KeysAndClicksNeverCoalesce(t *testing.T) {
	// Rapid identical keydowns (key repeat) and clicks must all survive.
	q := newInputEventQueue()
	for i := 0; i < 5; i++ {
		q.push(InputEvent{Type: "key_down", Key: "a"})
	}
	for i := 0; i < 3; i++ {
		q.push(InputEvent{Type: "mouse_down", Button: "left"})
	}
	q.push(InputEvent{Type: "mouse_scroll", Delta: 120})
	q.push(InputEvent{Type: "mouse_scroll", Delta: 120})
	got := drainAll(q)
	if len(got) != 10 {
		t.Fatalf("keys/clicks/scrolls must never coalesce; want 10, got %d (%+v)", len(got), got)
	}
	if q.coalesced != 0 {
		t.Errorf("want 0 coalesced, got %d", q.coalesced)
	}
}

func TestInputQueue_SafetyCapDropsOldestMoveNeverKeys(t *testing.T) {
	q := newInputEventQueue()
	// Fill the queue to the safety cap with NON-coalescable non-move events so
	// no tail-coalescing occurs (alternate keys/clicks so no two moves are
	// adjacent). Then interleave moves that the cap can drop.
	// Build: [key, move, key, move, ...] up to the cap, then push more.
	pushed := 0
	for pushed < inputQueueSafetyCap {
		q.push(InputEvent{Type: "key_down", Key: "x"})
		pushed++
		if pushed < inputQueueSafetyCap {
			q.push(InputEvent{Type: "mouse_move", X: pushed, Y: pushed})
			pushed++
		}
	}
	keysBefore := 0
	for _, ev := range q.events {
		if ev.Type == "key_down" {
			keysBefore++
		}
	}
	// Now push extra non-move events over the cap — the safety valve must make
	// room by dropping the OLDEST move, never a key.
	q.push(InputEvent{Type: "mouse_down", Button: "left"})
	q.push(InputEvent{Type: "key_down", Key: "z"})

	got := drainAll(q)
	keysAfter := 0
	for _, ev := range got {
		if ev.Type == "key_down" {
			keysAfter++
		}
	}
	if keysAfter < keysBefore+1 { // +1 for the "z" we added; "x" keys all retained
		t.Errorf("safety valve dropped a key: keysBefore=%d, keysAfter=%d", keysBefore, keysAfter)
	}
	if q.dropped == 0 {
		t.Errorf("expected the safety valve to have dropped at least one move")
	}
}

func TestInputQueue_CloseStopsAccepting(t *testing.T) {
	q := newInputEventQueue()
	q.push(InputEvent{Type: "key_down", Key: "a"})
	q.close()
	q.push(InputEvent{Type: "key_down", Key: "b"})
	if got := drainAll(q); len(got) != 0 {
		t.Errorf("closed queue must accept nothing and drain empty, got %+v", got)
	}
}

func TestInputQueue_ConcurrentProducerConsumerNeverLosesKeys(t *testing.T) {
	// Mirrors the real topology: a producer (SCTP goroutine) pushes while a
	// worker drains on notify. Every key_down must be injected exactly once even
	// though interleaved moves coalesce. Run under -race.
	q := newInputEventQueue()
	const keys = 2000
	got := make(chan string, keys)
	done := make(chan struct{})

	go func() { // worker
		for {
			select {
			case <-done:
				// final drain after producer finished
				for {
					ev, ok := q.pop()
					if !ok {
						return
					}
					if ev.Type == "key_down" {
						got <- ev.Key
					}
				}
			case <-q.notify:
				for {
					ev, ok := q.pop()
					if !ok {
						break
					}
					if ev.Type == "key_down" {
						got <- ev.Key
					}
				}
			}
		}
	}()

	for i := 0; i < keys; i++ {
		// Interleave a burst of moves (coalesce-able) with each key.
		q.push(InputEvent{Type: "mouse_move", X: i, Y: i})
		q.push(InputEvent{Type: "mouse_move", X: i + 1, Y: i + 1})
		q.push(InputEvent{Type: "key_down", Key: "k"})
	}
	close(done)

	count := 0
	timeout := time.After(5 * time.Second)
	for count < keys {
		select {
		case <-got:
			count++
		case <-timeout:
			t.Fatalf("lost keys under concurrency: got %d/%d", count, keys)
		}
	}
}

func TestInputQueue_NotifySignalsWorker(t *testing.T) {
	q := newInputEventQueue()
	q.push(InputEvent{Type: "key_down", Key: "a"})
	select {
	case <-q.notify:
	default:
		t.Fatal("push should have signaled the notify channel")
	}
}
