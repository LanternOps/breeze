package yarascan

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	yx "github.com/niallnsec/yaraxwasm"

	"github.com/breeze-rmm/agent/internal/obfuscate"
	"github.com/breeze-rmm/agent/internal/yarascan/yarac"
)

// Compiled-rules cache (C4). Agent-private: W03 must not depend on it.
//
// File layout: "BYRC" · uint16 BE format · uint32 BE headerLen · header JSON ·
// XOR-0x5A(Rules.WriteTo bytes) · sha256 of the UN-XORed payload (32 bytes).
// The XOR is an AV-recognition break (compiled rules contain literal pattern
// bytes), not confidentiality — same rationale as the .bqz quarantine format.

const (
	cacheMagic     = "BYRC"
	cacheFormat    = uint16(1)
	cacheExt       = ".byrc"
	cacheFixedLen  = 4 + 2 + 4
	maxHeaderLen   = 8 << 20
	maxCacheFile   = 64 << 20
	DefaultEntries = 16
)

// RuleMeta is what the scan result needs about a rule that the compiled form
// does not carry.
type RuleMeta struct {
	RuleID   string `json:"ruleId"`
	Severity string `json:"severity"`
}

// CacheEntry is one compiled rule-set combination. Index is keyed
// "<ruleSetId>:<ruleName>"; AutoQuarantine by ruleSetId (spec D7).
type CacheEntry struct {
	Rules          *yx.Rules
	Index          map[string]RuleMeta
	AutoQuarantine map[string]bool
}

type cacheHeader struct {
	Key            string              `json:"key"`
	Engine         string              `json:"engine"`
	GOOS           string              `json:"goos"`
	GOARCH         string              `json:"goarch"`
	CreatedAt      string              `json:"createdAt"`
	Rules          map[string]RuleMeta `json:"rules"`
	AutoQuarantine map[string]bool     `json:"autoQuarantine"`
}

// Cache is a directory of compiled entries, at most MaxEntries kept (LRU by
// mtime, touched on every hit).
type Cache struct {
	Dir        string
	MaxEntries int
}

// CacheKey derives the entry key from "<bundle sha256>@<ruleSetId>" members.
// Order-independent; binds the engine version, compile policy and platform so
// an agent upgrade or policy change can never be served a stale binary.
func CacheKey(members []string) string {
	sorted := append([]string(nil), members...)
	sort.Strings(sorted)
	material := "byrc1\n" + yarac.EngineVersion() + "\n" + strconv.Itoa(yarac.PolicyVersion) + "\n" +
		runtime.GOOS + "/" + runtime.GOARCH + "\n" + strings.Join(sorted, "\n")
	sum := sha256.Sum256([]byte(material))
	return hex.EncodeToString(sum[:])
}

func validKey(key string) bool {
	if len(key) != 64 {
		return false
	}
	_, err := hex.DecodeString(key)
	return err == nil
}

func (c *Cache) path(key string) string { return filepath.Join(c.Dir, key+cacheExt) }

// ensureDir creates the cache directory 0700 and refuses a symlink there: the
// agent runs privileged, and a planted link would redirect its writes.
func (c *Cache) ensureDir() error {
	if c.Dir == "" {
		return errors.New("YARA cache dir not configured")
	}
	if err := os.MkdirAll(c.Dir, 0o700); err != nil {
		return err
	}
	st, err := os.Lstat(c.Dir)
	if err != nil {
		return err
	}
	if st.Mode()&os.ModeSymlink != 0 || !st.IsDir() {
		return fmt.Errorf("YARA cache dir %s is not a plain directory; refusing", c.Dir)
	}
	if st.Mode().Perm()&0o077 != 0 {
		_ = os.Chmod(c.Dir, 0o700) // best effort; no-op semantics on Windows
	}
	return nil
}

