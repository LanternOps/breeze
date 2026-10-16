package ech

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const (
	dialHost = "inner.test"
	dialAddr = dialHost + ":443"
)

var dialT0 = time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)

// fakeClock is a goroutine-safe settable clock for Options.Now.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Set(t time.Time) {
	c.mu.Lock()
	c.t = t
	c.mu.Unlock()
}

// dialRig is the counting TCPDial wrapper. It ignores the addr it is given
// (always dialAddr) and dials the current target instead; queued targets
// (thenTarget) take over one per dial.
type dialRig struct {
	mu     sync.Mutex
	target string
	queue  []string
	dials  atomic.Int32
}

func newRig(target string) *dialRig { return &dialRig{target: target} }

// setTarget sets the current target and clears any queued ones.
func (r *dialRig) setTarget(addr string) {
	r.mu.Lock()
	r.target, r.queue = addr, nil
	r.mu.Unlock()
}

// thenTarget queues targets for the following dials, one per dial.
func (r *dialRig) thenTarget(addrs ...string) {
	r.mu.Lock()
	r.queue = append(r.queue, addrs...)
	r.mu.Unlock()
}

func (r *dialRig) dial(ctx context.Context, network, _ string) (net.Conn, error) {
	r.dials.Add(1)
	r.mu.Lock()
	target := r.target
	if len(r.queue) > 0 {
		r.target, r.queue = r.queue[0], r.queue[1:]
	}
	r.mu.Unlock()
	return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, target)
}

// startBlackhole accepts TCP connections and never answers, like a
// middlebox that drops ECH ClientHellos.
func startBlackhole(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var (
		mu    sync.Mutex
		conns []net.Conn
	)
	t.Cleanup(func() {
		_ = ln.Close()
		mu.Lock()
		for _, c := range conns {
			_ = c.Close()
		}
		mu.Unlock()
	})
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			conns = append(conns, c)
			mu.Unlock()
			go func() { _, _ = io.Copy(io.Discard, c) }()
		}
	}()
	return ln.Addr().String()
}

// closedAddr returns a loopback address with nothing listening.
func closedAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	return addr
}

// failResolver counts DoH hits; any hit is a test error.
func failResolver(t *testing.T) (*Resolver, *atomic.Int32) {
	t.Helper()
	hits := new(atomic.Int32)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		t.Errorf("unexpected DoH request for %q", r.URL.Query().Get("name"))
		http.Error(w, "unexpected", http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)
	return NewResolver(srv.Client(), srv.URL), hits
}

// noECHResolver answers with no HTTPS record, so Lookup returns
// ErrNoECHConfig. It counts requests.
func noECHResolver(t *testing.T) (*Resolver, *atomic.Int32) {
	t.Helper()
	hits := new(atomic.Int32)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte(`{"Status":0,"Answer":[]}`))
	}))
	t.Cleanup(srv.Close)
	return NewResolver(srv.Client(), srv.URL), hits
}

// listResolver serves list as the host's ech= SvcParam.
func listResolver(t *testing.T, list []byte) *Resolver {
	t.Helper()
	body := fmt.Sprintf(`{"Status":0,"Answer":[{"type":65,"TTL":300,"data":"1 . alpn=h2 ech=%s"}]}`,
		base64.StdEncoding.EncodeToString(list))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return NewResolver(srv.Client(), srv.URL)
}

// hangResolver never answers until the request context ends. It counts
// requests.
func hangResolver(t *testing.T) (*Resolver, *atomic.Int32) {
	t.Helper()
	done := make(chan struct{})
	hits := new(atomic.Int32)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		select {
		case <-r.Context().Done():
		case <-done:
		}
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { close(done) }) // runs before srv.Close (LIFO)
	return NewResolver(srv.Client(), srv.URL), hits
}

func newTestDialer(t *testing.T, rig *dialRig, res *Resolver, clock *fakeClock, mods ...func(*Options)) *Dialer {
	t.Helper()
	opts := Options{
		TCPDial:       rig.dial,
		Resolver:      res,
		Cache:         NewCache(""),
		LocalEnabled:  true,
		ServerEnabled: true,
		Now:           clock.Now,
	}
	for _, m := range mods {
		m(&opts)
	}
	return New(opts)
}

func echFailures(d *Dialer, host string) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.state(host).echFailures
}

func forceMode(d *Dialer, host string, m Mode) {
	d.mu.Lock()
	d.state(host).mode = m
	d.mu.Unlock()
}

// waitFetchIdle blocks until no async config fetch is in flight for host.
func waitFetchIdle(t *testing.T, d *Dialer, host string) {
	t.Helper()
	for {
		d.mu.Lock()
		busy := d.fetching[host]
		d.mu.Unlock()
		if !busy {
			return
		}
		select {
		case <-t.Context().Done():
			t.Fatal("async fetch never finished")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func rawMode(d *Dialer, host string, now time.Time) Mode {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.state(host).Mode(now)
}

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})
}

// dialTLS runs one dial through the closure and returns the *tls.Conn.
func dialTLS(t *testing.T, d *Dialer, base *tls.Config, nextProtos []string) (*tls.Conn, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	return dialTLSCtx(t, ctx, d, base, nextProtos)
}

func dialTLSCtx(t *testing.T, ctx context.Context, d *Dialer, base *tls.Config, nextProtos []string) (*tls.Conn, error) {
	t.Helper()
	c, err := d.DialTLS(base, nextProtos)(ctx, "tcp", dialAddr)
	if err != nil {
		if c != nil {
			t.Fatalf("non-nil conn %T returned with error %v", c, err)
		}
		return nil, err
	}
	tc, ok := c.(*tls.Conn)
	if !ok {
		_ = c.Close()
		t.Fatalf("conn is %T, want *tls.Conn", c)
	}
	t.Cleanup(func() { _ = tc.Close() })
	return tc, nil
}

func mustDial(t *testing.T, d *Dialer, base *tls.Config) *tls.Conn {
	t.Helper()
	tc, err := dialTLS(t, d, base, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	return tc
}

func baseCfg(pool *x509.CertPool) *tls.Config {
	return &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: pool}
}

