package websocket

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/parked"
)

func refuseParked(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusForbidden)
	_, _ = io.WriteString(w, `{"error":"device_pending_assignment"}`)
}

// #8318 D-1a: a parked refusal parks the state and the loop stops dialing
// (no backoff redial); assignment makes it dial at once.
func TestParkedRefusalWaitsForAssignmentThenRedials(t *testing.T) {
	clk := installFakeWSClock(t)
	installWSRand(t, 0.5)
	st := parked.New()
	s := newScriptedWSServer(t, func(attempt int, w http.ResponseWriter) bool {
		if attempt == 1 {
			refuseParked(w)
			return true
		}
		return false
	})
	c, connected := newWindowTestClient(s.srv.URL)
	c.config.Parked = st
	startLoop(t, c)

	// The refused dial parks the state; the loop then waits only for the
	// probe interval (no reconnect backoff).
	if got := clk.NextWait(t); got != parkedProbeInterval {
		t.Fatalf("wait after a parked refusal = %v, want the probe interval %v", got, parkedProbeInterval)
	}
	if !st.Parked() {
		t.Fatal("the parked refusal did not park the state")
	}
	if n := s.dials.Load(); n != 1 {
		t.Fatalf("dials while parked = %d, want 1", n)
	}

	// Assignment: the first full beat. The loop dials now, without the
	// probe interval passing.
	st.ObserveBeat(false)
	waitConnected(t, connected)
	if n := s.dials.Load(); n != 2 {
		t.Fatalf("dials after assignment = %d, want 2", n)
	}
}

// The probe: still parked after parkedProbeInterval, the loop dials once and
// goes back to waiting.
func TestParkedLoopProbesOncePerInterval(t *testing.T) {
	clk := installFakeWSClock(t)
	installWSRand(t, 0.5)
	st := parked.New()
	st.ObserveBeat(true)
	s := newScriptedWSServer(t, func(attempt int, w http.ResponseWriter) bool {
		refuseParked(w)
		return true
	})
	c, _ := newWindowTestClient(s.srv.URL)
	c.config.Parked = st
	startLoop(t, c)

	if got := clk.NextWait(t); got != parkedProbeInterval {
		t.Fatalf("first wait while parked = %v, want %v", got, parkedProbeInterval)
	}
	if n := s.dials.Load(); n != 0 {
		t.Fatalf("dialed %d times while already parked, want 0", n)
	}
	clk.Advance(parkedProbeInterval)
	if got := clk.NextWait(t); got != parkedProbeInterval {
		t.Fatalf("wait after a refused probe = %v, want %v", got, parkedProbeInterval)
	}
	if n := s.dials.Load(); n != 1 {
		t.Fatalf("probe dials = %d, want 1", n)
	}
}

// Without a state (or with the refusal muted, an older server), a parked
// refusal backs off like any refused upgrade: the loop never spins.
func TestParkedRefusalWithoutStateBacksOff(t *testing.T) {
	clk := installFakeWSClock(t)
	installWSRand(t, 0.5)
	s := newScriptedWSServer(t, func(attempt int, w http.ResponseWriter) bool {
		refuseParked(w)
		return true
	})
	c, _ := newWindowTestClient(s.srv.URL)
	startLoop(t, c)

	if got := clk.NextWait(t); got != initialBackoff {
		t.Fatalf("wait = %v, want the dial-failure step %v", got, initialBackoff)
	}
}

func TestMutedRefusalBacksOff(t *testing.T) {
	clk := installFakeWSClock(t)
	installWSRand(t, 0.5)
	st := parked.New()
	st.NoteRefusal()
	st.ObserveBeat(false) // an older server: leaves and mutes
	s := newScriptedWSServer(t, func(attempt int, w http.ResponseWriter) bool {
		refuseParked(w)
		return true
	})
	c, _ := newWindowTestClient(s.srv.URL)
	c.config.Parked = st
	startLoop(t, c)

	if got := clk.NextWait(t); got != initialBackoff {
		t.Fatalf("wait = %v, want the dial-failure step %v", got, initialBackoff)
	}
	if st.Parked() {
		t.Fatal("a muted refusal parked the state")
	}
}

func TestUpgradeRefusedErrorReadsPendingAssignment(t *testing.T) {
	body := `{"error":"device_pending_assignment"}`
	resp := &http.Response{StatusCode: http.StatusForbidden, Body: io.NopCloser(strings.NewReader(body))}
	e := newUpgradeRefusedError(resp, errors.New("bad handshake"), time.Now())
	if !e.PendingAssignment {
		t.Fatal("PendingAssignment = false for the parked refusal")
	}
	plain := &http.Response{StatusCode: http.StatusUnauthorized, Body: io.NopCloser(strings.NewReader(`{"error":"Unauthorized"}`))}
	if newUpgradeRefusedError(plain, errors.New("bad handshake"), time.Now()).PendingAssignment {
		t.Fatal("a plain 401 read as pending assignment")
	}
}
