package websocket

import (
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// The simulator paces its sessions with the shipped policy through this
// facade instead of a hand-kept mirror (W09, #8148, A11). For any event
// sequence the facade's waits must equal reconnectBackoff's.
func TestReconnectPacerMatchesClientPolicy(t *testing.T) {
	type event struct {
		start       bool
		dialStatus  int // 0: no dial failure
		retryAfter  time.Duration
		closeCode   int
		local       bool
		lasted      time.Duration
		drainWithin time.Duration // < 0: no hint
	}
	seq := []event{
		{start: true},
		{dialStatus: -1},
		{dialStatus: http.StatusServiceUnavailable, retryAfter: 60 * time.Second},
		{dialStatus: http.StatusTooManyRequests, retryAfter: 5 * time.Second},
		{dialStatus: http.StatusUnauthorized, retryAfter: 60 * time.Second},
		{closeCode: 1001, lasted: time.Hour, drainWithin: -1},
		{closeCode: 1006, lasted: time.Hour, drainWithin: -1},
		{closeCode: 0, local: true, lasted: time.Minute, drainWithin: -1},
		{closeCode: 4001, local: true, lasted: time.Second, drainWithin: -1},
		{closeCode: 1000, lasted: time.Second, drainWithin: -1},
		{closeCode: 1001, lasted: time.Hour, drainWithin: 120 * time.Second},
		{closeCode: 1012, lasted: time.Hour, drainWithin: 0},
		{closeCode: 1000, lasted: 2 * time.Second, drainWithin: 120 * time.Second},
	}
	for _, window := range []time.Duration{defaultFirstReconnectWindow, 0, 90 * time.Second} {
		t.Run(fmt.Sprintf("window=%s", window), func(t *testing.T) {
			r1 := rand.New(rand.NewPCG(1, 2))
			r2 := rand.New(rand.NewPCG(1, 2))
			p := NewReconnectPacer(r1.Float64, window)
			b := newReconnectBackoff(r2.Float64)
			b.firstWindow = window
			for i, ev := range seq {
				var got, want time.Duration
				switch {
				case ev.start:
					got, want = p.AtStart(defaultStartDialWindow), b.atStart(defaultStartDialWindow)
				case ev.dialStatus != 0:
					got = p.AfterDialFailure(ev.dialStatus, ev.retryAfter)
					err := errors.New("dial tcp: connection refused")
					if ev.dialStatus == http.StatusServiceUnavailable || ev.dialStatus == http.StatusTooManyRequests {
						err = &upgradeRefusedError{StatusCode: ev.dialStatus, RetryAfter: ev.retryAfter}
					}
					want = b.afterDialFailure(err)
				default:
					got = p.AfterDisconnect(ev.closeCode, ev.local, ev.lasted, ev.drainWithin)
					readErr := io.ErrUnexpectedEOF
					if ev.closeCode != 0 && ev.closeCode != websocket.CloseAbnormalClosure {
						readErr = &websocket.CloseError{Code: ev.closeCode}
					}
					kind, _ := classifyDisconnect(readErr, ev.local)
					if ev.drainWithin >= 0 {
						want = b.afterDrainedDisconnect(kind, ev.lasted, ev.drainWithin)
					} else {
						want = b.afterDisconnect(kind, ev.lasted)
					}
				}
				if got != want {
					t.Fatalf("event %d %+v: pacer %v, client policy %v", i, ev, got, want)
				}
			}
		})
	}
}

func TestReconnectPacerPreW09CohortIsShippedPacing(t *testing.T) {
	// The cohort the release replaces is #9145's agent: a stable server close
	// spreads over 1–5 s, not "immediate".
	for _, r := range randSamples {
		p := NewReconnectPacer(fixedRand(r), 0)
		if d := p.AfterDisconnect(1001, false, time.Hour, -1); d < serverCloseSpreadMin || d > serverCloseSpreadMax {
			t.Fatalf("r=%v: pre-W09 stable close %v outside [1s, 5s]", r, d)
		}
	}
}

func TestReconnectPacerClampsWindow(t *testing.T) {
	p := NewReconnectPacer(fixedRand(0.999999), time.Hour)
	if d := p.AfterDisconnect(1001, false, time.Hour, -1); d > maxFirstReconnectWindow {
		t.Fatalf("wait %v above the 300 s window ceiling", d)
	}
}
