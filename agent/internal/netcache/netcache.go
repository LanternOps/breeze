// Package netcache provides a last-known-good DNS→IP cache at the TCP dial
// layer (#2288). Fresh DNS always wins; the cache is consulted ONLY when
// resolution fails with *net.DNSError, so a pure DNS outage doesn't sever the
// control plane (or trigger a false backup-URL failover). TLS is untouched:
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

	ips, lookupErr := c.lookup(ctx, host)
	if lookupErr == nil && len(ips) > 0 {
		conn, dialErr := c.dialFirst(ctx, network, ips, port)
		if dialErr == nil {
			c.store(host, ips)
			c.noteDNSRecovered(host)
			return conn, nil
		}
		return nil, dialErr
	}

	// A lookup that succeeds with zero addresses is intentionally NOT served
	// from the cache: the record was answered (and is empty), not unreachable.
	var dnsErr *net.DNSError
	if lookupErr == nil || !errors.As(lookupErr, &dnsErr) {
		if lookupErr != nil {
			return nil, lookupErr
		}
		return nil, &net.DNSError{Err: "lookup returned no addresses", Name: host}
	}

	cached := c.cachedIPs(host)
	if len(cached) == 0 {
		return nil, lookupErr
	}
	conn, dialErr := c.dialFirst(ctx, network, cached, port)
	if dialErr != nil {
		// Surface the ORIGINAL DNS error; the dial error is logged as the
		// only evidence distinguishing "stale cache" from "server down".
		log.Debug("cached-IP dial also failed", "host", host, "dialError", dialErr.Error())
		return nil, lookupErr
	}
	c.noteFallbackEngaged(host, lookupErr)
	return conn, nil
}

// noteFallbackEngaged warn-logs once per outage streak that this host is
// surviving on cached IPs — essential forensic context during a DNS outage.
func (c *Cache) noteFallbackEngaged(host string, lookupErr error) {
	c.mu.Lock()
	first := !c.fallbackActive[host]
	c.fallbackActive[host] = true
	c.mu.Unlock()
	if first {
		log.Warn("DNS resolution failed; using last-known-good cached IP", "host", host, "error", lookupErr.Error())
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

func (c *Cache) dialFirst(ctx context.Context, network string, ips []string, port string) (net.Conn, error) {
	var lastErr error
	for _, ip := range ips {
		conn, err := c.dial(ctx, network, net.JoinHostPort(ip, port))
		if err == nil {
			return conn, nil
		}
		lastErr = err
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
	snapshot := make(map[string][]string, len(c.entries))
	for key, value := range c.entries {
		snapshot[key] = append([]string(nil), value...)
	}
	// Release before disk I/O — persist works on the snapshot, so readers
	// (cachedIPs, other DialContext calls) never block on a file write.
	c.mu.Unlock()
	c.persist(snapshot)
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
// load() tolerates and ignores). Best-effort: failures never affect the
// dial, but the first one is warn-logged (latched) so a permanently broken
// data dir is visible.
func (c *Cache) persist(entries map[string][]string) {
	err := c.persistOnce(entries)
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
