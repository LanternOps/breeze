package yarascan

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/yarascan/yarac"
)

const markerSource = `rule fixture_marker { strings: $a = "breeze_yara_fixture_marker_7f3a" condition: $a }`

func compiledFixture(t *testing.T) *CacheEntry {
	t.Helper()
	rules, errs, err := yarac.CompileSets([]yarac.Set{{ID: "s1", Rules: []yarac.Rule{{ID: "r1", Name: "fixture_marker", Severity: "high", Source: markerSource}}}}, yarac.DefaultPolicy)
	if err != nil || len(errs) != 0 {
		t.Fatal(err, errs)
	}
	return &CacheEntry{Rules: rules, Index: map[string]RuleMeta{"s1:fixture_marker": {RuleID: "r1", Severity: "high"}}, AutoQuarantine: map[string]bool{"s1": true}}
}

func newCache(t *testing.T, max int) *Cache {
	return &Cache{Dir: filepath.Join(t.TempDir(), "yara", "cache"), MaxEntries: max}
}

func TestCacheRoundTrip(t *testing.T) {
	c := newCache(t, DefaultEntries)
	key := CacheKey([]string{"bb@s2", "aa@s1"})
	if key != CacheKey([]string{"aa@s1", "bb@s2"}) {
		t.Fatal("CacheKey must be order-independent")
	}
	if miss, err := c.Load(key); miss != nil || err != nil {
		t.Fatalf("empty cache must miss cleanly, got %+v %v", miss, err)
	}
	if err := c.Store(key, compiledFixture(t)); err != nil {
		t.Fatal(err)
	}
	got, err := c.Load(key)
	if err != nil || got == nil || got.Index["s1:fixture_marker"].RuleID != "r1" || !got.AutoQuarantine["s1"] {
		t.Fatalf("load failed: %+v %v", got, err)
	}
	// The reloaded rules must actually scan.
	m := &yaraMatcher{entry: got}
	w, err := m.NewWorker()
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	matches, err := w.ScanFile("testdata/files/fixture-a.bin")
	if err != nil || len(matches) != 1 {
		t.Fatalf("cached rules did not scan: %+v %v", matches, err)
	}
	if runtime.GOOS != "windows" {
		for _, p := range []string{c.Dir, c.path(key)} {
			st, _ := os.Stat(p)
			if st.Mode().Perm()&0o077 != 0 {
				t.Errorf("%s is group/world accessible: %v", p, st.Mode().Perm())
			}
		}
	}
}

func TestCacheKeyBindsEngineAndPlatform(t *testing.T) {
	// The key material must change when any member changes; engine/policy/
	// platform binding is structural (see CacheKey) — pin the member part.
	if CacheKey([]string{"aa@s1"}) == CacheKey([]string{"ab@s1"}) || CacheKey([]string{"aa@s1"}) == CacheKey([]string{"aa@s2"}) {
		t.Fatal("cache key ignores a member change")
	}
}

func TestCacheFileHasNoPlaintextPattern(t *testing.T) {
	c := newCache(t, DefaultEntries)
	key := CacheKey([]string{"aa@s1"})
	if err := c.Store(key, compiledFixture(t)); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(c.path(key))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("breeze_yara_fixture_marker_7f3a")) {
		t.Fatal("compiled cache leaks a plaintext pattern")
	}
	// Control: the un-XORed serialized rules DO contain it, so the check
	// above is meaningful.
	var plain bytes.Buffer
	_, _ = compiledFixture(t).Rules.WriteTo(&plain)
	if !bytes.Contains(plain.Bytes(), []byte("breeze_yara_fixture_marker_7f3a")) {
		t.Skip("engine no longer stores literal patterns; leak check is vacuous")
	}
}