func waitCached(t *testing.T, c *Cache, host string) []byte {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if list, _, ok := c.Get(host); ok {
			return list
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("cache for %s never populated", host)
	return nil
}

func TestDial_PlainPathIsByteEqualToToday(t *testing.T) {
	var (
		mu  sync.Mutex
		got *tls.ConnectionState
	)
	addr, pool := startTLSServer(t, []string{dialHost}, nil, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		cs := *r.TLS
		got = &cs
		mu.Unlock()
	}))
	rig := newRig(addr)
	res, hits := failResolver(t)
	d := newTestDialer(t, rig, res, &fakeClock{t: dialT0})

	base := baseCfg(pool)
	tr := &http.Transport{ForceAttemptHTTP2: true, DialTLSContext: d.DialTLS(base, []string{"h2", "http/1.1"})}
	defer tr.CloseIdleConnections()
	resp, err := (&http.Client{Transport: tr, Timeout: 10 * time.Second}).Get("https://" + dialHost + "/")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	_ = resp.Body.Close()

	mu.Lock()
	defer mu.Unlock()
	if got == nil {
		t.Fatal("handler did not record TLS state")
	}
	if got.ServerName != dialHost {
		t.Errorf("ServerName = %q, want %q", got.ServerName, dialHost)
	}
	if got.NegotiatedProtocol != "h2" {
		t.Errorf("NegotiatedProtocol = %q, want h2", got.NegotiatedProtocol)
	}
	if got.Version != tls.VersionTLS13 {
		t.Errorf("Version = %x, want TLS 1.3", got.Version)
	}
	if got.ECHAccepted {
		t.Error("ECHAccepted on the plain path")
	}
	if n := rig.dials.Load(); n != 1 {
		t.Errorf("TCP dials = %d, want 1", n)
	}
	if d.Status(dialHost).ECHActive {
		t.Error("ECHActive = true on the plain path")
	}
	if n := hits.Load(); n != 0 {
		t.Errorf("DoH hits = %d, want 0", n)
	}
}

func TestDial_PlainNeverFetchesDoH(t *testing.T) {
	addr, pool := startTLSServer(t, []string{dialHost}, nil, okHandler())
	rig := newRig(addr)
	res, hits := failResolver(t)
	d := newTestDialer(t, rig, res, &fakeClock{t: dialT0})
	for i := 0; i < 5; i++ {
		mustDial(t, d, baseCfg(pool))
	}
	time.Sleep(50 * time.Millisecond) // let any stray async fetch land
	if n := hits.Load(); n != 0 {
		t.Fatalf("DoH hits = %d, want 0", n)
	}
	if st := d.Status(dialHost); st.Mode != ModePlain || st.ECHActive {
		t.Fatalf("status = %+v, want plain", st)
	}
}

func TestDial_SignatureThresholdThenECH(t *testing.T) {
	list, key := newECHConfigList(t, "public.test")
	echAddr, pool := startTLSServer(t, []string{dialHost, "public.test"}, []tls.EncryptedClientHelloKey{key}, okHandler())
	filterAddr, filterHits := startFilterListener(t)
	rig := newRig(filterAddr)
	clock := &fakeClock{t: dialT0}
	d := newTestDialer(t, rig, listResolver(t, list), clock)

	for i, at := range []time.Time{dialT0, dialT0.Add(2 * time.Minute)} {
		clock.Set(at)
		if _, err := dialTLS(t, d, baseCfg(pool), nil); !IsFilterSignature(err) {
			t.Fatalf("dial %d: err = %v, want filter signature", i+1, err)
		}
	}
	if n := filterHits.Load(); n != 2 {
		t.Fatalf("filter hits = %d, want 2", n)
	}
	// Engagement starts an async config fetch.
	waitCached(t, d.opts.Cache, dialHost)

	rig.setTarget(echAddr)
	tc := mustDial(t, d, baseCfg(pool))
	if !tc.ConnectionState().ECHAccepted {
		t.Fatal("third dial: ECHAccepted = false")
	}
	want := HostStatus{Mode: ModeECH, ECHActive: true, FilterSignatureSeenAt: dialT0.Add(2 * time.Minute), LastECHAcceptedAt: dialT0.Add(2 * time.Minute)}
	if got := d.Status(dialHost); got != want {
		t.Fatalf("Status = %+v, want %+v", got, want)
	}
}

func TestDial_SingleSignatureStaysPlain(t *testing.T) {
	plainAddr, pool := startTLSServer(t, []string{dialHost}, nil, okHandler())
	filterAddr, _ := startFilterListener(t)
	rig := newRig(filterAddr)
	res, hits := failResolver(t)
	clock := &fakeClock{t: dialT0}
	d := newTestDialer(t, rig, res, clock)

	if _, err := dialTLS(t, d, baseCfg(pool), nil); !IsFilterSignature(err) {
		t.Fatalf("err = %v, want filter signature", err)
	}
	rig.setTarget(plainAddr)
	clock.Set(dialT0.Add(time.Second))
	tc := mustDial(t, d, baseCfg(pool))
	if tc.ConnectionState().ECHAccepted {
		t.Fatal("ECHAccepted after a single signature")
	}
	st := d.Status(dialHost)
	if st.Mode != ModePlain {
		t.Fatalf("Mode = %v, want plain", st.Mode)
	}
	// The plain success is recorded so health can tell a stale signature
	// from a live filter.
	if !st.LastPlainSuccessAt.Equal(dialT0.Add(time.Second)) {
		t.Fatalf("LastPlainSuccessAt = %v, want %v", st.LastPlainSuccessAt, dialT0.Add(time.Second))
	}
	if !st.LastPlainSuccessAt.After(st.FilterSignatureSeenAt) {
		t.Fatalf("LastPlainSuccessAt %v not after FilterSignatureSeenAt %v", st.LastPlainSuccessAt, st.FilterSignatureSeenAt)
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("DoH hits = %d, want 0", n)
	}
}

