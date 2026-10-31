package isolation

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
)

// callLog records the order of side effects across the fakes and the
// journal, so tests can assert the apply order.
type callLog struct {
	mu    sync.Mutex
	calls []string
}

func (l *callLog) add(format string, args ...any) {
	l.mu.Lock()
	l.calls = append(l.calls, fmt.Sprintf(format, args...))
	l.mu.Unlock()
}

func (l *callLog) all() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.calls...)
}

func (l *callLog) count(prefix string) int {
	n := 0
	for _, c := range l.all() {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

func (l *callLog) reset() { l.mu.Lock(); l.calls = nil; l.mu.Unlock() }

// fakeIsolator models the kernel's Breeze-owned rule set. It survives a
// simulated agent crash (tests hand the same instance to the next Manager).
type fakeIsolator struct {
	mu        sync.Mutex
	log       *callLog
	cap       Capability
	installed bool
	spec      ResolvedSpec
	digest    Digest
	drops     uint64
	applies   int

	applyErr     error
	releaseErr   error
	verifyErr    error
	ownedErr     error
	stickyOwned  bool   // Owned stays true after Release
	tamperDigest Digest // Verify returns this instead of the installed digest
}

func newFakeIsolator(log *callLog) *fakeIsolator {
	return &fakeIsolator{log: log, cap: Capability{Version: 1, Mechanism: "wfp", Ready: true}}
}

func (f *fakeIsolator) Capability() Capability {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log.add("iso:Capability")
	return f.cap
}

func (f *fakeIsolator) Apply(_ context.Context, spec ResolvedSpec) (Digest, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log.add("iso:Apply %s", spec.IsolationID)
	f.applies++
	if f.applyErr != nil {
		return "", f.applyErr
	}
	f.installed, f.spec, f.digest = true, spec, spec.Digest()
	return f.digest, nil
}

func (f *fakeIsolator) Verify(_ context.Context, spec ResolvedSpec) (Digest, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log.add("iso:Verify")
	if f.verifyErr != nil {
		return "", f.verifyErr
	}
	if f.tamperDigest != "" {
		return f.tamperDigest, nil
	}
	if !f.installed {
		return "", nil
	}
	return f.digest, nil
}

func (f *fakeIsolator) Release(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log.add("iso:Release")
	if f.releaseErr != nil {
		return f.releaseErr
	}
	f.installed, f.spec, f.digest, f.tamperDigest = false, ResolvedSpec{}, "", ""
	return nil
}

func (f *fakeIsolator) Owned(context.Context) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log.add("iso:Owned")
	if f.ownedErr != nil {
		return false, f.ownedErr
	}
	return f.installed || f.stickyOwned, nil
}

func (f *fakeIsolator) Mark(context.Context) (Marker, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log.add("iso:Mark")
	return Marker{Value: f.drops}, nil
}

func (f *fakeIsolator) DropObserved(_ context.Context, since Marker) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log.add("iso:DropObserved")
	return f.drops > since.Value, nil
}

func (f *fakeIsolator) state() (bool, ResolvedSpec, Digest) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.installed, f.spec, f.digest
}

func (f *fakeIsolator) set(fn func(f *fakeIsolator)) { f.mu.Lock(); fn(f); f.mu.Unlock() }

// countDrop is called by the fake dialer when the rule set drops a SYN.
func (f *fakeIsolator) countDrop() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.installed {
		return false
	}
	f.drops++
	return true
}

type expiryArm struct {
	id  string
	gen int
	at  time.Time
}

type fakeScheduler struct {
	mu          sync.Mutex
	log         *callLog
	ready       bool
	readyReason string
	provisional map[string]time.Time
	expiry      []expiryArm
	polling     bool

	armProvisionalErr error
	armExpiryErr      error
	disarmErr         error
}

func newFakeScheduler(log *callLog) *fakeScheduler {
	return &fakeScheduler{log: log, ready: true, provisional: map[string]time.Time{}}
}

func (s *fakeScheduler) ArmProvisional(attemptID string, deadline time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.log.add("sched:ArmProvisional %s", attemptID)
	if s.armProvisionalErr != nil {
		return s.armProvisionalErr
	}
	s.provisional[attemptID] = deadline
	return nil
}

func (s *fakeScheduler) DisarmProvisional(attemptID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.log.add("sched:DisarmProvisional %s", attemptID)
	if s.disarmErr != nil {
		return s.disarmErr
	}
	delete(s.provisional, attemptID)
	return nil
}

func (s *fakeScheduler) ArmExpiry(isolationID string, generation int, at time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.log.add("sched:ArmExpiry %d", generation)
	if s.armExpiryErr != nil {
		return s.armExpiryErr
	}
	s.expiry = append(s.expiry, expiryArm{isolationID, generation, at})
	return nil
}

