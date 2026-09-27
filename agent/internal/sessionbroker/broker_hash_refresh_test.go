package sessionbroker

import (
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// hashRefreshFixture builds a broker whose allowlist is a temp agent binary
// plus a Breeze Helper path that does NOT exist yet, and takes the
// construction-time hash snapshot exactly as New() does. This is the state of
// a freshly enrolled agent before the Breeze Helper MSI has landed (#7043).
type hashRefreshFixture struct {
	b          *Broker
	agentPath  string
	helperPath string
	outside    string // a file at a path that is NOT allowlisted
	pathCalls  atomic.Int32
	clock      time.Time
	clockMu    sync.Mutex
}

func newHashRefreshFixture(t *testing.T) *hashRefreshFixture {
	t.Helper()
	dir := t.TempDir()
	f := &hashRefreshFixture{
		agentPath:  filepath.Join(dir, "breeze-agent"),
		helperPath: filepath.Join(dir, "Breeze Helper", "breeze-helper"),
		outside:    filepath.Join(dir, "not-allowlisted"),
		clock:      time.Date(2026, 9, 26, 12, 0, 0, 0, time.UTC),
	}
	if err := os.WriteFile(f.agentPath, []byte("agent-binary"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(f.helperPath), 0o700); err != nil {
		t.Fatal(err)
	}
	f.b = New(filepath.Join(dir, "broker.sock"), nil)
	f.b.helperPathsFn = func() []string {
		f.pathCalls.Add(1)
		return []string{f.agentPath, f.helperPath}
	}
	f.b.nowFn = func() time.Time {
		f.clockMu.Lock()
		defer f.clockMu.Unlock()
		return f.clock
	}
	// The construction-time snapshot, taken before the helper exists.
	f.b.selfHashes = f.b.computeAllowedHashes()
	if got := f.b.allowedHashCount(); got != 1 {
		t.Fatalf("snapshot hash count = %d, want 1 (agent only)", got)
	}
	f.pathCalls.Store(0)
	return f
}

func (f *hashRefreshFixture) advance(d time.Duration) {
	f.clockMu.Lock()
	f.clock = f.clock.Add(d)
	f.clockMu.Unlock()
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o700); err != nil {
		t.Fatal(err)
	}
}

// The regression for #7043: the broker starts, the helper is installed
// afterwards, and its first connection must be accepted without an agent
// restart.
func TestVerifyPeerBinaryHash_HelperInstalledAfterBrokerStart(t *testing.T) {
	f := newHashRefreshFixture(t)
	writeFile(t, f.helperPath, "breeze-helper-0.116.0")

	hash, ok, err := f.b.verifyPeerBinaryHash(f.helperPath)
	if err != nil {
		t.Fatalf("verifyPeerBinaryHash: %v", err)
	}
	if !ok {
		t.Fatalf("helper installed after broker start was rejected (hash %s); want accepted after an on-miss refresh", hash)
	}
	if got := f.b.allowedHashCount(); got != 2 {
		t.Fatalf("allowlist after refresh has %d hashes, want 2", got)
	}
}

// A helper update replaces the file at an allowlisted path with a new hash.
func TestVerifyPeerBinaryHash_HelperUpdatedInPlace(t *testing.T) {
	f := newHashRefreshFixture(t)
	writeFile(t, f.helperPath, "breeze-helper-0.116.0")
	if _, ok, _ := f.b.verifyPeerBinaryHash(f.helperPath); !ok {
		t.Fatal("initial helper rejected")
	}

	f.advance(hashMissRefreshInterval + time.Second)
	writeFile(t, f.helperPath, "breeze-helper-0.117.0")
	if _, ok, _ := f.b.verifyPeerBinaryHash(f.helperPath); !ok {
		t.Fatal("updated helper rejected; want accepted after an on-miss refresh")
	}
}

// A peer whose path is not on the allowlist must never trigger a rehash, and
// is never accepted by the refresh path.
func TestVerifyPeerBinaryHash_NonAllowlistedPathDoesNotRefresh(t *testing.T) {
	f := newHashRefreshFixture(t)
	writeFile(t, f.outside, "some-other-binary")

	_, ok, err := f.b.verifyPeerBinaryHash(f.outside)
	if err != nil {
		t.Fatalf("verifyPeerBinaryHash: %v", err)
	}
	if ok {
		t.Fatal("non-allowlisted peer was accepted")
	}
	// helperPaths is consulted once to establish the peer is not allowlisted;
	// a refresh would consult it again.
	if n := f.pathCalls.Load(); n > 1 {
		t.Fatalf("helperPaths consulted %d times; a non-allowlisted peer must not trigger a refresh", n)
	}
}

// Acceptance still requires the peer's on-disk bytes to hash to an allowlisted
// file's bytes. A path that is allowlisted but whose file is not what the
// refresh sees (here: the refresh is rate-limited, so the set is stale) is
// rejected, never accepted on path alone.
func TestVerifyPeerBinaryHash_RefreshIsRateLimited(t *testing.T) {
	f := newHashRefreshFixture(t)
	writeFile(t, f.helperPath, "breeze-helper-A")
	if _, ok, _ := f.b.verifyPeerBinaryHash(f.helperPath); !ok {
		t.Fatal("first helper rejected")
	}

	// Replace the file again inside the rate-limit window: no second rehash.
	writeFile(t, f.helperPath, "breeze-helper-B")
	f.pathCalls.Store(0)
	for i := 0; i < 5; i++ {
		if _, ok, _ := f.b.verifyPeerBinaryHash(f.helperPath); ok {
			t.Fatalf("attempt %d: helper accepted inside the rate-limit window without a refresh", i)
		}
	}
	if n := f.pathCalls.Load(); n > 5 {
		t.Fatalf("helperPaths consulted %d times over 5 misses; the allowlist was rehashed inside the rate-limit window", n)
	}

	// Once the window has elapsed, the next miss refreshes and admits it.
	f.advance(hashMissRefreshInterval + time.Second)
	if _, ok, _ := f.b.verifyPeerBinaryHash(f.helperPath); !ok {
		t.Fatal("helper rejected after the rate-limit window elapsed")
	}
}

// Concurrent misses from the same stale path trigger a single rehash, and all
// of them are accepted.
func TestVerifyPeerBinaryHash_ConcurrentMissesRefreshOnce(t *testing.T) {
	f := newHashRefreshFixture(t)
	writeFile(t, f.helperPath, "breeze-helper-0.116.0")

	var refreshes atomic.Int32
	f.b.helperPathsFn = func() []string {
		refreshes.Add(1)
		return []string{f.agentPath, f.helperPath}
	}

	const n = 8
	var wg sync.WaitGroup
	results := make([]bool, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, ok, _ := f.b.verifyPeerBinaryHash(f.helperPath)
			results[i] = ok
		}(i)
	}
	wg.Wait()
	for i, ok := range results {
		if !ok {
			t.Fatalf("concurrent verify %d rejected", i)
		}
	}
	// Each verify consults helperPaths once for the allowlisted-path check;
	// exactly one of them also runs computeAllowedHashes (one more call).
	if got, max := refreshes.Load(), int32(n+1); got > max {
		t.Fatalf("helperPaths consulted %d times, want <= %d (one refresh)", got, max)
	}
}
