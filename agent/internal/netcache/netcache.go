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
)

type Cache struct {
	path    string
	mu      sync.Mutex
	entries map[string][]string
	lookup  func(ctx context.Context, host string) ([]string, error)
	dial    func(ctx context.Context, network, addr string) (net.Conn, error)
}

func New(path string) *Cache {
	d := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
	c := &Cache{
		path:    path,
		entries: map[string][]string{},
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

// Shared is the process-wide cache, persisted in the agent data dir and thus
// shared (last-writer-wins, atomic replace) with the watchdog process.
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
			return conn, nil
		}
		return nil, dialErr
	}

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
		return nil, lookupErr
	}
	return conn, nil
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
	defer c.mu.Unlock()

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
		return
	}

	c.entries[host] = append([]string(nil), ips...)
	snapshot := make(map[string][]string, len(c.entries))
	for key, value := range c.entries {
		snapshot[key] = append([]string(nil), value...)
	}
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

// persist atomically replaces the cache file (tmp + rename). Corruption from
// a crash mid-write leaves either the old or the new file, both valid.
func (c *Cache) persist(entries map[string][]string) {
	data, err := json.Marshal(entries)
	if err != nil {
		return
	}
	tmp, err := os.CreateTemp(filepath.Dir(c.path), filepath.Base(c.path)+".partial-*")
	if err != nil {
		return
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)

	if err := tmp.Chmod(0o644); err != nil {
		_ = tmp.Close()
		return
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return
	}
	if err := tmp.Close(); err != nil {
		return
	}
	_ = os.Rename(tmpPath, c.path)
}
