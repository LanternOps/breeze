package ech

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

const (
	defaultHandshakeTimeout = 10 * time.Second
	asyncFetchTimeout       = 10 * time.Second
	oneShotFetchTimeout     = 5 * time.Second
	retryConfigTTL          = 5 * time.Minute
)

// errNoCachedConfig marks an ECH attempt skipped because no config is cached.
var errNoCachedConfig = errors.New("ech: no cached config")

// Options configures a Dialer. Zero values select the documented defaults.
type Options struct {
	// TCPDial opens the TCP connection. nil uses
	// net.Dialer{Timeout: 15s, KeepAlive: 30s}.
	TCPDial func(ctx context.Context, network, addr string) (net.Conn, error)
	// Resolver fetches ECH configs. nil uses NewResolver(nil).
	Resolver *Resolver
	// Cache holds fetched configs. nil uses an in-memory cache.
	Cache *Cache
	// LocalEnabled is the operator config key `ech`.
	LocalEnabled bool
	// ServerEnabled is the server kill switch (`ech_server_enabled`).
	ServerEnabled bool
	// Now is the clock for the per-host state machine. nil uses time.Now.
	Now func() time.Time
	// HandshakeTimeout bounds each TLS handshake. 0 uses 10 s.
	HandshakeTimeout time.Duration
}

// Dialer makes TLS connections plain-first, switching a host to Encrypted
// Client Hello only after repeated filter signatures, and falling back to a
// plain attempt within the same dial whenever ECH cannot be used.
type Dialer struct {
	opts Options

	localEnabled  atomic.Bool
	serverEnabled atomic.Bool
	oneShot       atomic.Bool

	// mu guards states, fetching and warned. It is never held across a
	// network call or cache I/O.
	mu       sync.Mutex
	states   map[string]*hostState
	fetching map[string]bool
	warned   map[string]bool
}

// HostStatus is a snapshot of one host's ECH state for health reporting.
type HostStatus struct {
	Mode                  Mode
	ECHActive             bool
	FilterSignatureSeenAt time.Time
	InCooldown            bool
}

// New builds a Dialer from opts, filling defaults.
func New(opts Options) *Dialer {
	if opts.TCPDial == nil {
		nd := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
		opts.TCPDial = nd.DialContext
	}
	if opts.Resolver == nil {
		opts.Resolver = NewResolver(nil)
	}
	if opts.Cache == nil {
		opts.Cache = NewCache("")
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.HandshakeTimeout <= 0 {
		opts.HandshakeTimeout = defaultHandshakeTimeout
	}
	d := &Dialer{
		opts:     opts,
		states:   map[string]*hostState{},
		fetching: map[string]bool{},
		warned:   map[string]bool{},
	}
	d.localEnabled.Store(opts.LocalEnabled)
	d.serverEnabled.Store(opts.ServerEnabled)
	return d
}

// SetLocalEnabled updates the operator `ech` setting.
func (d *Dialer) SetLocalEnabled(enabled bool) { d.localEnabled.Store(enabled) }

// SetServerEnabled updates the server kill switch. It never tears down live
// connections; it only affects subsequent dials.
func (d *Dialer) SetServerEnabled(enabled bool) { d.serverEnabled.Store(enabled) }

// SetOneShot makes the first filter signature trigger a synchronous config
// fetch (5 s budget) and one ECH retry within the same dial.
func (d *Dialer) SetOneShot(enabled bool) { d.oneShot.Store(enabled) }

func (d *Dialer) enabled() bool {
	return d.localEnabled.Load() && d.serverEnabled.Load()
}

// state returns host's state, creating it. Caller holds d.mu.
func (d *Dialer) state(host string) *hostState {
	st, ok := d.states[host]
	if !ok {
		st = newHostState()
		d.states[host] = st
	}
	return st
}

// update runs fn on host's state under d.mu and logs any mode transition
// after unlocking. fn returns true to request the once-per-streak filter
// warning. Leaving cooldown, or any plain success (endStreak), clears the
// warning latch.
func (d *Dialer) update(host string, fn func(st *hostState) (warn bool)) Mode {
	d.mu.Lock()
	st := d.state(host)
	from := st.mode
	warn := fn(st)
	to := st.mode
	if from == ModeCooldown && to == ModePlain {
		delete(d.warned, host)
	}
	d.mu.Unlock()
	logTransition(host, from, to)
	if warn {
		log.Warn("control plane answered the TLS handshake with plaintext HTTP; a network security filter is likely intercepting this host", "host", host)
	}
	return to
}

func logTransition(host string, from, to Mode) {
	if from != to {
		log.Info("ech mode changed", "host", host, "from", from.String(), "to", to.String())
	}
}

// Status reports host's ECH state. A host never dialed reports the zero
// HostStatus (ModePlain).
func (d *Dialer) Status(host string) HostStatus {
	now := d.opts.Now()
	d.mu.Lock()
	st, ok := d.states[host]
	if !ok {
		d.mu.Unlock()
		return HostStatus{}
	}
	from := st.mode
	mode := st.Mode(now)
	if from == ModeCooldown && mode == ModePlain {
		delete(d.warned, host)
	}
	seen := st.LastSignatureAt()
	d.mu.Unlock()
	logTransition(host, from, mode)
	return HostStatus{
		Mode:                  mode,
		ECHActive:             mode == ModeECH && d.enabled(),
		FilterSignatureSeenAt: seen,
		InCooldown:            mode == ModeCooldown,
	}
}

// DialTLS returns a closure for http.Transport.DialTLSContext or
// websocket.Dialer.NetDialTLSContext. base may be nil and is never mutated;
// every attempt clones it. The returned net.Conn is a *tls.Conn.
//
// Flow: in ECH mode (and enabled) try ECH once (with at most one retry on a
// server-supplied retry config); if that fails for any reason, make one plain
// attempt and return its result. Otherwise make a plain attempt; on a filter
// signature with one-shot enabled, fetch a config synchronously and try ECH
// once, falling back to one more plain attempt. No path loops.
func (d *Dialer) DialTLS(base *tls.Config, nextProtos []string) func(ctx context.Context, network, addr string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, _, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		a := attempt{d: d, base: base, nextProtos: nextProtos, network: network, addr: addr, host: host}

		mode := d.update(host, func(st *hostState) bool { st.Mode(d.opts.Now()); return false })
		if mode == ModeECH && d.enabled() {
			tc, err := a.ech(ctx, true)
			if err == nil {
				return tc, nil
			}
			return a.plainFallback(ctx)
		}
		return a.plainInitial(ctx)
	}
}

