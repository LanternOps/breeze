package heartbeat

import (
	"crypto/tls"
	"net/http"
	"sync/atomic"
	"testing"
)

// closeCountingTransport is certTagTransport that counts CloseIdleConnections.
type closeCountingTransport struct {
	certTagTransport
	closed *atomic.Int32
}

func (c closeCountingTransport) CloseIdleConnections() { c.closed.Add(1) }

// #8318 review fix 13: one client per staged certificate, reused by confirm
// and probe retries, rebuilt (the old one's idle connections closed) when
// phase 1 hands a fresh certificate, and closed when the flow ends.
func TestRebindReusesOneClientPerStagedCertificate(t *testing.T) {
	cases := []struct {
		name       string
		setup      func(r *rebindHarness)
		drives     int
		wantBuilds int32
		wantClosed int32 // at least
		swapped    bool  // wait for the restart: its goroutine reads the seams
	}{
		{name: "confirm retries reuse it", drives: 3, wantBuilds: 1, setup: func(r *rebindHarness) {
			r.fake.queue(&r.fake.confirmQueue, rebindInjection{status: 503}, rebindInjection{status: 503}, rebindInjection{status: 503})
		}},
		{name: "a fresh certificate rebuilds it", drives: 1, wantBuilds: 2, wantClosed: 1, setup: func(r *rebindHarness) {
			// Confirm says not staged: phase 1 again issues staged-cert-2.
			r.fake.queue(&r.fake.confirmQueue, rebindInjection{status: 409, body: map[string]any{"code": "not_staged", "state": "requested"}},
				rebindInjection{status: 503})
		}},
		{name: "the intent ending closes it", drives: 1, wantBuilds: 1, wantClosed: 1, setup: func(r *rebindHarness) {
			r.fake.queue(&r.fake.confirmQueue, rebindInjection{status: 409, body: map[string]any{"code": "target_alive", "state": "cancelled", "cancelReason": "target_alive"}})
		}},
		{name: "the swap closes it", drives: 1, wantBuilds: 1, wantClosed: 1, swapped: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newRebindHarness(t)
			var builds, closed atomic.Int32
			newRebindHTTPClient = func(tlsCfg *tls.Config) *http.Client {
				builds.Add(1)
				inner := stagedCertClient(tlsCfg).Transport.(certTagTransport)
				return &http.Client{Transport: closeCountingTransport{certTagTransport: inner, closed: &closed}}
			}
			if tc.setup != nil {
				tc.setup(r)
			}
			r.drive(r.directive(rebindGoldenIntent))
			for i := 1; i < tc.drives; i++ {
				r.drive(nil)
			}
			if got := builds.Load(); got != tc.wantBuilds {
				t.Fatalf("staged-certificate clients built = %d, want %d", got, tc.wantBuilds)
			}
			if tc.swapped {
				r.waitRestarts(1)
			}
			if got := closed.Load(); got < tc.wantClosed {
				t.Fatalf("idle connections closed %d times, want at least %d", got, tc.wantClosed)
			}
		})
	}
}