func TestDial_ECHModeNoConfigFallsBackPlainImmediately(t *testing.T) {
	addr, pool := startTLSServer(t, []string{dialHost}, nil, okHandler())
	rig := newRig(addr)
	res, _ := noECHResolver(t)
	d := newTestDialer(t, rig, res, &fakeClock{t: dialT0})
	forceMode(d, dialHost, ModeECH)

	start := time.Now()
	tc := mustDial(t, d, baseCfg(pool))
	elapsed := time.Since(start)
	if tc.ConnectionState().ECHAccepted {
		t.Fatal("ECHAccepted without a config")
	}
	if n := rig.dials.Load(); n != 1 {
		t.Fatalf("TCP dials = %d, want 1", n)
	}
	if elapsed >= 200*time.Millisecond {
		t.Fatalf("elapsed = %v, want < 200ms", elapsed)
	}
	// Plain worked inside ECH mode, so the host left ECH.
	if m := d.Status(dialHost).Mode; m != ModePlain {
		t.Fatalf("Mode = %v, want plain", m)
	}
}

func TestDial_RejectionWithRetryConfigRetriesOnce(t *testing.T) {
	list, key := newECHConfigList(t, "public.test")
	staleList, _ := newECHConfigList(t, "public.test")
	addr, pool := startTLSServer(t, []string{dialHost, "public.test"}, []tls.EncryptedClientHelloKey{key}, okHandler())
	rig := newRig(addr)
	res, hits := failResolver(t)
	d := newTestDialer(t, rig, res, &fakeClock{t: dialT0})
	d.opts.Cache.Put(dialHost, ECHConfig{ConfigList: staleList, TTL: time.Hour})
	forceMode(d, dialHost, ModeECH)

	tc := mustDial(t, d, baseCfg(pool))
	if !tc.ConnectionState().ECHAccepted {
		t.Fatal("retry: ECHAccepted = false")
	}
	if n := rig.dials.Load(); n != 2 {
		t.Fatalf("TCP dials = %d, want 2", n)
	}
	got, fresh, ok := d.opts.Cache.Get(dialHost)
	if !ok || !fresh || !bytes.Equal(got, list) {
		t.Fatalf("cache = (%x, fresh=%v, ok=%v), want the retry list", got, fresh, ok)
	}
	if m := d.Status(dialHost).Mode; m != ModeECH {
		t.Fatalf("Mode = %v, want ech", m)
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("DoH hits = %d, want 0", n)
	}
}

func TestDial_ECHFailuresCooldownThenPlain(t *testing.T) {
	list, _ := newECHConfigList(t, "public.test")
	noECHAddr, pool := startTLSServer(t, []string{dialHost, "public.test"}, nil, okHandler())
	filterAddr, _ := startFilterListener(t)
	rig := newRig(filterAddr)
	res, hits := failResolver(t)
	clock := &fakeClock{t: dialT0}
	d := newTestDialer(t, rig, res, clock)
	forceMode(d, dialHost, ModeECH)

	for i := 1; i <= 3; i++ {
		// ECH attempt → server without ECH keys (rejection, empty retry
		// list); plain fallback → the filter, so the host stays in ECH.
		d.opts.Cache.Put(dialHost, ECHConfig{ConfigList: list, TTL: time.Hour})
		rig.setTarget(noECHAddr)
		rig.thenTarget(filterAddr)
		before := rig.dials.Load()
		if _, err := dialTLS(t, d, baseCfg(pool), nil); !IsFilterSignature(err) {
			t.Fatalf("dial %d: err = %v, want filter signature", i, err)
		}
		if n := rig.dials.Load() - before; n != 2 {
			t.Fatalf("dial %d: TCP dials = %d, want 2 (ech + plain)", i, n)
		}
		if _, _, ok := d.opts.Cache.Get(dialHost); ok {
			t.Fatalf("dial %d: rejection with empty retry list did not delete the cached config", i)
		}
		if i < 3 {
			if m := rawMode(d, dialHost, clock.Now()); m != ModeECH {
				t.Fatalf("dial %d: mode = %v, want ech", i, m)
			}
		}
	}
	if m := rawMode(d, dialHost, clock.Now()); m != ModeCooldown {
		t.Fatalf("mode after 3 ECH failures = %v, want cooldown", m)
	}
	if st := d.Status(dialHost); !st.InCooldown || st.ECHActive {
		t.Fatalf("Status = %+v, want InCooldown", st)
	}

	d.opts.Cache.Put(dialHost, ECHConfig{ConfigList: list, TTL: time.Hour})
	rig.setTarget(filterAddr)
	before := rig.dials.Load()
	if _, err := dialTLS(t, d, baseCfg(pool), nil); !IsFilterSignature(err) {
		t.Fatalf("cooldown dial: err = %v, want filter signature", err)
	}
	if n := rig.dials.Load() - before; n != 1 {
		t.Fatalf("cooldown dial made %d TCP dials, want 1", n)
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("DoH hits = %d, want 0", n)
	}
}