// attempt carries one closure call's parameters.
type attempt struct {
	d          *Dialer
	base       *tls.Config
	nextProtos []string
	network    string
	addr       string
	host       string
}

func (a *attempt) config() *tls.Config {
	var cfg *tls.Config
	if a.base == nil {
		cfg = &tls.Config{}
	} else {
		cfg = a.base.Clone()
	}
	cfg.ServerName = a.host
	cfg.NextProtos = a.nextProtos
	return cfg
}

// handshake dials TCP and runs the TLS handshake under HandshakeTimeout.
// tcpFailed reports that the TCP dial itself failed. On any handshake error
// the TCP connection is closed.
func (a *attempt) handshake(ctx context.Context, cfg *tls.Config) (tc *tls.Conn, tcpFailed bool, err error) {
	raw, err := a.d.opts.TCPDial(ctx, a.network, a.addr)
	if err != nil {
		return nil, true, err
	}
	tc = tls.Client(raw, cfg)
	hctx, cancel := context.WithTimeout(ctx, a.d.opts.HandshakeTimeout)
	defer cancel()
	if err := tc.HandshakeContext(hctx); err != nil {
		_ = raw.Close()
		return nil, false, err
	}
	return tc, false, nil
}

// plainInitial is the default path: exactly today's dial. A filter signature
// is recorded; with one-shot it leads to one synchronous fetch and one ECH try.
func (a *attempt) plainInitial(ctx context.Context) (net.Conn, error) {
	tc, _, err := a.handshake(ctx, a.config())
	if err == nil {
		a.notePlainSuccess("plain")
		return tc, nil
	}
	log.Debug("ech dial attempt", "host", a.host, "attempt", "plain", "error", err.Error())
	if !IsFilterSignature(err) {
		return nil, err
	}
	engaged := a.noteSignature()
	if engaged {
		a.d.fetchAsync(a.host)
	}
	if !a.d.oneShot.Load() || !a.d.enabled() {
		return nil, err
	}
	if _, _, ok := a.d.opts.Cache.Get(a.host); !ok {
		if ferr := a.d.fetchSync(ctx, a.host); ferr != nil {
			log.Debug("ech one-shot config fetch failed", "host", a.host, "error", ferr.Error())
			return nil, err
		}
	}
	if etc, eerr := a.ech(ctx, true); eerr == nil {
		return etc, nil
	}
	return a.plainFallback(ctx)
}

