package ech

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("ech")

type cacheEntry struct {
	ConfigList []byte    `json:"configList"`
	FetchedAt  time.Time `json:"fetchedAt"`
	TTLSeconds int64     `json:"ttlSeconds"`
}

// Cache holds one ECH config list per host, persisted to disk so the dialer
// can reuse it across restarts. An empty path means in-memory only.
type Cache struct {
	path string
	now  func() time.Time

	// persistMu serialises disk writes (snapshots are taken under it so writes
	// land in update order). mu guards entries and persistFailLogged and is
	// never held during disk I/O.
	persistMu         sync.Mutex
	mu                sync.Mutex
	entries           map[string]cacheEntry
	persistFailLogged bool
}

// NewCache loads path if present; an unreadable or corrupt file yields an
// empty cache.
func NewCache(path string) *Cache {
	c := &Cache{path: path, now: time.Now, entries: map[string]cacheEntry{}}
	if path != "" {
		c.load()
	}
	return c
}

func (c *Cache) load() {
	data, err := os.ReadFile(c.path)
	if err != nil {
		return
	}
	var entries map[string]cacheEntry
	if json.Unmarshal(data, &entries) == nil && entries != nil {
		c.entries = entries
	}
}

// Get returns a copy of the host's config list. ok is false when absent;
// fresh is false once the entry is past its TTL.
func (c *Cache) Get(host string) (configList []byte, fresh bool, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, found := c.entries[host]
	if !found {
		return nil, false, false
	}
	expiry := e.FetchedAt.Add(time.Duration(e.TTLSeconds) * time.Second)
	return append([]byte(nil), e.ConfigList...), c.now().Before(expiry), true
}

// Put stores cfg for host and persists best-effort.
func (c *Cache) Put(host string, cfg ECHConfig) {
	c.mu.Lock()
	c.entries[host] = cacheEntry{
		ConfigList: append([]byte(nil), cfg.ConfigList...),
		FetchedAt:  c.now(),
		TTLSeconds: int64(cfg.TTL / time.Second),
	}
	c.mu.Unlock()
	c.persist()
}

// Delete removes host; absent hosts are a no-op and do not persist.
func (c *Cache) Delete(host string) {
	c.mu.Lock()
	_, found := c.entries[host]
	delete(c.entries, host)
	c.mu.Unlock()
	if found {
		c.persist()
	}
}

// persist mirrors netcache: best-effort, first failure warn-logged (latched).
// Config bytes are never logged.
func (c *Cache) persist() {
	if c.path == "" {
		return
	}
	c.persistMu.Lock()
	c.mu.Lock()
	snapshot := make(map[string]cacheEntry, len(c.entries))
	for k, v := range c.entries {
		v.ConfigList = append([]byte(nil), v.ConfigList...)
		snapshot[k] = v
	}
	c.mu.Unlock()
	err := c.persistOnce(snapshot)
	c.persistMu.Unlock()

	c.mu.Lock()
	logIt := err != nil && !c.persistFailLogged
	c.persistFailLogged = err != nil
	c.mu.Unlock()
	if logIt {
		log.Warn("failed to persist ECH config cache; it will be re-fetched after restart", "path", c.path, "error", err.Error())
	}
}

func (c *Cache) persistOnce(entries map[string]cacheEntry) error {
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