func (s *fakeScheduler) EnsurePoll() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.log.add("sched:EnsurePoll")
	if s.armExpiryErr != nil {
		return s.armExpiryErr
	}
	s.polling = true
	return nil
}

func (s *fakeScheduler) RemoveAll() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.log.add("sched:RemoveAll")
	s.provisional, s.expiry, s.polling = map[string]time.Time{}, nil, false
	return nil
}

func (s *fakeScheduler) Ready() (bool, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.log.add("sched:Ready")
	return s.ready, s.readyReason
}

func (s *fakeScheduler) armedProvisional() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.provisional)
}

func (s *fakeScheduler) set(fn func(s *fakeScheduler)) { s.mu.Lock(); fn(s); s.mu.Unlock() }

// dialMode is how the fake network answers the negative probe's SYN.
type dialMode int

const (
	dialDrop             dialMode = iota // Breeze rules drop it (counted) — or it connects when no rules are installed
	dialDropUnattributed                 // something else drops it: a timeout, no counter
	dialConnect                          // the connection succeeds
	dialReset                            // RST
	dialLocalDenied                      // a local permission error, attributed
)

type fakeDialer struct {
	mu   sync.Mutex
	log  *callLog
	iso  *fakeIsolator
	mode dialMode
	// ignoreCtx makes a drop block for this long regardless of the context.
	ignoreCtx time.Duration
}

func (d *fakeDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	d.mu.Lock()
	mode, ignore := d.mode, d.ignoreCtx
	d.mu.Unlock()
	d.log.add("dial %s", address)
	timeout := func() (net.Conn, error) {
		if ignore > 0 {
			time.Sleep(ignore)
			return nil, &net.OpError{Op: "dial", Net: network, Err: context.DeadlineExceeded}
		}
		<-ctx.Done()
		return nil, &net.OpError{Op: "dial", Net: network, Err: ctx.Err()}
	}
	switch mode {
	case dialDrop:
		if d.iso.countDrop() {
			return timeout()
		}
		a, b := net.Pipe()
		_ = b.Close()
		return a, nil
	case dialDropUnattributed:
		return timeout()
	case dialConnect:
		a, b := net.Pipe()
		_ = b.Close()
		return a, nil
	case dialReset:
		return nil, &net.OpError{Op: "dial", Net: network, Err: syscall.ECONNREFUSED}
	case dialLocalDenied:
		d.iso.countDrop()
		return nil, &net.OpError{Op: "dial", Net: network, Err: syscall.EPERM}
	}
	return nil, errors.New("bad mode")
}

func (d *fakeDialer) setMode(m dialMode) { d.mu.Lock(); d.mode = m; d.mu.Unlock() }

// fakeVerify is the positive probe.
type fakeVerify struct {
	mu         sync.Mutex
	log        *callLog
	clock      *fakeClock
	err        error
	serverSkew time.Duration
	gate       chan struct{} // when set, each call waits for a receive
	entered    chan struct{} // when set, signalled on entry
}

func (v *fakeVerify) call(ctx context.Context, isolationID string) (time.Time, error) {
	v.mu.Lock()
	err, skew, gate, entered := v.err, v.serverSkew, v.gate, v.entered
	v.mu.Unlock()
	v.log.add("verify %s", isolationID)
	if entered != nil {
		entered <- struct{}{}
	}
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return time.Time{}, ctx.Err()
		}
	}
	if err != nil {
		return time.Time{}, err
	}
	return v.clock.Now().Add(skew), nil
}

func (v *fakeVerify) set(fn func(v *fakeVerify)) { v.mu.Lock(); fn(v); v.mu.Unlock() }

type fakeLookup struct {
	mu    sync.Mutex
	addrs map[string][]netip.Addr
	fail  map[string]bool
	calls int
}

func (l *fakeLookup) lookup(_ context.Context, host string) ([]netip.Addr, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.calls++
	if l.fail[host] {
		return nil, &net.DNSError{Err: "server misbehaving", Name: host, IsTemporary: true}
	}
	a, ok := l.addrs[host]
	if !ok {
		return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
	}
	return append([]netip.Addr(nil), a...), nil
}

func (l *fakeLookup) set(host string, addrs ...string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []netip.Addr
	for _, a := range addrs {
		out = append(out, netip.MustParseAddr(a))
	}
	l.addrs[host] = out
}

func (l *fakeLookup) setFail(host string, fail bool) { l.mu.Lock(); l.fail[host] = fail; l.mu.Unlock() }

const (
	controlHost = "control.example.test"
	relayHost   = "relay.example.test"
	proxyHost   = "proxy.example.test"
)