// plainFallback is the single plain attempt after ECH could not be used. It
// never re-enters ECH and does not leave ECH mode on success: only the
// consecutive-failure limit (cooldown) does that.
func (a *attempt) plainFallback(ctx context.Context) (net.Conn, error) {
	tc, _, err := a.handshake(ctx, a.config())
	if err == nil {
		a.notePlainSuccess("plain-fallback")
		return tc, nil
	}
	log.Debug("ech dial attempt", "host", a.host, "attempt", "plain-fallback", "error", err.Error())
	if IsFilterSignature(err) {
		if a.noteSignature() {
			a.d.fetchAsync(a.host)
		}
	}
	return nil, err
}

// ech makes one ECH attempt with the cached config; allowRetry permits one
// further attempt with a server-supplied retry config. A nil error means
// ECH was accepted.
func (a *attempt) ech(ctx context.Context, allowRetry bool) (*tls.Conn, error) {
	d := a.d
	list, fresh, ok := d.opts.Cache.Get(a.host)
	if !ok {
		d.fetchAsync(a.host)
		a.noteECHFailure()
		log.Debug("ech dial attempt", "host", a.host, "attempt", "ech", "error", errNoCachedConfig.Error())
		return nil, errNoCachedConfig
	}
	if !fresh {
		d.fetchAsync(a.host)
	}
	cfg := a.config()
	cfg.MinVersion = tls.VersionTLS13
	cfg.EncryptedClientHelloConfigList = list
	tc, tcpFailed, err := a.handshake(ctx, cfg)
	if err == nil {
		d.update(a.host, func(st *hostState) bool { st.NoteECHSuccess(); return false })
		log.Debug("ech dial attempt", "host", a.host, "attempt", "ech", "result", "accepted")
		return tc, nil
	}
	log.Debug("ech dial attempt", "host", a.host, "attempt", "ech", "error", err.Error())
	var rej *tls.ECHRejectionError
	if errors.As(err, &rej) {
		if len(rej.RetryConfigList) > 0 && allowRetry {
			d.opts.Cache.Put(a.host, ECHConfig{ConfigList: rej.RetryConfigList, TTL: retryConfigTTL})
			return a.ech(ctx, false)
		}
		if len(rej.RetryConfigList) == 0 {
			d.opts.Cache.Delete(a.host)
		}
	}
	// A failed TCP connect or a cancelled caller is not evidence against
	// ECH, so it does not count toward cooldown.
	if !tcpFailed && ctx.Err() == nil {
		a.noteECHFailure()
	}
	return nil, err
}

func (a *attempt) noteECHFailure() {
	now := a.d.opts.Now()
	a.d.update(a.host, func(st *hostState) bool { st.NoteECHFailure(now); return false })
}

// noteSignature records a filter signature. Engagement only happens while
// ECH is enabled; when disabled only the timestamp is kept so health can
// still report the filter. It returns true on the transition into ModeECH.
func (a *attempt) noteSignature() (engaged bool) {
	now := a.d.opts.Now()
	enabled := a.d.enabled()
	a.d.update(a.host, func(st *hostState) bool {
		if enabled {
			engaged = st.NoteSignature(now)
		} else {
			st.lastSignatureAt = now
		}
		if a.d.warned[a.host] {
			return false
		}
		a.d.warned[a.host] = true
		return true
	})
	return engaged
}

// notePlainSuccess ends a signature streak for logging purposes.
func (a *attempt) notePlainSuccess(kind string) {
	a.d.mu.Lock()
	delete(a.d.warned, a.host)
	a.d.mu.Unlock()
	log.Debug("ech dial attempt", "host", a.host, "attempt", kind, "result", "ok")
}

// fetchAsync refreshes host's config in the background, at most one fetch
// per host at a time. It never blocks the caller.
func (d *Dialer) fetchAsync(host string) {
	d.mu.Lock()
	if d.fetching[host] {
		d.mu.Unlock()
		return
	}
	d.fetching[host] = true
	d.mu.Unlock()
	go func() {
		defer func() {
			d.mu.Lock()
			delete(d.fetching, host)
			d.mu.Unlock()
		}()
		ctx, cancel := context.WithTimeout(context.Background(), asyncFetchTimeout)
		defer cancel()
		cfg, err := d.opts.Resolver.Lookup(ctx, host)
		if err != nil {
			log.Debug("ech config fetch failed", "host", host, "error", err.Error())
			return
		}
		d.opts.Cache.Put(host, cfg)
	}()
}

// fetchSync fetches and caches host's config within the one-shot budget.
func (d *Dialer) fetchSync(ctx context.Context, host string) error {
	fctx, cancel := context.WithTimeout(ctx, oneShotFetchTimeout)
	defer cancel()
	cfg, err := d.opts.Resolver.Lookup(fctx, host)
	if err != nil {
		return err
	}
	d.opts.Cache.Put(host, cfg)
	return nil
}
