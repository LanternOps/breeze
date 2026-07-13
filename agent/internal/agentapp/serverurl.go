package agentapp

import "sync/atomic"

// serverURLProvider is a late-bound func() string for the AGENT process's log
// shipper (#2463).
//
// Why late binding is needed at all: the shipper must be initialized early in
// startAgent, BEFORE the heartbeat is constructed, because several one-shot
// startup diagnostics are logged in between and must reach agent_logs — the
// systemd unit-reconcile failure reporter (#1201), the ProgramData ACL drift
// warning (#1481), and any mTLS renewal failure. But only the heartbeat knows
// the CURRENT server URL after a backup-server-URL promotion (#2323), and it
// only exposes it through hb.ServerURL(), which reads under the heartbeat's
// mutex.
//
// So the provider is seeded with the startup config value and re-pointed at
// hb.ServerURL as soon as the heartbeat exists. Bind() is called before
// hb.Start(), i.e. before any promotion can possibly happen, so no window is
// left where a promotion could be missed.
//
// The seeded value is a by-value copy of cfg.ServerURL on purpose: it is only
// ever returned before the heartbeat exists, when no promotion can have
// occurred, and it must NOT be a live read of cfg.ServerURL — promotion writes
// that field under the heartbeat's mutex, so reading it from the shipper's
// goroutine would be a data race.
type serverURLProvider struct {
	startupURL string                        // immutable; the pre-heartbeat value
	live       atomic.Pointer[func() string] // set once, by Bind
}

// newServerURLProvider seeds the provider with the URL known at startup.
func newServerURLProvider(startupURL string) *serverURLProvider {
	return &serverURLProvider{startupURL: startupURL}
}

// Bind re-points the provider at the heartbeat's promoted-URL getter. Call it
// before starting the heartbeat.
//
// A nil fn is ignored rather than stored: storing it would panic the shipper's
// goroutine on the next flush (it has no recover()), and there is no
// legitimate caller — do not read this guard as license to pass nil.
func (p *serverURLProvider) Bind(fn func() string) {
	if fn == nil {
		return
	}
	p.live.Store(&fn)
}

// Get is the func() string handed to logging.ShipperConfig.ServerURL. It is
// called from the shipper's own goroutine on every flush, hence the atomic.
func (p *serverURLProvider) Get() string {
	if fn := p.live.Load(); fn != nil {
		return (*fn)()
	}
	return p.startupURL
}
