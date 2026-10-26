package websocket

import (
	"encoding/json"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Real Client + fake clock for the drain hint (W09, #8148, D4/D8). Each test
// waits on testHooks.drainStored before advancing the clock, so the hint's
// receipt time is pinned.

func newDrainTestClient(srvURL string) (*Client, chan struct{}, chan struct{}) {
	c, connected := newWindowTestClient(srvURL)
	stored := make(chan struct{}, 16)
	c.testHooks.drainStored = stored
	return c, connected, stored
}

func sendDrain(t *testing.T, sc *websocket.Conn, withinMs int) {
	t.Helper()
	msg, _ := json.Marshal(map[string]any{"type": "drain", "reconnectWithinMs": withinMs, "reason": "rolling-deploy"})
	if err := sc.WriteMessage(websocket.TextMessage, msg); err != nil {
		t.Fatalf("server write drain: %v", err)
	}
}

func waitDrainStored(t *testing.T, stored <-chan struct{}) {
	t.Helper()
	select {
	case <-stored:
	case <-time.After(5 * time.Second):
		t.Fatal("client did not store the drain hint within 5s")
	}
}

func TestDrainDelayStartsAtClose(t *testing.T) {
	clk := installFakeWSClock(t)
	installWSRand(t, 0.5)
	s := newScriptedWSServer(t, nil)
	c, connected, stored := newDrainTestClient(s.srv.URL)
	startLoop(t, c)

	sc := s.next(t)
	waitConnected(t, connected)
	sendDrain(t, sc, 120000)
	waitDrainStored(t, stored)
	clk.Advance(60 * time.Second)
	closeWith(t, sc, websocket.CloseGoingAway)

	if d := clk.NextWait(t); d != 60*time.Second {
		t.Fatalf("wait after a drain 120 s closed 60 s later = %v, want 60s from the close (U(0, 120 s))", d)
	}
}

func TestDrainThenImmediateClose(t *testing.T) {
	clk := installFakeWSClock(t)
	installWSRand(t, 0.25)
	s := newScriptedWSServer(t, nil)
	c, connected, stored := newDrainTestClient(s.srv.URL)
	startLoop(t, c)

	sc := s.next(t)
	waitConnected(t, connected)
	clk.Advance(31 * time.Second)
	sendDrain(t, sc, 120000)
	waitDrainStored(t, stored)
	closeWith(t, sc, websocket.CloseGoingAway)

	if d := clk.NextWait(t); d != 30*time.Second {
		t.Fatalf("wait after drain-then-close = %v, want 30s (U(0, 120 s) at 0.25)", d)
	}
}

func TestDrainExpires(t *testing.T) {
	clk := installFakeWSClock(t)
	installWSRand(t, 0.5)
	s := newScriptedWSServer(t, nil)
	c, connected, stored := newDrainTestClient(s.srv.URL)
	startLoop(t, c)

	sc := s.next(t)
	waitConnected(t, connected)
	sendDrain(t, sc, 10000)
	waitDrainStored(t, stored)
	clk.Advance(41 * time.Second) // 10 s + 30 s lifetime + 1 s
	closeWith(t, sc, websocket.CloseGoingAway)

	if d := clk.NextWait(t); d != 15500*time.Millisecond {
		t.Fatalf("wait after an expired hint = %v, want the first window's 15.5s", d)
	}
}

func TestDuplicateDrainFirstWins(t *testing.T) {
	clk := installFakeWSClock(t)
	installWSRand(t, 0.5)
	s := newScriptedWSServer(t, nil)
	c, connected, stored := newDrainTestClient(s.srv.URL)
	startLoop(t, c)

	sc := s.next(t)
	waitConnected(t, connected)
	clk.Advance(31 * time.Second)
	sendDrain(t, sc, 120000)
	waitDrainStored(t, stored)
	sendDrain(t, sc, 10000)
	// The second hint is ignored, so nothing is stored; close and let the
	// loop consume what it has.
	closeWith(t, sc, websocket.CloseGoingAway)

	if d := clk.NextWait(t); d != 60*time.Second {
		t.Fatalf("wait after drain 120 s then drain 10 s = %v, want 60s (first wins)", d)
	}
}

func TestDrainHintClearedOnNewSocket(t *testing.T) {
	clk := installFakeWSClock(t)
	installWSRand(t, 0.5)
	s := newScriptedWSServer(t, nil)
	c, connected, stored := newDrainTestClient(s.srv.URL)
	startLoop(t, c)

	sc := s.next(t)
	waitConnected(t, connected)
	sendDrain(t, sc, 120000)
	waitDrainStored(t, stored)
	closeWith(t, sc, websocket.CloseGoingAway)
	first := clk.NextWait(t)
	clk.Advance(first)

	sc2 := s.next(t)
	waitConnected(t, connected)
	clk.Advance(31 * time.Second)
	closeWith(t, sc2, websocket.CloseGoingAway)
	if d := clk.NextWait(t); d != 15500*time.Millisecond {
		t.Fatalf("wait after the second socket (no drain) = %v, want the first window's 15.5s", d)
	}
}

func TestDrainZeroDoesNotDefeatBackoff(t *testing.T) {
	clk := installFakeWSClock(t)
	installWSRand(t, 0.5)
	s := newScriptedWSServer(t, nil)
	c, connected, stored := newDrainTestClient(s.srv.URL)
	startLoop(t, c)

	for i, want := range []time.Duration{3, 3, 4, 8, 16} {
		sc := s.next(t)
		waitConnected(t, connected)
		sendDrain(t, sc, 0)
		waitDrainStored(t, stored)
		closeWith(t, sc, websocket.CloseGoingAway)
		d := clk.NextWait(t)
		if d != want*time.Second {
			t.Fatalf("close %d after drain 0: wait %v, want %v (the short-lived backoff)", i, d, want*time.Second)
		}
		clk.Advance(d)
	}
}

func TestDrainShortWindowKeepsSpread(t *testing.T) {
	for _, tc := range []struct {
		r    float64
		want time.Duration
	}{{0.5, 2500 * time.Millisecond}, {0, minReconnectDelay}} {
		t.Run("", func(t *testing.T) {
			clk := installFakeWSClock(t)
			installWSRand(t, tc.r)
			s := newScriptedWSServer(t, nil)
			c, connected, stored := newDrainTestClient(s.srv.URL)
			startLoop(t, c)

			sc := s.next(t)
			waitConnected(t, connected)
			clk.Advance(31 * time.Second)
			sendDrain(t, sc, 0)
			waitDrainStored(t, stored)
			closeWith(t, sc, websocket.CloseGoingAway)
			if d := clk.NextWait(t); d != tc.want {
				t.Fatalf("r=%v: wait after drain 0 on a stable socket = %v, want %v (U(0, 5 s), floored)", tc.r, d, tc.want)
			}
		})
	}
}

func TestRefusalAfterDrainUsesRetryAfter(t *testing.T) {
	clk := installFakeWSClock(t)
	installWSRand(t, 0.5)
	s := newScriptedWSServer(t, func(attempt int, w http.ResponseWriter) bool {
		if attempt == 2 {
			w.Header().Set("Retry-After", "60")
			w.WriteHeader(http.StatusServiceUnavailable)
			return true
		}
		return false
	})
	c, connected, stored := newDrainTestClient(s.srv.URL)
	startLoop(t, c)

	sc := s.next(t)
	waitConnected(t, connected)
	clk.Advance(31 * time.Second)
	sendDrain(t, sc, 120000)
	waitDrainStored(t, stored)
	closeWith(t, sc, websocket.CloseGoingAway)
	if d := clk.NextWait(t); d != 60*time.Second {
		t.Fatalf("drain wait = %v, want 60s", d)
	}
	clk.Advance(60 * time.Second)
	if d := clk.NextWait(t); d != 69*time.Second {
		t.Fatalf("wait after the refused redial = %v, want 69s (Retry-After 60 × 1.15)", d)
	}
}

func TestDrainNeverClosesTheSocketItself(t *testing.T) {
	installFakeWSClock(t)
	installWSRand(t, 0.5)
	s := newScriptedWSServer(t, nil)
	c, connected, stored := newDrainTestClient(s.srv.URL)
	startLoop(t, c)

	sc := s.next(t)
	waitConnected(t, connected)
	sendDrain(t, sc, 120000)
	waitDrainStored(t, stored)
	if !c.IsConnected() {
		t.Fatal("client dropped its socket after a drain hint; the server closes, not the agent")
	}
	if err := sc.WriteMessage(websocket.TextMessage, []byte(`{"type":"ping"}`)); err != nil {
		t.Fatalf("server write ping: %v", err)
	}
	_ = sc.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, msg, err := sc.ReadMessage()
	if err != nil {
		t.Fatalf("socket not usable after a drain hint: %v", err)
	}
	var frame struct{ Type string }
	if json.Unmarshal(msg, &frame) != nil || frame.Type != "pong" {
		t.Fatalf("got %s, want a pong", msg)
	}
}

func TestDrainNotTreatedAsCommand(t *testing.T) {
	installFakeWSClock(t)
	installWSRand(t, 0.5)
	s := newScriptedWSServer(t, nil)
	var commands atomic.Int32
	c := newTestClient(s.srv.URL, func(cmd Command) CommandResult {
		commands.Add(1)
		return CommandResult{Status: "ok"}
	})
	connected := make(chan struct{}, 16)
	stored := make(chan struct{}, 16)
	c.testHooks.connected = connected
	c.testHooks.drainStored = stored
	startLoop(t, c)

	sc := s.next(t)
	waitConnected(t, connected)
	// A drain frame that also carries an id must still be a drain, never a
	// "drain" command handed to the command handler.
	if err := sc.WriteMessage(websocket.TextMessage, []byte(`{"type":"drain","id":"x1","reconnectWithinMs":1000}`)); err != nil {
		t.Fatal(err)
	}
	waitDrainStored(t, stored)
	// A ping after it proves the pump read past the drain frame.
	_ = sc.WriteMessage(websocket.TextMessage, []byte(`{"type":"ping"}`))
	_ = sc.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, _, err := sc.ReadMessage(); err != nil {
		t.Fatalf("read pong: %v", err)
	}
	if n := commands.Load(); n != 0 {
		t.Fatalf("command handler called %d times for a drain frame", n)
	}
}