type harness struct {
	t      *testing.T
	dir    string
	log    *callLog
	iso    *fakeIsolator
	sched  *fakeScheduler
	clock  *fakeClock
	dialer *fakeDialer
	verify *fakeVerify
	lookup *fakeLookup
	proxy  *url.URL
	m      *Manager
	secret []byte
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	log := &callLog{}
	h := &harness{t: t, dir: t.TempDir(), log: log, clock: newFakeClock()}
	h.iso = newFakeIsolator(log)
	h.sched = newFakeScheduler(log)
	h.dialer = &fakeDialer{log: log, iso: h.iso}
	h.verify = &fakeVerify{log: log, clock: h.clock}
	h.lookup = &fakeLookup{addrs: map[string][]netip.Addr{}, fail: map[string]bool{}}
	h.lookup.set(controlHost, "192.0.2.10", "2001:db8::10")
	h.lookup.set(relayHost, "198.51.100.5")
	h.lookup.set(proxyHost, "203.0.113.7")
	h.secret = []byte("0123456789abcdef0123456789abcdef")
	h.m = h.newManager()
	return h
}

// newManager builds a Manager over the harness's persistent fakes, as a
// restarted agent would.
func (h *harness) newManager() *Manager {
	m := NewManager(ManagerDeps{
		Isolator:        h.iso,
		Scheduler:       h.sched,
		DataDir:         h.dir,
		Resolver:        NewResolver(h.lookup.lookup),
		VerifyRoundTrip: h.verify.call,
		Clock:           h.clock,
		Dialer:          h.dialer,
		Proxy: func() (*url.URL, error) {
			return h.proxy, nil
		},
	})
	m.negativeTimeout = 40 * time.Millisecond
	m.probeBudget = 3 * time.Second
	m.onPersist = func(j *journal.Journal) { h.log.add("journal:%s", j.Phase) }
	return m
}

func (h *harness) allow() []AllowEntry {
	return []AllowEntry{
		{Kind: KindHost, Host: controlHost, Proto: ProtoTCP, Ports: []uint16{443}, Scope: ScopeBreeze},
		{Kind: KindHost, Host: relayHost, Proto: ProtoUDPTCP, Ports: []uint16{3478, 5349}, Scope: ScopeBreeze},
		{Kind: KindCIDR, CIDR: "198.51.100.0/24", Proto: ProtoTCP, Ports: []uint16{443}, Scope: ScopeBreeze},
	}
}

func (h *harness) payload(id string, gen int, ttl time.Duration) map[string]any {
	allow := []any{}
	for _, e := range h.allow() {
		entry := map[string]any{"kind": e.Kind, "proto": e.Proto, "scope": e.Scope}
		ports := []any{}
		for _, p := range e.Ports {
			ports = append(ports, float64(p))
		}
		entry["ports"] = ports
		if e.Kind == KindHost {
			entry["host"] = e.Host
		} else {
			entry["cidr"] = e.CIDR
		}
		allow = append(allow, entry)
	}
	return map[string]any{
		"incidentId": "11111111-2222-4333-8444-555555555555",
		"actionId":   "11111111-2222-4333-8444-666666666666",
		"actionType": "network_isolation",
		"parameters": map[string]any{
			"isolationId":    id,
			"generation":     float64(gen),
			"expiresAt":      h.clock.Now().Add(ttl).UTC().Format(time.RFC3339Nano),
			"deadManSeconds": float64(0),
			"remoteRelay":    true,
			"allow":          allow,
		},
		"breakGlassSecret": base64.StdEncoding.EncodeToString(h.secret),
	}
}

func (h *harness) isolate(id string, gen int) CommandOutcome {
	h.t.Helper()
	return h.m.HandleIsolate(context.Background(), h.payload(id, gen, 72*time.Hour))
}

func (h *harness) mustIsolate(id string, gen int) {
	h.t.Helper()
	out := h.isolate(id, gen)
	if out.Failed() || out.Result == nil || out.Result.State != StateVerified {
		h.t.Fatalf("isolate %s gen %d: %+v (result %+v)", id, gen, out, out.Result)
	}
}

func (h *harness) journal() *journal.Journal {
	h.t.Helper()
	j, err := journal.Load(filepath.Join(h.dir, journal.FileName))
	if err != nil {
		h.t.Fatalf("load journal: %v", err)
	}
	return j
}

func (h *harness) desired(id string, gen int, desired string, ttl time.Duration, withSecret bool) *DesiredBlock {
	d := &Desired{Spec: Spec{IsolationID: id, Generation: gen, ExpiresAt: h.clock.Now().Add(ttl), RemoteRelay: true}, Desired: desired}
	if desired == DesiredIsolated {
		d.Allow = h.allow()
		if withSecret {
			d.BreakGlassSecret = h.secret
		}
	}
	return &DesiredBlock{NetworkIsolation: d}
}

func eventTypes(j *journal.Journal) []string {
	var out []string
	for _, e := range j.Events {
		out = append(out, e.Type)
	}
	return out
}

func containsStr(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
