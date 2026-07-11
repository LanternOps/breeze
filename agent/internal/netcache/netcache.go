// Package netcache provides a last-known-good DNS→IP cache at the TCP dial
// layer (#2288). The normal path hands the ORIGINAL hostname to the stock
// dialer, so Go's resolver behavior — including dual-stack Happy Eyeballs
// racing — is fully preserved; the cache is consulted ONLY when that dial
// fails with a *net.DNSError, so a pure DNS outage doesn't sever the control
// plane (or trigger a false backup-URL failover). TLS is untouched:
// http.Transport / websocket.Dialer still verify certificates against the URL
// hostname, so a stale or hijacked cached IP fails the handshake — the cache
// changes only where we dial, never what we trust.
package netcache

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("netcache")

// fallbackPerIPTimeout caps each cached-IP dial attempt so a short list of
// stale addresses cannot serially exhaust the caller's whole context.
const fallbackPerIPTimeout = 5 * time.Second

type Cache struct {
	path    string
	mu      sync.Mutex
	entries map[string][]string
	lookup  func(ctx context.Context, host string) ([]string, error)
	dial    func(ctx context.Context, network, addr string) (net.Conn, error)
	// fallbackActive tracks hosts currently surviving on cached IPs so the
	// outage is logged once per streak, not once per dial. Guarded by mu.
	fallbackActive map[string]bool
	// persistFailLogged latches the first persist failure so a permanently
	// read-only data dir is visible without per-dial spam. Guarded by mu.
	persistFailLogged bool
	// persistMu serializes snapshot+write so an earlier writer's stale
	// snapshot can never land after (and erase) a later writer's entry.
	persistMu sync.Mutex
}

func New(path string) *Cache {
	d := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
	c := &Cache{
		path:           path,
		entries:        map[string][]string{},
		fallbackActive: map[string]bool{},
		lookup: func(ctx context.Context, host string) ([]string, error) {
			return net.DefaultResolver.LookupHost(ctx, host)
		},
		dial: d.DialContext,
	}
	c.load()
	return c
}

var (
	sharedOnce sync.Once
	shared     *Cache
)

// Shared is the process-wide cache. The file in the agent data dir is
// written by both the agent and watchdog processes (last-writer-wins atomic
// replace); each process reads it only at startup.
func Shared() *Cache {
	sharedOnce.Do(func() {
		shared = New(filepath.Join(config.GetDataDir(), "dns-cache.json"))
	})
	return shared
}

func (c *Cache) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil || net.ParseIP(host) != nil {
		return c.dial(ctx, network, addr)
	}

	// Normal path: dial the HOSTNAME so the stock dialer keeps its resolver
	// semantics (Happy Eyeballs dual-stack racing, address ordering). We only
	// intercept the outcome.
	conn, dialErr := c.dial(ctx, network, addr)
	if dialErr == nil {
		c.refresh(ctx, host)
		c.noteDNSRecovered(host)
		return conn, nil
	}

	// Cache is consulted ONLY for resolution failures; connect errors (and
	// anything else) surface untouched.
	var dnsErr *net.DNSError
	if !errors.As(dialErr, &dnsErr) {
		return nil, dialErr
	}

	cached := c.cachedIPs(host)
	if len(cached) == 0 {
		return nil, dialErr
	}
	conn, fallbackErr := c.dialFirst(ctx, network, cached, port)
	if fallbackErr != nil {
		// Surface the ORIGINAL DNS error; the fallback error is logged as
		// the only evidence distinguishing "stale cache" from "server down".
		log.Debug("cached-IP dial also failed", "host", host, "dialError", fallbackErr.Error())
		return nil, dialErr
	}
	c.noteFallbackEngaged(host, dialErr)
	return conn, nil
}

// refresh best-effort resolves host and stores the answer as the new
// last-known-good IP set. Called only after a successful hostname dial, so
// resolution is expected to work; any failure is skipped silently (the cache
// simply keeps its previous entry).
func (c *Cache) refresh(ctx context.Context, host string) {
	lookupCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	ips, err := c.lookup(lookupCtx, host)
	if err != nil || len(ips) == 0 {
		return
	}
	c.store(host, ips)
}

