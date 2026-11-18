package isolation

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"
	"sync"
	"time"
)

// MaxAddrsPerHost bounds the last-known-good address set kept per host.
const MaxAddrsPerHost = 16

// Resolution runs under the machine-wide isolation lock (preflight, refresh,
// re-verify), and a release must never wait behind a hung resolver. Each
// lookup is bounded, and so is the whole call; a host that times out falls
// back to its last-known-good set.
var (
	resolveHostTimeout  = 3 * time.Second
	resolveTotalTimeout = 10 * time.Second
)

// LookupFunc resolves one host name. Production wiring (W1e) passes the
// agent's own resolver path, the one its control-plane dials use.
type LookupFunc func(ctx context.Context, host string) ([]netip.Addr, error)

// Resolver turns allowlist host names into addresses and keeps, per host, a
// bounded last-known-good set (spec §3.4): a fresh answer goes first and the
// previous addresses stay behind it up to MaxAddrsPerHost, and a failed or
// empty lookup returns the previous set. A resolution failure therefore never
// removes a working permit. (netcache only falls back on DNS failure, not on
// a firewall-induced connect failure, so the isolation package keeps its own.)
type Resolver struct {
	lookup LookupFunc
	mu     sync.Mutex
	known  map[string][]netip.Addr
}

// NewResolver returns a Resolver over lookup (net.DefaultResolver when nil).
func NewResolver(lookup LookupFunc) *Resolver {
	if lookup == nil {
		lookup = func(ctx context.Context, host string) ([]netip.Addr, error) {
			return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		}
	}
	return &Resolver{lookup: lookup, known: map[string][]netip.Addr{}}
}

// Seed installs a host's last-known-good set (from the journal, after a
// restart). It never shrinks an existing set.
func (r *Resolver) Seed(host string, addrs []netip.Addr) {
	host = normaliseHost(host)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.known[host] = mergeAddrs(r.known[host], addrs)
}

// Resolve returns addresses for every host. A host with neither a fresh
// answer nor a last-known-good set is missing from the map and named in the
// returned error; the others are still returned.
func (r *Resolver) Resolve(ctx context.Context, hosts []string) (map[string][]netip.Addr, error) {
	out := make(map[string][]netip.Addr, len(hosts))
	var errs []error
	ctx, cancel := context.WithTimeout(ctx, resolveTotalTimeout)
	defer cancel()
	for _, raw := range hosts {
		host := normaliseHost(raw)
		if host == "" {
			errs = append(errs, errors.New("empty host name"))
			continue
		}
		if _, done := out[host]; done {
			continue
		}
		if addr, err := netip.ParseAddr(host); err == nil {
			out[host] = []netip.Addr{addr.Unmap()}
			continue
		}
		var fresh []netip.Addr
		var lookupErr error
		if ctx.Err() != nil {
			lookupErr = ctx.Err()
		} else {
			hctx, hcancel := context.WithTimeout(ctx, resolveHostTimeout)
			fresh, lookupErr = r.lookup(hctx, host)
			hcancel()
		}
		fresh = usable(fresh)

		r.mu.Lock()
		if len(fresh) > 0 {
			r.known[host] = mergeAddrs(fresh, r.known[host])
		}
		set := append([]netip.Addr(nil), r.known[host]...)
		r.mu.Unlock()

		if len(set) == 0 {
			if lookupErr == nil {
				lookupErr = errors.New("no usable addresses")
			}
			errs = append(errs, fmt.Errorf("resolve %s: %w", host, lookupErr))
			continue
		}
		out[host] = set
	}
	return out, errors.Join(errs...)
}

func normaliseHost(h string) string {
	h = strings.TrimSpace(strings.ToLower(h))
	h = strings.TrimSuffix(strings.TrimPrefix(h, "["), "]")
	return strings.TrimSuffix(h, ".")
}

// usable unmaps 4-in-6 addresses and drops unspecified, multicast and
// invalid ones (a sinkholed 0.0.0.0 answer must never become a permit).
func usable(in []netip.Addr) []netip.Addr {
	out := make([]netip.Addr, 0, len(in))
	for _, a := range in {
		a = a.Unmap().WithZone("")
		if !a.IsValid() || a.IsUnspecified() || a.IsMulticast() {
			continue
		}
		out = append(out, a)
	}
	return out
}

// mergeAddrs returns first then rest, deduplicated, capped.
func mergeAddrs(first, rest []netip.Addr) []netip.Addr {
	seen := make(map[netip.Addr]bool, len(first)+len(rest))
	out := make([]netip.Addr, 0, MaxAddrsPerHost)
	for _, list := range [][]netip.Addr{first, rest} {
		for _, a := range list {
			if len(out) == MaxAddrsPerHost {
				return out
			}
			if seen[a] {
				continue
			}
			seen[a] = true
			out = append(out, a)
		}
	}
	return out
}
