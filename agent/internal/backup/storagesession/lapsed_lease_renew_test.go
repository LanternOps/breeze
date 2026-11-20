package storagesession

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// #11813: a verification can reach the helper long after its session was
// delivered (it waited on the agent's verification lane), with its lease
// already lapsed. The control plane renews such an unused session, but
// refuses any other call on a lapsed lease (410, which ends the session). So
// the helper's first call must be a renew that succeeds before any resolve:
// a renew that fails transiently must be retried, not skipped, and a device
// clock behind the control plane must not hide that the lease has lapsed.

// leaseEnforcingControlPlane answers resolve 410 while the lease, on the
// control plane's clock, has lapsed: exactly what the API does.
type leaseEnforcingControlPlane struct {
	*fakeControlPlane
	server *fakeClock

	mu       sync.Mutex
	lease    time.Time
	order    []string
	refused  int
	failNext []int         // statuses to answer the next renews with, in order
	grant    time.Duration // lease a successful renew grants
}

func newLeaseEnforcingControlPlane(t *testing.T, server *fakeClock, lease time.Time) *leaseEnforcingControlPlane {
	t.Helper()
	st := newFakeStorage(t)
	st.put("snapshots/s1/files/a", []byte("payload"))
	l := &leaseEnforcingControlPlane{fakeControlPlane: newFakeControlPlane(t, st), server: server, lease: lease, grant: 15 * time.Minute}
	l.set(func(cp *fakeControlPlane) {
		cp.now = server.Now
		cp.renewHook = func(_ int, w http.ResponseWriter) bool {
			l.mu.Lock()
			defer l.mu.Unlock()
			l.order = append(l.order, "renew")
			if len(l.failNext) > 0 {
				status := l.failNext[0]
				l.failNext = l.failNext[1:]
				http.Error(w, "unavailable", status)
				return true
			}
			l.lease = server.Now().Add(l.grant)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{"expiresAt": l.lease.UTC().Format(time.RFC3339)})
			return true
		}
		cp.resolveHook = func(_ int, _ []string, w http.ResponseWriter) bool {
			l.mu.Lock()
			defer l.mu.Unlock()
			l.order = append(l.order, "resolve")
			if !server.Now().Before(l.lease) {
				l.refused++
				http.Error(w, `{"error":"Storage session has expired"}`, http.StatusGone)
				return true
			}
			return false
		}
	})
	return l
}

func (l *leaseEnforcingControlPlane) calls() ([]string, int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.order...), l.refused
}

func TestLapsedLeaseIsRenewedBeforeTheFirstResolve(t *testing.T) {
	cases := []struct {
		name string
		// device clock offset from the control plane's
		deviceOffset time.Duration
		// how long before "now" (control plane clock) the lease lapsed
		lapsedFor  time.Duration
		failRenews []int
		wantWaits  int
	}{
		{name: "lapsed lease, renew succeeds", lapsedFor: time.Minute},
		{name: "lapsed lease, first renew 503 then 200", lapsedFor: time.Minute, failRenews: []int{http.StatusServiceUnavailable}, wantWaits: 1},
		{name: "lapsed lease, renew 429 then 500 then 200", lapsedFor: time.Hour, failRenews: []int{http.StatusTooManyRequests, http.StatusInternalServerError}, wantWaits: 2},
		// Delivered 16 minutes ago with a 15-minute lease, on a device whose
		// clock is 20 minutes behind: on its own clock 19 minutes are left.
		{name: "device clock 20m behind, 16m-old lease", deviceOffset: -20 * time.Minute, lapsedFor: time.Minute},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			waits := noSleep(t)
			server := &fakeClock{now: time.Now().Truncate(time.Second)}
			device := func() time.Time { return server.Now().Add(tc.deviceOffset) }
			lease := server.Now().Add(-tc.lapsedFor)
			cp := newLeaseEnforcingControlPlane(t, server, lease)
			cp.mu.Lock()
			cp.failNext = append([]int(nil), tc.failRenews...)
			cp.mu.Unlock()

			d := testDescriptor(cp.fakeControlPlane, server.Now())
			d.ExpiresAt = lease.UTC().Format(time.RFC3339)
			d.Deadline = server.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339)
			p := newTestProvider(t, cp.fakeControlPlane, d, Options{Now: device, RenewCheckInterval: time.Hour})

			if err := p.Download("snapshots/s1/files/a", filepath.Join(t.TempDir(), "a")); err != nil {
				t.Fatalf("Download: %v", err)
			}
			order, refused := cp.calls()
			if refused != 0 {
				t.Fatalf("a resolve was refused on the lapsed lease (calls %v)", order)
			}
			if len(order) == 0 || order[0] != "renew" {
				t.Fatalf("calls %v: the first call must be a renew", order)
			}
			if want := len(tc.failRenews) + 1; countOf(order, "renew") != want {
				t.Fatalf("calls %v: want %d renews", order, want)
			}
			if len(*waits) != tc.wantWaits {
				t.Fatalf("backoff waits %v, want %d", *waits, tc.wantWaits)
			}
		})
	}
}