func storeAndCorrupt(t *testing.T, mutate func(raw []byte) []byte) (*Cache, string) {
	t.Helper()
	c := newCache(t, DefaultEntries)
	key := CacheKey([]string{"aa@s1"})
	if err := c.Store(key, compiledFixture(t)); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(c.path(key))
	if err := os.WriteFile(c.path(key), mutate(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	return c, key
}

func TestCacheRejectsTamperedPayload(t *testing.T) {
	cases := map[string]func([]byte) []byte{
		"payload byte":  func(r []byte) []byte { r[len(r)-40] ^= 0xFF; return r },
		"trailing hash": func(r []byte) []byte { r[len(r)-1] ^= 0xFF; return r },
		"truncated":     func(r []byte) []byte { return r[:len(r)/2] },
		"bad magic":     func(r []byte) []byte { r[0] = 'X'; return r },
		"bad format":    func(r []byte) []byte { binary.BigEndian.PutUint16(r[4:6], 9); return r },
		"huge header":   func(r []byte) []byte { binary.BigEndian.PutUint32(r[6:10], 1<<30); return r },
		"header json":   func(r []byte) []byte { r[10] = '!'; return r },
		"foreign key": func(r []byte) []byte {
			return bytes.Replace(r, []byte(`"key":"`), []byte(`"key":"0`), 1)
		},
		"foreign engine": func(r []byte) []byte {
			return bytes.Replace(r, []byte(`"engine":"`), []byte(`"engine":"x`), 1)
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			c, key := storeAndCorrupt(t, mutate)
			got, err := c.Load(key)
			if got != nil || err != nil {
				t.Fatalf("tampered entry must be a miss, got %+v %v", got, err)
			}
			if _, statErr := os.Lstat(c.path(key)); !os.IsNotExist(statErr) {
				t.Fatal("tampered entry must be deleted")
			}
		})
	}
}

func TestCacheRefusesSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs privileges on Windows")
	}
	// Symlinked entry: deleted, never followed.
	c := newCache(t, DefaultEntries)
	key := CacheKey([]string{"aa@s1"})
	if err := c.Store(key, compiledFixture(t)); err != nil {
		t.Fatal(err)
	}
	real := filepath.Join(t.TempDir(), "elsewhere.byrc")
	_ = os.Rename(c.path(key), real)
	if err := os.Symlink(real, c.path(key)); err != nil {
		t.Fatal(err)
	}
	if got, err := c.Load(key); got != nil || err != nil {
		t.Fatalf("symlinked entry loaded: %+v %v", got, err)
	}
	if _, err := os.Lstat(c.path(key)); !os.IsNotExist(err) {
		t.Fatal("symlinked entry not removed")
	}
	if _, err := os.Stat(real); err != nil {
		t.Fatal("symlink target must not be touched")
	}

	// Symlinked directory: refused for both load and store.
	target := t.TempDir()
	linkDir := filepath.Join(t.TempDir(), "cache")
	if err := os.Symlink(target, linkDir); err != nil {
		t.Fatal(err)
	}
	lc := &Cache{Dir: linkDir, MaxEntries: DefaultEntries}
	if err := lc.Store(key, compiledFixture(t)); err == nil {
		t.Fatal("store through a symlinked cache dir succeeded")
	}
	if _, err := lc.Load(key); err == nil {
		t.Fatal("load through a symlinked cache dir succeeded")
	}
	if entries, _ := os.ReadDir(target); len(entries) != 0 {
		t.Fatalf("wrote through symlinked dir: %v", entries)
	}
}

func TestCachePrunesLRU(t *testing.T) {
	c := newCache(t, 2)
	keys := []string{CacheKey([]string{"k1"}), CacheKey([]string{"k2"}), CacheKey([]string{"k3"})}
	base := time.Now().Add(-time.Hour)
	for i, k := range keys[:2] {
		if err := c.Store(k, compiledFixture(t)); err != nil {
			t.Fatal(err)
		}
		ts := base.Add(time.Duration(i) * time.Minute)
		_ = os.Chtimes(c.path(k), ts, ts)
	}
	// Touch k1 via a hit so k2 becomes least recently used.
	if got, _ := c.Load(keys[0]); got == nil {
		t.Fatal("k1 miss")
	}
	if err := c.Store(keys[2], compiledFixture(t)); err != nil {
		t.Fatal(err)
	}
	entries, _ := filepath.Glob(filepath.Join(c.Dir, "*.byrc"))
	if len(entries) != 2 {
		t.Fatalf("want 2 entries after prune, got %d", len(entries))
	}
	if _, err := os.Stat(c.path(keys[1])); !os.IsNotExist(err) {
		t.Fatal("the least recently used entry (k2) must be the one pruned")
	}
	if tmps, _ := filepath.Glob(filepath.Join(c.Dir, "*.tmp")); len(tmps) != 0 {
		t.Fatalf("temp files left behind: %v", tmps)
	}
}

func TestCachePruneRemovesStaleTempFiles(t *testing.T) {
	c := newCache(t, DefaultEntries)
	if err := c.ensureDir(); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(c.Dir, "dead.123.tmp")
	fresh := filepath.Join(c.Dir, "live.456.tmp")
	_ = os.WriteFile(stale, []byte("x"), 0o600)
	_ = os.WriteFile(fresh, []byte("x"), 0o600)
	old := time.Now().Add(-2 * staleTmpAge)
	_ = os.Chtimes(stale, old, old)
	if err := c.Store(CacheKey([]string{"aa@s1"}), compiledFixture(t)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatal("stale temp file not removed")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatal("a fresh temp file (possibly a concurrent Store) must be left alone")
	}
}

func TestCacheRejectsInvalidKey(t *testing.T) {
	c := newCache(t, DefaultEntries)
	if err := c.Store("../escape", compiledFixture(t)); err == nil {
		t.Fatal("path-like key accepted")
	}
	if _, err := c.Load("../escape"); err == nil {
		t.Fatal("path-like key accepted on load")
	}
}