func TestDial_FetchFailuresCooldown(t *testing.T) {
	filterAddr, _ := startFilterListener(t)
	_, pool := startTLSServer(t, []string{dialHost}, nil, okHandler())
	rig := newRig(filterAddr)

	// The resolver holds each request until the test releases it, so a burst
	// of dials happens while one fetch is in flight; it then answers with no
	// ech= parameter.
	release := make(chan struct{})
	hits := new(atomic.Int32)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		_, _ = w.Write([]byte(`{"Status":0,"Answer":[]}`))
	}))
	t.Cleanup(srv.Close)
	clock := &fakeClock{t: dialT0}
	d := newTestDialer(t, rig, NewResolver(srv.Client(), srv.URL), clock)
	forceMode(d, dialHost, ModeECH)

	failures := func() int {
		d.mu.Lock()
		defer d.mu.Unlock()
		return d.state(dialHost).echFailures
	}
	for i := 1; i <= 3; i++ {
		// A burst of cache-miss dials while the fetch is in flight: each
		// falls through to plain (1 TCP dial) and none counts as a failure.
		for b := 0; b < 3; b++ {
			before := rig.dials.Load()
			if _, err := dialTLS(t, d, baseCfg(pool), nil); !IsFilterSignature(err) {
				t.Fatalf("round %d dial %d: err = %v, want filter signature", i, b, err)
			}
			if n := rig.dials.Load() - before; n != 1 {
				t.Fatalf("round %d dial %d: TCP dials = %d, want 1 (cache miss → plain only)", i, b, n)
			}
		}
		if n := failures(); n != i-1 {
			t.Fatalf("round %d: echFailures before the fetch failed = %d, want %d", i, n, i-1)
		}
		if m := rawMode(d, dialHost, clock.Now()); m != ModeECH {
			t.Fatalf("round %d: mode before the fetch failed = %v, want ech", i, m)
		}
		select {
		case release <- struct{}{}:
		case <-t.Context().Done():
			t.Fatalf("round %d: fetch never reached the resolver", i)
		}
		waitFetchIdle(t, d, dialHost)
		want := ModeECH
		if i == 3 {
			want = ModeCooldown
		}
		if m := rawMode(d, dialHost, clock.Now()); m != want {
			t.Fatalf("after round %d: mode = %v, want %v", i, m, want)
		}
	}
	if n := hits.Load(); n != 3 {
		t.Fatalf("DoH hits = %d, want 3 (one deduped fetch per round)", n)
	}
}

func TestDial_KillSwitchForcesPlain(t *testing.T) {
	list, key := newECHConfigList(t, "public.test")
	addr, pool := startTLSServer(t, []string{dialHost, "public.test"}, []tls.EncryptedClientHelloKey{key}, okHandler())
	rig := newRig(addr)
	d := newTestDialer(t, rig, listResolver(t, list), &fakeClock{t: dialT0})
	d.opts.Cache.Put(dialHost, ECHConfig{ConfigList: list, TTL: time.Hour})
	forceMode(d, dialHost, ModeECH)

	if !mustDial(t, d, baseCfg(pool)).ConnectionState().ECHAccepted {
		t.Fatal("enabled: ECHAccepted = false")
	}

	d.SetServerEnabled(false)
	before := rig.dials.Load()
	if mustDial(t, d, baseCfg(pool)).ConnectionState().ECHAccepted {
		t.Fatal("kill switch: ECHAccepted = true")
	}
	if n := rig.dials.Load() - before; n != 1 {
		t.Fatalf("kill switch: TCP dials = %d, want 1", n)
	}
	// A plain success with the switch off leaves ECH mode (see
	// TestDial_KillSwitchPlainSuccessLeavesECH); put the host back to check
	// that re-enabling resumes ECH.
	if st := d.Status(dialHost); st.ECHActive || st.Mode != ModePlain {
		t.Fatalf("kill switch: Status = %+v, want Mode plain, ECHActive false", st)
	}

	d.SetServerEnabled(true)
	forceMode(d, dialHost, ModeECH)
	if !mustDial(t, d, baseCfg(pool)).ConnectionState().ECHAccepted {
		t.Fatal("re-enabled: ECHAccepted = false")
	}
	if !d.Status(dialHost).ECHActive {
		t.Fatal("re-enabled: ECHActive = false")
	}
}

// Ruling (#8869 final review): a plain success while ECH is switched off
// (server kill switch or local opt-out) is still a plain success, so a host in
// ModeECH returns to ModePlain instead of staying in ECH while the switch is off.
func TestDial_KillSwitchPlainSuccessLeavesECH(t *testing.T) {
	for _, tc := range []struct {
		name string
		off  func(d *Dialer)
	}{
		{"server switch off", func(d *Dialer) { d.SetServerEnabled(false) }},
		{"local opt-out", func(d *Dialer) { d.SetLocalEnabled(false) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			addr, pool := startTLSServer(t, []string{dialHost}, nil, okHandler())
			rig := newRig(addr)
			res, hits := failResolver(t)
			clock := &fakeClock{t: dialT0}
			d := newTestDialer(t, rig, res, clock)
			d.ForceModeForTest(dialHost, ModeECH, dialT0)
			tc.off(d)

			clock.Set(dialT0.Add(time.Minute))
			if mustDial(t, d, baseCfg(pool)).ConnectionState().ECHAccepted {
				t.Fatal("ECHAccepted with ECH switched off")
			}
			st := d.Status(dialHost)
			if st.Mode != ModePlain || st.ECHActive {
				t.Fatalf("Status = %+v, want Mode plain, ECHActive false", st)
			}
			if !st.LastPlainSuccessAt.Equal(dialT0.Add(time.Minute)) {
				t.Fatalf("LastPlainSuccessAt = %v, want %v", st.LastPlainSuccessAt, dialT0.Add(time.Minute))
			}
			if n := hits.Load(); n != 0 {
				t.Fatalf("DoH hits = %d, want 0", n)
			}
		})
	}
}

// Every successful plain handshake records its time: the ECH-mode fallback
// and a dial during cooldown included.
func TestDial_PlainSuccessRecordsTime(t *testing.T) {
	addr, pool := startTLSServer(t, []string{dialHost}, nil, okHandler())
	rig := newRig(addr)
	res, _ := noECHResolver(t)
	clock := &fakeClock{t: dialT0}
	d := newTestDialer(t, rig, res, clock)

	// ModeECH with no cached config: ECH is skipped, the plain fallback wins.
	forceMode(d, dialHost, ModeECH)
	clock.Set(dialT0.Add(time.Second))
	mustDial(t, d, baseCfg(pool))
	if st := d.Status(dialHost); !st.LastPlainSuccessAt.Equal(dialT0.Add(time.Second)) || st.Mode != ModePlain {
		t.Fatalf("fallback: Status = %+v, want plain with LastPlainSuccessAt %v", st, dialT0.Add(time.Second))
	}
	waitFetchIdle(t, d, dialHost)

	d.ForceModeForTest(dialHost, ModeCooldown, time.Time{})
	clock.Set(dialT0.Add(2 * time.Second))
	mustDial(t, d, baseCfg(pool))
	if st := d.Status(dialHost); !st.LastPlainSuccessAt.Equal(dialT0.Add(2*time.Second)) || st.Mode != ModeCooldown {
		t.Fatalf("cooldown: Status = %+v, want cooldown with LastPlainSuccessAt %v", st, dialT0.Add(2*time.Second))
	}
}