// A lapsed lease that the control plane keeps refusing to renew transiently
// ends the call with an error after bounded attempts; it never falls through
// to a resolve that would end the session.
func TestLapsedLeaseWhoseRenewKeepsFailingNeverResolves(t *testing.T) {
	noSleep(t)
	server := &fakeClock{now: time.Now().Truncate(time.Second)}
	lease := server.Now().Add(-time.Minute)
	cp := newLeaseEnforcingControlPlane(t, server, lease)
	cp.mu.Lock()
	for i := 0; i < 50; i++ {
		cp.failNext = append(cp.failNext, http.StatusServiceUnavailable)
	}
	cp.mu.Unlock()
	d := testDescriptor(cp.fakeControlPlane, server.Now())
	d.ExpiresAt = lease.UTC().Format(time.RFC3339)
	p := newTestProvider(t, cp.fakeControlPlane, d, Options{Now: server.Now, RenewCheckInterval: time.Hour})

	err := p.Download("snapshots/s1/files/a", filepath.Join(t.TempDir(), "a"))
	if err == nil {
		t.Fatal("Download succeeded with a lease that could not be renewed")
	}
	order, _ := cp.calls()
	if countOf(order, "resolve") != 0 {
		t.Fatalf("calls %v: resolved on a lapsed lease", order)
	}
	if n := countOf(order, "renew"); n < 2 || n > transientMaxAttempts {
		t.Fatalf("calls %v: want 2..%d renew attempts", order, transientMaxAttempts)
	}
}

// Unchanged while the lease is valid and the clock is known: a failed renew
// is not retried and the resolve goes ahead on the remaining lease.
func TestValidLeaseFailedRenewStillResolves(t *testing.T) {
	waits := noSleep(t)
	server := &fakeClock{now: time.Now().Truncate(time.Second)}
	lease := server.Now().Add(90 * time.Second)
	cp := newLeaseEnforcingControlPlane(t, server, lease)
	cp.mu.Lock()
	cp.grant = 90 * time.Second // a renew re-grants the same short lease
	cp.mu.Unlock()
	d := testDescriptor(cp.fakeControlPlane, server.Now())
	d.ExpiresAt = lease.UTC().Format(time.RFC3339)
	p := newTestProvider(t, cp.fakeControlPlane, d, Options{Now: server.Now, RenewCheckInterval: time.Hour})
	dir := t.TempDir()
	if err := p.Download("snapshots/s1/files/a", filepath.Join(dir, "a")); err != nil {
		t.Fatalf("first Download: %v", err)
	}
	base, _ := cp.calls()

	server.Advance(65 * time.Second) // 25 s of the lease left: renew due
	cp.mu.Lock()
	cp.failNext = []int{http.StatusServiceUnavailable}
	cp.mu.Unlock()
	cp.storage.put("snapshots/s1/files/b", []byte("other")) // a key not resolved yet
	if err := p.Download("snapshots/s1/files/b", filepath.Join(dir, "b")); err != nil {
		t.Fatalf("second Download: %v", err)
	}
	order, refused := cp.calls()
	after := order[len(base):]
	if refused != 0 || len(after) < 2 || after[0] != "renew" || after[1] != "resolve" {
		t.Fatalf("calls after the lease ran low %v (refused %d): want one failed renew then the resolve", after, refused)
	}
	if len(*waits) != 0 {
		t.Fatalf("waited %v before resolving on a still-valid lease", *waits)
	}
}

func countOf(calls []string, op string) int {
	n := 0
	for _, c := range calls {
		if c == op {
			n++
		}
	}
	return n
}
