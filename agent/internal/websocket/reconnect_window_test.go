package websocket

import (
	"fmt"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// W09 (#8148, D1): after a stable socket (> 30 s) the server closes, the
// agent spreads its redial over the first-reconnect window (default 30 s)
// instead of #9145's 1–5 s, so a fleet dropped by one API restart arrives
// over ~29 s rather than ~4 s. A window at or below 5 s reproduces #9145.

func TestReconnectBackoff_StableRemoteCloseSpreadsOverFirstWindow(t *testing.T) {
	for _, code := range []int{1000, 1001, 4040, 1006, 4008, 4001} {
		for _, lasted := range []time.Duration{31 * time.Second, time.Hour} {
			for _, r := range randSamples {
				t.Run(fmt.Sprintf("code=%d/lasted=%s/r=%v", code, lasted, r), func(t *testing.T) {
					b := newReconnectBackoff(fixedRand(r))
					kind, _ := classifyDisconnect(&websocket.CloseError{Code: code}, false)
					d := b.afterDisconnect(kind, lasted)
					if d < serverCloseSpreadMin || d > defaultFirstReconnectWindow {
						t.Fatalf("delay = %v, want within [%v, %v]", d, serverCloseSpreadMin, defaultFirstReconnectWindow)
					}
				})
			}
		}
	}
	b := newReconnectBackoff(fixedRand(0.5))
	if d := b.afterDisconnect(disconnectServerNormal, time.Minute); d != 15500*time.Millisecond {
		t.Fatalf("stable normal close at r=0.5 = %v, want 15.5s (U(1s, 30s))", d)
	}
}

func TestReconnectBackoff_FirstWindowAtOrBelow5sIsPreW09(t *testing.T) {
	for _, w := range []time.Duration{0, 3 * time.Second, 5 * time.Second} {
		b := newReconnectBackoff(fixedRand(0.5))
		b.firstWindow = w
		if d := b.afterDisconnect(disconnectServerNormal, time.Minute); d != 3*time.Second {
			t.Fatalf("window %v: stable normal close at r=0.5 = %v, want 3s (#9145's U(1s, 5s))", w, d)
		}
		for _, r := range randSamples {
			for _, kind := range []disconnectKind{disconnectServerNormal, disconnectAbnormal} {
				b := newReconnectBackoff(fixedRand(r))
				b.firstWindow = w
				if d := b.afterDisconnect(kind, time.Minute); d < serverCloseSpreadMin || d > serverCloseSpreadMax {
					t.Fatalf("window %v kind %v r=%v: delay %v outside [%v, %v]", w, kind, r, d, serverCloseSpreadMin, serverCloseSpreadMax)
				}
			}
		}
	}
}

func TestReconnectBackoff_ShortLivedCloseIgnoresFirstWindow(t *testing.T) {
	want := []time.Duration{3, 3, 4, 8, 16, 32, 60, 60, 60, 60}
	for _, w := range []time.Duration{defaultFirstReconnectWindow, 0} {
		b := newReconnectBackoff(fixedRand(0.5))
		b.firstWindow = w
		for i, ws := range want {
			if d := b.afterDisconnect(disconnectServerNormal, time.Second); d != ws*time.Second {
				t.Fatalf("window %v close %d: delay %v, want %v", w, i, d, ws*time.Second)
			}
		}
	}
}

func TestReconnectBackoff_AtStart(t *testing.T) {
	b := newReconnectBackoff(fixedRand(0.5))
	if d := b.atStart(10 * time.Second); d != 5*time.Second {
		t.Fatalf("atStart(10s) at r=0.5 = %v, want 5s", d)
	}
	if d := b.atStart(0); d != 0 {
		t.Fatalf("atStart(0) = %v, want 0", d)
	}
	if d := b.atStart(-time.Second); d != 0 {
		t.Fatalf("atStart(-1s) = %v, want 0", d)
	}
	if b.step != initialBackoff {
		t.Fatalf("atStart changed the step to %v", b.step)
	}
	if d := newReconnectBackoff(fixedRand(0)).atStart(10 * time.Second); d != 0 {
		t.Fatalf("atStart(10s) at r=0 = %v, want 0 (no floor on the first dial)", d)
	}
}

func TestClampFirstReconnectWindow(t *testing.T) {
	tests := []struct {
		in, want time.Duration
	}{
		{-time.Second, 0},
		{0, 0},
		{30 * time.Second, 30 * time.Second},
		{maxFirstReconnectWindow, maxFirstReconnectWindow},
		{maxFirstReconnectWindow + time.Second, maxFirstReconnectWindow},
	}
	for _, tt := range tests {
		if got := clampFirstReconnectWindow(tt.in); got != tt.want {
			t.Errorf("clampFirstReconnectWindow(%v) = %v, want %v", tt.in, got, tt.want)
		}
	}
}