// Store writes an entry atomically (temp file + rename) and prunes to
// MaxEntries.
func (c *Cache) Store(key string, e *CacheEntry) error {
	if !validKey(key) {
		return fmt.Errorf("invalid cache key")
	}
	if e == nil || e.Rules == nil {
		return errors.New("nothing to cache")
	}
	if err := c.ensureDir(); err != nil {
		return err
	}
	var payload bytes.Buffer
	if _, err := e.Rules.WriteTo(&payload); err != nil {
		return fmt.Errorf("serialize rules: %w", err)
	}
	plain := payload.Bytes()
	sum := sha256.Sum256(plain)
	hdr, err := json.Marshal(cacheHeader{Key: key, Engine: yarac.EngineVersion(), GOOS: runtime.GOOS, GOARCH: runtime.GOARCH,
		CreatedAt: time.Now().UTC().Format(time.RFC3339), Rules: e.Index, AutoQuarantine: e.AutoQuarantine})
	if err != nil {
		return err
	}
	if len(hdr) > maxHeaderLen || cacheFixedLen+len(hdr)+len(plain)+32 > maxCacheFile {
		return fmt.Errorf("compiled rules too large to cache (%d bytes)", len(plain))
	}
	var out bytes.Buffer
	out.Grow(cacheFixedLen + len(hdr) + len(plain) + 32)
	out.WriteString(cacheMagic)
	_ = binary.Write(&out, binary.BigEndian, cacheFormat)
	_ = binary.Write(&out, binary.BigEndian, uint32(len(hdr)))
	out.Write(hdr)
	out.Write(obfuscate.DecodeBytes(plain)) // XOR is its own inverse
	out.Write(sum[:])

	tmp, err := os.CreateTemp(c.Dir, key+".*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }
	if _, err := tmp.Write(out.Bytes()); err != nil {
		_ = tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Chmod(tmpName, 0o600); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(tmpName, c.path(key)); err != nil {
		cleanup()
		return err
	}
	c.prune()
	return nil
}

func (c *Cache) discard(p, why string) {
	log.Warn("discarding YARA compiled-rules cache entry", "path", p, "reason", why)
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Warn("failed to delete YARA cache entry", "path", p, "error", err.Error())
	}
}

// Load returns the entry for key, or (nil, nil) on a miss. A tampered,
// truncated, foreign (other engine/arch/key) or symlinked entry is deleted
// and reported as a miss — never loaded. An error means the cache itself is
// unusable (e.g. the directory is a symlink); callers compile without it.
func (c *Cache) Load(key string) (entry *CacheEntry, err error) {
	if !validKey(key) {
		return nil, fmt.Errorf("invalid cache key")
	}
	if st, lerr := os.Lstat(c.Dir); lerr != nil {
		if errors.Is(lerr, os.ErrNotExist) {
			return nil, nil
		}
		return nil, lerr
	} else if st.Mode()&os.ModeSymlink != 0 || !st.IsDir() {
		return nil, fmt.Errorf("YARA cache dir %s is not a plain directory; refusing", c.Dir)
	}
	p := c.path(key)
	st, lerr := os.Lstat(p)
	if errors.Is(lerr, os.ErrNotExist) {
		return nil, nil
	}
	if lerr != nil {
		return nil, lerr
	}
	if !st.Mode().IsRegular() || st.Size() > maxCacheFile {
		c.discard(p, "not a regular file or oversized")
		return nil, nil
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(io.LimitReader(f, maxCacheFile+1))
	_ = f.Close()
	if err != nil {
		return nil, err
	}
	if len(raw) > maxCacheFile {
		c.discard(p, "oversized")
		return nil, nil
	}
	if len(raw) < cacheFixedLen+32 || string(raw[:4]) != cacheMagic || binary.BigEndian.Uint16(raw[4:6]) != cacheFormat {
		c.discard(p, "bad magic/format")
		return nil, nil
	}
	hlen := int64(binary.BigEndian.Uint32(raw[6:10]))
	if hlen > maxHeaderLen || cacheFixedLen+hlen+32 > int64(len(raw)) {
		c.discard(p, "bad header length")
		return nil, nil
	}
	hEnd := cacheFixedLen + int(hlen)
	var hdr cacheHeader
	if err := json.Unmarshal(raw[cacheFixedLen:hEnd], &hdr); err != nil {
		c.discard(p, "header decode")
		return nil, nil
	}
	if hdr.Key != key || hdr.Engine != yarac.EngineVersion() || hdr.GOOS != runtime.GOOS || hdr.GOARCH != runtime.GOARCH {
		c.discard(p, "key/engine/arch mismatch")
		return nil, nil
	}
	plain := obfuscate.DecodeBytes(raw[hEnd : len(raw)-32])
	sum := sha256.Sum256(plain)
	if !bytes.Equal(sum[:], raw[len(raw)-32:]) {
		c.discard(p, "payload hash mismatch")
		return nil, nil
	}
	if err := yarac.EnsureEngine(); err != nil {
		return nil, err
	}
	rules, derr := readRules(plain)
	if derr != nil {
		c.discard(p, "deserialize: "+derr.Error())
		return nil, nil
	}
	now := time.Now()
	_ = os.Chtimes(p, now, now) // LRU touch
	if hdr.Rules == nil {
		hdr.Rules = map[string]RuleMeta{}
	}
	if hdr.AutoQuarantine == nil {
		hdr.AutoQuarantine = map[string]bool{}
	}
	return &CacheEntry{Rules: rules, Index: hdr.Rules, AutoQuarantine: hdr.AutoQuarantine}, nil
}

func readRules(plain []byte) (rules *yx.Rules, err error) {
	defer func() {
		if r := recover(); r != nil {
			rules, err = nil, fmt.Errorf("engine panic: %v", r)
		}
	}()
	return yx.ReadFrom(bytes.NewReader(plain))
}

func (c *Cache) prune() {
	if c.MaxEntries <= 0 {
		return
	}
	paths, err := filepath.Glob(filepath.Join(c.Dir, "*"+cacheExt))
	if err != nil || len(paths) <= c.MaxEntries {
		return
	}
	type fe struct {
		p string
		t time.Time
	}
	all := make([]fe, 0, len(paths))
	for _, p := range paths {
		if st, err := os.Lstat(p); err == nil {
			all = append(all, fe{p, st.ModTime()})
		}
	}
	sort.Slice(all, func(i, j int) bool { return all[i].t.After(all[j].t) })
	if len(all) <= c.MaxEntries {
		return
	}
	for _, f := range all[c.MaxEntries:] {
		c.discard(f.p, "lru prune")
	}
}
