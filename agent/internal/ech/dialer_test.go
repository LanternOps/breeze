package ech

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"fmt"
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
// (always dialAddr) and dials the current target instead; when next is set,
// the target switches to it after one dial.
type dialRig struct {
	target atomic.Pointer[string]
	next   atomic.Pointer[string]
	dials  atomic.Int32
}

func newRig(target string) *dialRig {
	r := &dialRig{}
	r.setTarget(target)
	return r
}

func (r *dialRig) setTarget(addr string)  { r.target.Store(&addr) }
func (r *dialRig) thenTarget(addr string) { r.next.Store(&addr) }

func (r *dialRig) dial(ctx context.Context, network, _ string) (net.Conn, error) {
	r.dials.Add(1)
	target := *r.target.Load()
	if n := r.next.Swap(nil); n != nil {
		r.target.Store(n)
	}
	return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, target)
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

// noECHResolver answers with no HTTPS record, so Lookup returns ErrNoECHConfig.
func noECHResolver(t *testing.T) *Resolver {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"Status":0,"Answer":[]}`))
	}))
	t.Cleanup(srv.Close)
	return NewResolver(srv.Client(), srv.URL)
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

// hangResolver never answers until the request context ends.
func hangResolver(t *testing.T) *Resolver {
	t.Helper()
	done := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-done:
		}
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { close(done) }) // runs before srv.Close (LIFO)
	return NewResolver(srv.Client(), srv.URL)
}

func newTestDialer(t *testing.T, rig *dialRig, res *Resolver, clock *fakeClock) *Dialer {
	t.Helper()
	return New(Options{
		TCPDial:       rig.dial,
		Resolver:      res,
		Cache:         NewCache(""),
		LocalEnabled:  true,
		ServerEnabled: true,
		Now:           clock.Now,
	})
}

func forceMode(d *Dialer, host string, m Mode) {
	d.mu.Lock()
	d.state(host).mode = m
	d.mu.Unlock()
}

func echFailures(d *Dialer, host string) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.state(host).echFailures
}

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})
}

// dialTLS runs one dial through the closure and returns the *tls.Conn.
func dialTLS(t *testing.T, d *Dialer, base *tls.Config, nextProtos []string) (*tls.Conn, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	c, err := d.DialTLS(base, nextProtos)(ctx, "tcp", dialAddr)
	if err != nil {
		if c != nil {
			t.Fatalf("non-nil conn %T returned with error %v", c, err)
		}
		return nil, err
	}
	tc, ok := c.(*tls.Conn)
	if !ok {
		c.Close()
		t.Fatalf("conn is %T, want *tls.Conn", c)
	}
	t.Cleanup(func() { tc.Close() })
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
	resp.Body.Close()

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
	want := HostStatus{Mode: ModeECH, ECHActive: true, FilterSignatureSeenAt: dialT0.Add(2 * time.Minute)}
	if got := d.Status(dialHost); got != want {
		t.Fatalf("Status = %+v, want %+v", got, want)
	}
}

func TestDial_SingleSignatureStaysPlain(t *testing.T) {
	plainAddr, pool := startTLSServer(t, []string{dialHost}, nil, okHandler())
	filterAddr, _ := startFilterListener(t)
	rig := newRig(filterAddr)
	res, hits := failResolver(t)
	d := newTestDialer(t, rig, res, &fakeClock{t: dialT0})

	if _, err := dialTLS(t, d, baseCfg(pool), nil); !IsFilterSignature(err) {
		t.Fatalf("err = %v, want filter signature", err)
	}
	rig.setTarget(plainAddr)
	tc := mustDial(t, d, baseCfg(pool))
	if tc.ConnectionState().ECHAccepted {
		t.Fatal("ECHAccepted after a single signature")
	}
	if got := d.Status(dialHost).Mode; got != ModePlain {
		t.Fatalf("Mode = %v, want plain", got)
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("DoH hits = %d, want 0", n)
	}
}

func TestDial_ECHModeNoConfigFallsBackPlainImmediately(t *testing.T) {
	addr, pool := startTLSServer(t, []string{dialHost}, nil, okHandler())
	rig := newRig(addr)
	d := newTestDialer(t, rig, noECHResolver(t), &fakeClock{t: dialT0})
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
	if n := echFailures(d, dialHost); n != 1 {
		t.Fatalf("echFailures = %d, want 1", n)
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
	addr, pool := startTLSServer(t, []string{dialHost, "public.test"}, nil, okHandler())
	rig := newRig(addr)
	clock := &fakeClock{t: dialT0}
	d := newTestDialer(t, rig, noECHResolver(t), clock)
	d.opts.Cache.Put(dialHost, ECHConfig{ConfigList: list, TTL: time.Hour})
	forceMode(d, dialHost, ModeECH)

	for i := 1; i <= 3; i++ {
		tc := mustDial(t, d, baseCfg(pool))
		if tc.ConnectionState().ECHAccepted {
			t.Fatalf("dial %d: ECHAccepted against a no-ECH server", i)
		}
	}
	d.mu.Lock()
	mode := d.state(dialHost).Mode(clock.Now())
	d.mu.Unlock()
	if mode != ModeCooldown {
		t.Fatalf("mode after 3 ECH failures = %v, want cooldown", mode)
	}
	if st := d.Status(dialHost); !st.InCooldown || st.ECHActive {
		t.Fatalf("Status = %+v, want InCooldown", st)
	}

	before := rig.dials.Load()
	mustDial(t, d, baseCfg(pool))
	if n := rig.dials.Load() - before; n != 1 {
		t.Fatalf("cooldown dial made %d TCP dials, want 1", n)
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
	if st := d.Status(dialHost); st.ECHActive || st.Mode != ModeECH {
		t.Fatalf("kill switch: Status = %+v, want Mode ech, ECHActive false", st)
	}

	d.SetServerEnabled(true)
	if !mustDial(t, d, baseCfg(pool)).ConnectionState().ECHAccepted {
		t.Fatal("re-enabled: ECHAccepted = false")
	}
	if !d.Status(dialHost).ECHActive {
		t.Fatal("re-enabled: ECHActive = false")
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
	d := newTestDialer(t, rig, hangResolver(t), &fakeClock{t: dialT0})
	d.SetOneShot(true)

	start := time.Now()
	_, err := dialTLS(t, d, baseCfg(pool), nil)
	elapsed := time.Since(start)
	if !IsFilterSignature(err) {
		t.Fatalf("err = %v, want the original filter signature", err)
	}
	if elapsed >= 5500*time.Millisecond {
		t.Fatalf("elapsed = %v, want < 5.5s", elapsed)
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
				t.Cleanup(func() { r.conn.Close() })
			}
		}
		return results
	}

	for _, r := range phase("filter@t0") {
		if !IsFilterSignature(r.err) {
			t.Fatalf("filter@t0: err = %v, want filter signature", r.err)
		}
	}
	clock.Set(dialT0.Add(2 * time.Minute))
	for _, r := range phase("filter@t0+2m") {
		if !IsFilterSignature(r.err) {
			t.Fatalf("filter@t0+2m: err = %v, want filter signature", r.err)
		}
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