// noteFallbackEngaged warn-logs once per outage streak that this host is
// surviving on cached IPs — essential forensic context during a DNS outage.
func (c *Cache) noteFallbackEngaged(host string, dnsErr error) {
	c.mu.Lock()
	first := !c.fallbackActive[host]
	c.fallbackActive[host] = true
	c.mu.Unlock()
	if first {
		log.Warn("DNS resolution failed; using last-known-good cached IP", "host", host, "error", dnsErr.Error())
	}
}

// noteDNSRecovered closes an active fallback streak once fresh DNS works.
func (c *Cache) noteDNSRecovered(host string) {
	c.mu.Lock()
	wasActive := c.fallbackActive[host]
	delete(c.fallbackActive, host)
	c.mu.Unlock()
	if wasActive {
		log.Info("DNS resolution recovered", "host", host)
	}
}

// dialFirst tries the cached IPs in order, capping each attempt so a stale
// list cannot serially exhaust the caller's context (this path only runs
// during a DNS outage; the normal path keeps the dialer's own racing).
func (c *Cache) dialFirst(ctx context.Context, network string, ips []string, port string) (net.Conn, error) {
	var lastErr error
	for _, ip := range ips {
		attemptCtx, cancel := context.WithTimeout(ctx, fallbackPerIPTimeout)
		conn, err := c.dial(attemptCtx, network, net.JoinHostPort(ip, port))
		cancel()
		if err == nil {
			return conn, nil
		}
		lastErr = err
		if ctx.Err() != nil {
			break
		}
	}
	return nil, lastErr
}

func (c *Cache) cachedIPs(host string) []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.entries[host]...)
}

// store persists host→ips, writing the file only when the (sorted) set
// actually changed.
func (c *Cache) store(host string, ips []string) {
	sorted := append([]string(nil), ips...)
	sort.Strings(sorted)

	c.mu.Lock()

	prev := append([]string(nil), c.entries[host]...)
	sort.Strings(prev)
	changed := len(prev) != len(sorted)
	if !changed {
		for i := range prev {
			if prev[i] != sorted[i] {
				changed = true
				break
			}
		}
	}
	if !changed {
		c.mu.Unlock()
		return
	}

	c.entries[host] = append([]string(nil), ips...)
	// Release before disk I/O — readers (cachedIPs, other DialContext calls)
	// never block on a file write.
	c.mu.Unlock()
	c.persist()
}

func (c *Cache) load() {
	data, err := os.ReadFile(c.path)
	if err != nil {
		return
	}
	var entries map[string][]string
	if json.Unmarshal(data, &entries) == nil && entries != nil {
		c.entries = entries
	}
}

// persist replaces the cache file via tmp+rename — safe against process
// crash mid-write (no fsync: power loss may leave a corrupt file, which
// load() tolerates and ignores). Snapshots are taken UNDER persistMu so
// writes land in update order — an earlier writer's snapshot (taken after a
// later writer's entries update) can never regress the file. Best-effort:
// failures never affect the dial, but the first one is warn-logged (latched)
// so a permanently broken data dir is visible.
func (c *Cache) persist() {
	c.persistMu.Lock()
	c.mu.Lock()
	snapshot := make(map[string][]string, len(c.entries))
	for key, value := range c.entries {
		snapshot[key] = append([]string(nil), value...)
	}
	c.mu.Unlock()
	err := c.persistOnce(snapshot)
	c.persistMu.Unlock()

	c.mu.Lock()
	logIt := err != nil && !c.persistFailLogged
	c.persistFailLogged = err != nil
	c.mu.Unlock()
	if logIt {
		log.Warn("failed to persist DNS cache; last-known-good IPs will not survive a restart", "path", c.path, "error", err.Error())
	}
}

func (c *Cache) persistOnce(entries map[string][]string) error {
	data, err := json.Marshal(entries)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(c.path), filepath.Base(c.path)+".partial-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)

	if err := tmp.Chmod(0o644); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, c.path)
}
