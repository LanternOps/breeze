package websocket

import (
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// #8318 wave 1b: after a reattach confirm, every API node closes the SOURCE
// install's socket with 4040 "reattached" (reconnect, no backoff) through the
// revocation broadcast, and the TARGET's old install's with 4001 (credential
// denied). 4040 is a plain reconnect: after a healthy connection the agent
// waits only the server-close spread (from 1 s up to the first-reconnect
// window, at least 5 s: #8841's floor, widened by W09, that keeps a fleet
// closed at one instant from re-dialling at one instant) and the exponential
// step is reset, not advanced — however often it repeats. 4001 escalates like
// any credential refusal.
func TestReattachCloseCodes(t *testing.T) {
	kind, code := classifyDisconnect(&websocket.CloseError{Code: 4040, Text: "reattached"}, false)
	if kind != disconnectServerNormal || code != 4040 {
		t.Fatalf("4040 reattached classified %v/%d, want server_normal/4040", kind, code)
	}
	for _, r := range randSamples {
		b := newReconnectBackoff(fixedRand(r))
		b.step = maxBackoff // left over from earlier failures
		spreadMax := max(b.firstWindow, serverCloseSpreadMax)
		for i := range 5 {
			d := b.afterDisconnect(kind, stableConnectionThreshold+time.Second)
			if d < serverCloseSpreadMin || d > spreadMax {
				t.Fatalf("r=%v close %d: delay = %v, want within [%v, %v]", r, i, d, serverCloseSpreadMin, spreadMax)
			}
			if b.step != initialBackoff {
				t.Fatalf("r=%v close %d: step = %v, want %v (no exponential backoff)", r, i, b.step, initialBackoff)
			}
		}
	}

	kind, code = classifyDisconnect(&websocket.CloseError{Code: 4001, Text: "credential revoked"}, false)
	if kind != disconnectAbnormal || code != 4001 {
		t.Fatalf("4001 classified %v/%d, want abnormal/4001", kind, code)
	}
	b := newReconnectBackoff(fixedRand(0.5))
	b.afterDisconnect(kind, stableConnectionThreshold+time.Second)
	if b.step <= initialBackoff {
		t.Fatalf("step after 4001 = %v, want it advanced past %v", b.step, initialBackoff)
	}
}