func TestDial_LocalDisabledNeverEngages(t *testing.T) {
	filterAddr, _ := startFilterListener(t)
	_, pool := startTLSServer(t, []string{dialHost}, nil, okHandler())
	rig := newRig(filterAddr)
	res, hits := failResolver(t)
	clock := &fakeClock{t: dialT0}
	d := New(Options{
		TCPDial:       rig.dial,
		Resolver:      res,
		Cache:         NewCache(""),
		LocalEnabled:  false,
		ServerEnabled: true,
		Now:           clock.Now,
	})
	for _, at := range []time.Time{dialT0, dialT0.Add(2 * time.Minute)} {
		clock.Set(at)
		if _, err := dialTLS(t, d, baseCfg(pool), nil); !IsFilterSignature(err) {
			t.Fatalf("err = %v, want filter signature", err)
		}
	}
	st := d.Status(dialHost)
	if st.Mode != ModePlain || st.ECHActive {
		t.Fatalf("Status = %+v, want plain", st)
	}
	if !st.FilterSignatureSeenAt.Equal(dialT0.Add(2 * time.Minute)) {
		t.Fatalf("FilterSignatureSeenAt = %v, want %v", st.FilterSignatureSeenAt, dialT0.Add(2*time.Minute))
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("DoH hits = %d, want 0", n)
	}
}

func TestDial_OneShotRetriesECHOnFirstSignature(t *testing.T) {
	list, key := newECHConfigList(t, "public.test")
	echAddr, pool := startTLSServer(t, []string{dialHost, "public.test"}, []tls.EncryptedClientHelloKey{key}, okHandler())
	filterAddr, filterHits := startFilterListener(t)
	rig := newRig(filterAddr)
	rig.thenTarget(echAddr)
	d := newTestDialer(t, rig, listResolver(t, list), &fakeClock{t: dialT0})
	d.SetOneShot(true)

	tc := mustDial(t, d, baseCfg(pool))
	if !tc.ConnectionState().ECHAccepted {
		t.Fatal("one-shot retry: ECHAccepted = false")
	}
	if n := filterHits.Load(); n != 1 {
		t.Fatalf("filter hits = %d, want 1", n)
	}
	if n := rig.dials.Load(); n != 2 {
		t.Fatalf("TCP dials = %d, want 2", n)
	}
	if got, _, ok := d.opts.Cache.Get(dialHost); !ok || !bytes.Equal(got, list) {
		t.Fatalf("cache = (%x, ok=%v), want the fetched list", got, ok)
	}
}

func TestDial_OneShotDoHDownFallsThrough(t *testing.T) {
	filterAddr, _ := startFilterListener(t)
	_, pool := startTLSServer(t, []string{dialHost}, nil, okHandler())
	rig := newRig(filterAddr)
	res, hits := hangResolver(t)
	d := newTestDialer(t, rig, res, &fakeClock{t: dialT0})
	d.SetOneShot(true)

	start := time.Now()
	_, err := dialTLS(t, d, baseCfg(pool), nil)
	elapsed := time.Since(start)
	if !IsFilterSignature(err) {
		t.Fatalf("err = %v, want the original filter signature", err)
	}
	if elapsed >= 5500*time.Millisecond || elapsed < 4500*time.Millisecond {
		t.Fatalf("elapsed = %v, want the 5 s one-shot budget (4.5s..5.5s)", elapsed)
	}
	if n := hits.Load(); n != 1 {
		t.Fatalf("DoH hits = %d, want 1", n)
	}
	if n := rig.dials.Load(); n != 1 {
		t.Fatalf("TCP dials = %d, want 1", n)
	}
	if _, _, ok := d.opts.Cache.Get(dialHost); ok {
		t.Fatal("cache populated although DoH was down")
	}
}

func TestDial_BaseConfigNotMutated(t *testing.T) {
	list, key := newECHConfigList(t, "public.test")
	addr, pool := startTLSServer(t, []string{dialHost, "public.test"}, []tls.EncryptedClientHelloKey{key}, okHandler())
	rig := newRig(addr)
	d := newTestDialer(t, rig, listResolver(t, list), &fakeClock{t: dialT0})
	d.opts.Cache.Put(dialHost, ECHConfig{ConfigList: list, TTL: time.Hour})
	forceMode(d, dialHost, ModeECH)

	base := baseCfg(pool)
	tc, err := dialTLS(t, d, base, []string{"h2", "http/1.1"})
	if err != nil {
		t.Fatal(err)
	}
	if !tc.ConnectionState().ECHAccepted {
		t.Fatal("ECHAccepted = false")
	}
	if base.MinVersion != tls.VersionTLS12 {
		t.Errorf("base.MinVersion = %x, want TLS 1.2", base.MinVersion)
	}
	if base.ServerName != "" {
		t.Errorf("base.ServerName = %q, want empty", base.ServerName)
	}
	if base.EncryptedClientHelloConfigList != nil {
		t.Error("base.EncryptedClientHelloConfigList was set")
	}
	if base.NextProtos != nil {
		t.Errorf("base.NextProtos = %v, want nil", base.NextProtos)
	}
}

func TestDial_ConcurrentDialsSameHost(t *testing.T) {
	list, key := newECHConfigList(t, "public.test")
	echAddr, pool := startTLSServer(t, []string{dialHost, "public.test"}, []tls.EncryptedClientHelloKey{key}, okHandler())
	filterAddr, _ := startFilterListener(t)
	rig := newRig(filterAddr)
	clock := &fakeClock{t: dialT0}
	d := newTestDialer(t, rig, listResolver(t, list), clock)

	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	dial := d.DialTLS(baseCfg(pool), []string{"h2", "http/1.1"})

	type result struct {
		conn net.Conn
		err  error
	}
	phase := func(name string) []result {
		const n = 20
		results := make([]result, n)
		var wg sync.WaitGroup
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				c, err := dial(ctx, "tcp", dialAddr)
				results[i] = result{c, err}
				_ = d.Status(dialHost)
				d.SetServerEnabled(true)
				d.SetOneShot(false)
			}(i)
		}
		done := make(chan struct{})
		go func() { wg.Wait(); close(done) }()
		select {
		case <-done:
		case <-ctx.Done():
			t.Fatalf("%s: dials did not finish (deadlock?)", name)
		}
		for _, r := range results {
			if r.conn != nil {
				t.Cleanup(func() { _ = r.conn.Close() })
			}
		}
		return results
	}

	for _, r := range phase("filter@t0") {
		if !IsFilterSignature(r.err) {
			t.Fatalf("filter@t0: err = %v, want filter signature", r.err)
		}
	}
	// The engaging (second) signature is one serial dial, so the next batch
	// runs with a settled mode.
	clock.Set(dialT0.Add(2 * time.Minute))
	if _, err := dialTLS(t, d, baseCfg(pool), nil); !IsFilterSignature(err) {
		t.Fatalf("engaging dial: err = %v, want filter signature", err)
	}
	if m := d.Status(dialHost).Mode; m != ModeECH {
		t.Fatalf("Mode after threshold = %v, want ech", m)
	}
	waitCached(t, d.opts.Cache, dialHost)

	rig.setTarget(echAddr)
	for i, r := range phase("ech") {
		if r.err != nil {
			t.Fatalf("ech dial %d: %v", i, r.err)
		}
		if !r.conn.(*tls.Conn).ConnectionState().ECHAccepted {
			t.Fatalf("ech dial %d: ECHAccepted = false", i)
		}
	}
	if st := d.Status(dialHost); st.Mode != ModeECH || !st.ECHActive {
		t.Fatalf("Status = %+v, want ech active", st)
	}
}

func TestDial_ECHHandshakeDeadlineCountsFailure(t *testing.T) {
	list, _ := newECHConfigList(t, "public.test")
	plainAddr, pool := startTLSServer(t, []string{dialHost}, nil, okHandler())
	filterAddr, _ := startFilterListener(t)
	hole := startBlackhole(t)

	setup := func(t *testing.T, mods ...func(*Options)) (*Dialer, *dialRig) {
		rig := newRig(hole)
		res, _ := failResolver(t)
		d := newTestDialer(t, rig, res, &fakeClock{t: dialT0}, mods...)
		d.opts.Cache.Put(dialHost, ECHConfig{ConfigList: list, TTL: time.Hour})
		forceMode(d, dialHost, ModeECH)
		return d, rig
	}

	t.Run("HandshakeTimeoutCap", func(t *testing.T) {
		// ECH cap = HandshakeTimeout/2 = 500ms; uncapped it would be 1s.
		d, rig := setup(t, func(o *Options) { o.HandshakeTimeout = time.Second })
		rig.thenTarget(plainAddr)
		start := time.Now()
		tc, err := dialTLS(t, d, baseCfg(pool), nil)
		elapsed := time.Since(start)
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		if tc.ConnectionState().ECHAccepted {
			t.Fatal("ECHAccepted through a blackhole")
		}
		if elapsed >= 900*time.Millisecond {
			t.Fatalf("elapsed = %v, want < 900ms (ECH handshake capped at 500ms)", elapsed)
		}
		if m := d.Status(dialHost).Mode; m != ModePlain {
			t.Fatalf("Mode = %v, want plain (plain fallback succeeded)", m)
		}
	})

	t.Run("CallerDeadlineCapCountsFailure", func(t *testing.T) {
		// Default 10s HandshakeTimeout; the caller allows 1s, so ECH gets
		// ~500ms and the plain fallback still runs (and hits the filter, so
		// the host stays in ECH and the failure stays visible).
		d, rig := setup(t)
		rig.thenTarget(filterAddr)
		ctx, cancel := context.WithTimeout(t.Context(), time.Second)
		defer cancel()
		_, err := dialTLSCtx(t, ctx, d, baseCfg(pool), nil)
		if !IsFilterSignature(err) {
			t.Fatalf("err = %v, want the plain fallback's filter signature", err)
		}
		if n := echFailures(d, dialHost); n != 1 {
			t.Fatalf("echFailures = %d, want 1 (deadline expiry counts)", n)
		}
		if m := d.Status(dialHost).Mode; m != ModeECH {
			t.Fatalf("Mode = %v, want ech", m)
		}
		if n := rig.dials.Load(); n != 2 {
			t.Fatalf("TCP dials = %d, want 2", n)
		}
	})

	t.Run("CallerCancelledMidHandshake", func(t *testing.T) {
		d, _ := setup(t)
		ctx, cancel := context.WithCancel(t.Context())
		time.AfterFunc(100*time.Millisecond, cancel)
		if _, err := dialTLSCtx(t, ctx, d, baseCfg(pool), nil); err == nil {
			t.Fatal("dial succeeded after cancel")
		}
		if n := echFailures(d, dialHost); n != 0 {
			t.Fatalf("echFailures = %d, want 0 (caller cancel is exempt)", n)
		}
	})

	t.Run("CallerCancelledBeforeDial", func(t *testing.T) {
		d, _ := setup(t)
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		if _, err := dialTLSCtx(t, ctx, d, baseCfg(pool), nil); err == nil {
			t.Fatal("dial succeeded with a cancelled ctx")
		}
		if n := echFailures(d, dialHost); n != 0 {
			t.Fatalf("echFailures = %d, want 0", n)
		}
	})
}

func TestDial_ECHTCPFailureReturnsImmediately(t *testing.T) {
	list, _ := newECHConfigList(t, "public.test")
	_, pool := startTLSServer(t, []string{dialHost}, nil, okHandler())
	rig := newRig(closedAddr(t))
	res, _ := failResolver(t)
	d := newTestDialer(t, rig, res, &fakeClock{t: dialT0})
	d.opts.Cache.Put(dialHost, ECHConfig{ConfigList: list, TTL: time.Hour})
	forceMode(d, dialHost, ModeECH)

	if _, err := dialTLS(t, d, baseCfg(pool), nil); err == nil {
		t.Fatal("dial to a closed port succeeded")
	}
	if n := rig.dials.Load(); n != 1 {
		t.Fatalf("TCP dials = %d, want 1 (no plain re-connect)", n)
	}
	if n := echFailures(d, dialHost); n != 0 {
		t.Fatalf("echFailures = %d, want 0", n)
	}
	if m := d.Status(dialHost).Mode; m != ModeECH {
		t.Fatalf("Mode = %v, want ech", m)
	}
}

func TestDial_OneShotECHFailsThenPlain(t *testing.T) {
	list, _ := newECHConfigList(t, "public.test")
	noECHAddr, pool := startTLSServer(t, []string{dialHost, "public.test"}, nil, okHandler())
	filterAddr, _ := startFilterListener(t)

	setup := func(t *testing.T, third string) (*Dialer, *dialRig) {
		// Dials: plain → filter; ECH retry → no-ECH server (rejection,
		// empty retry list); extra plain → third.
		rig := newRig(filterAddr)
		rig.thenTarget(noECHAddr, third)
		d := newTestDialer(t, rig, listResolver(t, list), &fakeClock{t: dialT0})
		d.SetOneShot(true)
		return d, rig
	}

	t.Run("PlainSucceeds", func(t *testing.T) {
		d, rig := setup(t, noECHAddr)
		tc, err := dialTLS(t, d, baseCfg(pool), nil)
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		if tc.ConnectionState().ECHAccepted {
			t.Fatal("ECHAccepted on the extra plain attempt")
		}
		if n := rig.dials.Load(); n != 3 {
			t.Fatalf("TCP dials = %d, want 3", n)
		}
	})

	t.Run("PlainFiltered", func(t *testing.T) {
		d, rig := setup(t, filterAddr)
		if _, err := dialTLS(t, d, baseCfg(pool), nil); !IsFilterSignature(err) {
			t.Fatalf("err = %v, want filter signature", err)
		}
		if n := rig.dials.Load(); n != 3 {
			t.Fatalf("TCP dials = %d, want 3", n)
		}
	})
}

func TestDial_PlainPathKeepsTLS12(t *testing.T) {
	addr, pool := startTLSServerWith(t, []string{dialHost}, nil, okHandler(), func(c *tls.Config) {
		c.MinVersion = tls.VersionTLS12
		c.MaxVersion = tls.VersionTLS12
	})
	rig := newRig(addr)
	res, _ := failResolver(t)
	d := newTestDialer(t, rig, res, &fakeClock{t: dialT0})
	tc := mustDial(t, d, baseCfg(pool))
	if v := tc.ConnectionState().Version; v != tls.VersionTLS12 {
		t.Fatalf("Version = %x, want TLS 1.2", v)
	}
}

func TestDial_OneShotSkipsInCooldown(t *testing.T) {
	filterAddr, _ := startFilterListener(t)
	_, pool := startTLSServer(t, []string{dialHost}, nil, okHandler())
	rig := newRig(filterAddr)
	res, hits := failResolver(t)
	clock := &fakeClock{t: dialT0}
	d := newTestDialer(t, rig, res, clock)
	d.SetOneShot(true)
	d.mu.Lock()
	st := d.state(dialHost)
	st.mode = ModeCooldown
	st.cooldownUntil = dialT0.Add(time.Hour)
	d.mu.Unlock()

	if _, err := dialTLS(t, d, baseCfg(pool), nil); !IsFilterSignature(err) {
		t.Fatalf("err = %v, want filter signature", err)
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("DoH hits = %d, want 0", n)
	}
	if n := rig.dials.Load(); n != 1 {
		t.Fatalf("TCP dials = %d, want 1", n)
	}
}

func TestDial_StaleRefreshFailureNotCounted(t *testing.T) {
	list, _ := newECHConfigList(t, "public.test")
	filterAddr, _ := startFilterListener(t)
	_, pool := startTLSServer(t, []string{dialHost}, nil, okHandler())
	rig := newRig(filterAddr)
	res, hits := noECHResolver(t)
	d := newTestDialer(t, rig, res, &fakeClock{t: dialT0})
	// TTL 0: cached but stale, so the dial triggers a refresh that fails.
	d.opts.Cache.Put(dialHost, ECHConfig{ConfigList: list, TTL: 0})
	forceMode(d, dialHost, ModeECH)

	// ECH attempt and plain fallback both hit the filter: one ECH failure.
	if _, err := dialTLS(t, d, baseCfg(pool), nil); !IsFilterSignature(err) {
		t.Fatalf("err = %v, want filter signature", err)
	}
	waitFetchIdle(t, d, dialHost)
	if n := hits.Load(); n != 1 {
		t.Fatalf("DoH hits = %d, want 1", n)
	}
	if n := echFailures(d, dialHost); n != 1 {
		t.Fatalf("echFailures = %d, want 1 (failed refresh of a cached list is not counted)", n)
	}
}

// echActive is wire truth (#8869 lab): true only while the most recent
// successful dial to the host was ECH-accepted, independent of the mode and
// of the switches.
func TestStatus_ECHActiveIsLastSuccessfulDial(t *testing.T) {
	list, key := newECHConfigList(t, "public.test")
	echAddr, pool := startTLSServer(t, []string{dialHost, "public.test"}, []tls.EncryptedClientHelloKey{key}, okHandler())
	hole := startBlackhole(t)
	rig := newRig(echAddr)
	clock := &fakeClock{t: dialT0}
	d := newTestDialer(t, rig, listResolver(t, list), clock, func(o *Options) { o.HandshakeTimeout = time.Second })
	d.opts.Cache.Put(dialHost, ECHConfig{ConfigList: list, TTL: time.Hour})

	// In ech mode, before any accepted handshake: not active.
	d.ForceModeForTest(dialHost, ModeECH, dialT0)
	if st := d.Status(dialHost); st.ECHActive || st.Mode != ModeECH {
		t.Fatalf("ech mode, no dial yet: Status = %+v, want Mode ech, ECHActive false", st)
	}

	// After an accepted ECH dial: active, with the time recorded.
	clock.Set(dialT0.Add(time.Minute))
	if !mustDial(t, d, baseCfg(pool)).ConnectionState().ECHAccepted {
		t.Fatal("ECHAccepted = false")
	}
	st := d.Status(dialHost)
	if !st.ECHActive {
		t.Fatalf("after accepted ECH dial: Status = %+v, want ECHActive", st)
	}
	if !st.LastECHAcceptedAt.Equal(dialT0.Add(time.Minute)) {
		t.Fatalf("LastECHAcceptedAt = %v, want %v", st.LastECHAcceptedAt, dialT0.Add(time.Minute))
	}

	// A later dial whose ECH attempt is blackholed and whose plain fallback
	// succeeds: the wire is plain now.
	clock.Set(dialT0.Add(2 * time.Minute))
	rig.setTarget(hole)
	rig.thenTarget(echAddr)
	tc, err := dialTLS(t, d, baseCfg(pool), nil)
	if err != nil {
		t.Fatalf("fallback dial: %v", err)
	}
	if tc.ConnectionState().ECHAccepted {
		t.Fatal("fallback dial: ECHAccepted = true")
	}
	if st := d.Status(dialHost); st.ECHActive {
		t.Fatalf("after plain-fallback success: Status = %+v, want ECHActive false", st)
	}
}

// A frozen clock must not confuse the order: the last success kind wins even
// when both successes share a timestamp.
func TestStatus_ECHActiveFrozenClockTie(t *testing.T) {
	list, key := newECHConfigList(t, "public.test")
	addr, pool := startTLSServer(t, []string{dialHost, "public.test"}, []tls.EncryptedClientHelloKey{key}, okHandler())
	rig := newRig(addr)
	d := newTestDialer(t, rig, listResolver(t, list), &fakeClock{t: dialT0})
	d.opts.Cache.Put(dialHost, ECHConfig{ConfigList: list, TTL: time.Hour})

	// plain success, then ECH accepted, at the same instant.
	mustDial(t, d, baseCfg(pool))
	forceMode(d, dialHost, ModeECH)
	if !mustDial(t, d, baseCfg(pool)).ConnectionState().ECHAccepted {
		t.Fatal("ECHAccepted = false")
	}
	if !d.Status(dialHost).ECHActive {
		t.Fatal("ECH accepted after plain at the same instant: ECHActive = false")
	}
	// ECH accepted, then plain (switch off) at the same instant.
	d.SetServerEnabled(false)
	mustDial(t, d, baseCfg(pool))
	if d.Status(dialHost).ECHActive {
		t.Fatal("plain after ECH at the same instant: ECHActive = true")
	}
}

// The kill switch (or a local opt-out) does not tear down a live ECH
// connection, so ECHActive stays true until a plain dial succeeds; Disabled
// names which switch is off.
func TestStatus_SwitchOffKeepsECHActiveAndNamesSwitch(t *testing.T) {
	for _, tc := range []struct {
		name string
		off  func(d *Dialer)
		want DisabledBy
	}{
		{"server switch off", func(d *Dialer) { d.SetServerEnabled(false) }, DisabledByServer},
		{"local opt-out", func(d *Dialer) { d.SetLocalEnabled(false) }, DisabledByConfig},
		{"both off: configuration wins", func(d *Dialer) { d.SetServerEnabled(false); d.SetLocalEnabled(false) }, DisabledByConfig},
	} {
		t.Run(tc.name, func(t *testing.T) {
			list, key := newECHConfigList(t, "public.test")
			addr, pool := startTLSServer(t, []string{dialHost, "public.test"}, []tls.EncryptedClientHelloKey{key}, okHandler())
			rig := newRig(addr)
			d := newTestDialer(t, rig, listResolver(t, list), &fakeClock{t: dialT0})
			d.opts.Cache.Put(dialHost, ECHConfig{ConfigList: list, TTL: time.Hour})
			forceMode(d, dialHost, ModeECH)
			if !mustDial(t, d, baseCfg(pool)).ConnectionState().ECHAccepted {
				t.Fatal("ECHAccepted = false")
			}
			if st := d.Status(dialHost); st.Disabled != DisabledByNone {
				t.Fatalf("enabled: Disabled = %v, want none", st.Disabled)
			}
			tc.off(d)
			st := d.Status(dialHost)
			if !st.ECHActive {
				t.Fatalf("switch off, no new dial: Status = %+v, want ECHActive (live ECH conn)", st)
			}
			if st.Disabled != tc.want {
				t.Fatalf("Disabled = %v, want %v", st.Disabled, tc.want)
			}
		})
	}
}

func TestDial_ECHAttemptWithoutAcceptanceIsPlainSuccess(t *testing.T) {
	// A config list that makes crypto/tls skip ECH (nil/empty) yields a plain
	// TLS 1.3 handshake. ECHActive is wire truth, so that success must be
	// recorded as plain (host leaves ECH mode), never as ECH-accepted.
	addr, pool := startTLSServer(t, []string{dialHost}, nil, okHandler())
	rig := newRig(addr)
	res, _ := noECHResolver(t)
	d := newTestDialer(t, rig, res, &fakeClock{t: dialT0})
	forceMode(d, dialHost, ModeECH)

	a := &attempt{d: d, host: dialHost, base: baseCfg(pool), network: "tcp", addr: addr}
	tc, tcpFailed, err := a.echWith(context.Background(), nil, false)
	if err != nil || tcpFailed || tc == nil {
		t.Fatalf("echWith = %v tcpFailed=%v err=%v", tc, tcpFailed, err)
	}
	defer func() { _ = tc.Close() }()
	if tc.ConnectionState().ECHAccepted {
		t.Fatal("server accepted ECH without a config list")
	}
	st := d.Status(dialHost)
	if st.ECHActive || !st.LastECHAcceptedAt.IsZero() {
		t.Fatalf("plain handshake recorded as ECH-accepted: %+v", st)
	}
	if st.LastPlainSuccessAt.IsZero() || st.Mode != ModePlain {
		t.Fatalf("plain success not recorded / host still in ECH: %+v", st)
	}
}
