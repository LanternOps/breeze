package storagesession

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

func fmtV(d *Descriptor) string { return fmt.Sprintf("%v %+v %#v %s", d, d, d, d) }

var (
	_ providers.BackupProvider    = (*Provider)(nil)
	_ providers.ContextDownloader = (*Provider)(nil)
	_ providers.DownloadPlanner   = (*Provider)(nil)
)

func readFile(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("read %s: %v", p, err)
	}
	return string(b)
}

func TestDownloadResolvesThroughSessionAndFetchesWithoutSessionCredentials(t *testing.T) {
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	// Keys are opaque and must reach the server byte-for-byte: no cleaning,
	// decoding, case folding or slash normalisation.
	keys := []string{
		"snapshots/s1/manifest.json",
		"snapshots/s1/files/Dir/../A%2Fb .TXT",
		"/snapshots/s1//files/x",
	}
	for i, k := range keys {
		st.put(k, []byte(fmt.Sprintf("content-%d", i)))
	}
	p := newTestProvider(t, cp, testDescriptor(cp, time.Now()), Options{})

	dir := t.TempDir()
	for i, k := range keys {
		dst := filepath.Join(dir, fmt.Sprintf("out-%d", i))
		if err := p.Download(k, dst); err != nil {
			t.Fatalf("Download(%q): %v", k, err)
		}
		if got := readFile(t, dst); got != fmt.Sprintf("content-%d", i) {
			t.Fatalf("content = %q", got)
		}
	}

	calls := cp.calls()
	if len(calls) != len(keys) {
		t.Fatalf("resolve calls = %d, want %d", len(calls), len(keys))
	}
	for i, c := range calls {
		if len(c.keys) != 1 || c.keys[0] != keys[i] {
			t.Fatalf("resolve call %d keys = %q, want exactly %q", i, c.keys, keys[i])
		}
		if got := c.headers.Get("Authorization"); got != "Bearer "+testAgentToken {
			t.Fatalf("resolve Authorization = %q, want agent bearer", got)
		}
		if got := c.headers.Get(SessionHeader); got != testSessionToken {
			t.Fatalf("resolve session header missing")
		}
	}
	for _, r := range st.recorded() {
		if r.Header.Get(SessionHeader) != "" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Fatalf("storage request carried control-plane credentials: %v", r.Header)
		}
		if strings.Contains(r.URL.RawQuery, testSessionToken) {
			t.Fatal("session token appeared in a storage URL")
		}
	}
}

func TestPrepareDownloadsResolvesInBoundedSlidingBatches(t *testing.T) {
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	const n = 250
	keys := make([]string, n)
	for i := range keys {
		keys[i] = fmt.Sprintf("snapshots/s1/files/f%03d", i)
		st.put(keys[i], []byte("x"))
	}
	d := testDescriptor(cp, time.Now())
	d.MaxBatch = 100
	p := newTestProvider(t, cp, d, Options{})
	p.PrepareDownloads(keys)

	dir := t.TempDir()
	for i, k := range keys {
		if err := p.Download(k, filepath.Join(dir, fmt.Sprintf("%d", i))); err != nil {
			t.Fatalf("Download: %v", err)
		}
	}
	calls := cp.calls()
	if len(calls) != 3 {
		t.Fatalf("resolve calls = %d, want 3 batches for %d keys", len(calls), n)
	}
	wantSizes := []int{100, 100, 50}
	for i, c := range calls {
		if len(c.keys) != wantSizes[i] {
			t.Fatalf("batch %d size = %d, want %d", i, len(c.keys), wantSizes[i])
		}
		if c.keys[0] != keys[i*100] {
			t.Fatalf("batch %d starts at %q, want %q", i, c.keys[0], keys[i*100])
		}
	}
}

func TestConcurrentDownloadsShareOneBatch(t *testing.T) {
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	keys := make([]string, 40)
	for i := range keys {
		keys[i] = fmt.Sprintf("snapshots/s1/files/c%02d", i)
		st.put(keys[i], []byte("y"))
	}
	p := newTestProvider(t, cp, testDescriptor(cp, time.Now()), Options{})
	p.PrepareDownloads(keys)
	dir := t.TempDir()
	var wg sync.WaitGroup
	errs := make(chan error, len(keys))
	for i, k := range keys {
		wg.Add(1)
		go func(i int, k string) {
			defer wg.Done()
			errs <- p.DownloadContext(context.Background(), k, filepath.Join(dir, fmt.Sprintf("%d", i)))
		}(i, k)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent download: %v", err)
		}
	}
	total := 0
	for _, c := range cp.calls() {
		total += len(c.keys)
	}
	if total != len(keys) {
		t.Fatalf("resolved %d keys in total for %d distinct keys; each key must be resolved once", total, len(keys))
	}
}

func TestResolvedURLCachedUntilNearExpiry(t *testing.T) {
	clock := &fakeClock{now: time.Now()}
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	cp.set(func(cp *fakeControlPlane) { cp.now = clock.Now; cp.urlTTL = 5 * time.Minute })
	key := "snapshots/s1/files/cached"
	st.put(key, []byte("c"))
	p := newTestProvider(t, cp, testDescriptor(cp, clock.Now()), Options{Now: clock.Now})
	dir := t.TempDir()

	download := func() {
		t.Helper()
		if err := p.Download(key, filepath.Join(dir, "o")); err != nil {
			t.Fatalf("Download: %v", err)
		}
	}
	download()
	clock.Advance(4 * time.Minute) // 60s left: still usable
	download()
	if got := len(cp.calls()); got != 1 {
		t.Fatalf("resolve calls = %d, want the cached URL reused", got)
	}
	clock.Advance(45 * time.Second) // 15s left: inside the 30s margin
	download()
	if got := len(cp.calls()); got != 2 {
		t.Fatalf("resolve calls = %d, want a re-resolve near URL expiry", got)
	}
}

func TestStorageForbiddenTriggersReResolve(t *testing.T) {
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	key := "snapshots/s1/files/forbidden-once"
	st.put(key, []byte("ok"))
	st.setHook(func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Query().Get("g") == "x" { // first generation URL
			http.Error(w, "AccessDenied", http.StatusForbidden)
			return true
		}
		return false
	})
	p := newTestProvider(t, cp, testDescriptor(cp, time.Now()), Options{})
	dst := filepath.Join(t.TempDir(), "o")
	if err := p.Download(key, dst); err != nil {
		t.Fatalf("Download: %v", err)
	}
	if readFile(t, dst) != "ok" {
		t.Fatal("wrong content")
	}
	if got := len(cp.calls()); got != 2 {
		t.Fatalf("resolve calls = %d, want 2 (re-resolve after 403)", got)
	}
}

func TestStorageForbiddenPersistentlyFails(t *testing.T) {
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	st.setHook(func(w http.ResponseWriter, r *http.Request) bool {
		http.Error(w, "AccessDenied", http.StatusForbidden)
		return true
	})
	p := newTestProvider(t, cp, testDescriptor(cp, time.Now()), Options{})
	if err := p.Download("snapshots/s1/files/never", filepath.Join(t.TempDir(), "o")); err == nil {
		t.Fatal("persistent 403 must fail")
	}
	if got := len(cp.calls()); got > 3 {
		t.Fatalf("resolve calls = %d; re-resolution after 403 must be bounded", got)
	}
}

func TestResolveRateLimitHonoursRetryAfter(t *testing.T) {
	waits := noSleep(t)
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	key := "snapshots/s1/files/limited"
	st.put(key, []byte("z"))
	cp.set(func(cp *fakeControlPlane) {
		cp.resolveHook = func(call int, _ []string, w http.ResponseWriter) bool {
			if call <= 2 {
				w.Header().Set("Retry-After", "7")
				http.Error(w, "slow down", http.StatusTooManyRequests)
				return true
			}
			return false
		}
	})
	p := newTestProvider(t, cp, testDescriptor(cp, time.Now()), Options{})
	if err := p.Download(key, filepath.Join(t.TempDir(), "o")); err != nil {
		t.Fatalf("Download: %v", err)
	}
	if len(*waits) != 2 || (*waits)[0] != 7*time.Second || (*waits)[1] != 7*time.Second {
		t.Fatalf("waits = %v, want two 7s Retry-After waits", *waits)
	}
}

func TestResolveRateLimitGivesUpEventually(t *testing.T) {
	waits := noSleep(t)
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	cp.set(func(cp *fakeControlPlane) {
		cp.resolveHook = func(int, []string, http.ResponseWriter) bool { return false }
		cp.resolveHook = func(_ int, _ []string, w http.ResponseWriter) bool {
			w.Header().Set("Retry-After", "60")
			http.Error(w, "slow down", http.StatusTooManyRequests)
			return true
		}
	})
	p := newTestProvider(t, cp, testDescriptor(cp, time.Now()), Options{})
	err := p.Download("snapshots/s1/files/k", filepath.Join(t.TempDir(), "o"))
	if err == nil {
		t.Fatal("unbounded 429 must eventually fail")
	}
	var total time.Duration
	for _, w := range *waits {
		total += w
	}
	if total < 5*time.Minute || total > 7*time.Minute {
		t.Fatalf("total backoff = %v, want bounded around 5m", total)
	}
}

func TestLeaseRenewedWhenAThirdRemains(t *testing.T) {
	clock := &fakeClock{now: time.Now()}
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	cp.set(func(cp *fakeControlPlane) { cp.now = clock.Now })
	key := "snapshots/s1/files/lease"
	st.put(key, []byte("l"))
	d := testDescriptor(cp, clock.Now())
	d.ExpiresAt = clock.Now().Add(90 * time.Second).UTC().Format(time.RFC3339)
	p := newTestProvider(t, cp, d, Options{Now: clock.Now, RenewCheckInterval: time.Hour})
	dir := t.TempDir()

	if err := p.Download(key, filepath.Join(dir, "a")); err != nil {
		t.Fatalf("Download: %v", err)
	}
	if cp.renews() != 0 {
		t.Fatal("renewed with most of the lease left")
	}
	clock.Advance(65 * time.Second) // 25s of 90s left (< 1/3)
	if err := p.Download("snapshots/s1/files/lease2", filepath.Join(dir, "b")); err == nil || !errors.Is(err, providers.ErrObjectNotFound) {
		// lease2 is absent from storage: the point is the renew before the resolve.
		t.Fatalf("Download lease2: %v", err)
	}
	if cp.renews() != 1 {
		t.Fatalf("renew calls = %d, want 1", cp.renews())
	}
}

func TestBackgroundRenewalKeepsLeaseAliveDuringLongTransfer(t *testing.T) {
	clock := &fakeClock{now: time.Now()}
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	cp.set(func(cp *fakeControlPlane) { cp.now = clock.Now })
	d := testDescriptor(cp, clock.Now())
	d.ExpiresAt = clock.Now().Add(90 * time.Second).UTC().Format(time.RFC3339)
	newTestProvider(t, cp, d, Options{Now: clock.Now, RenewCheckInterval: 5 * time.Millisecond})
	clock.Advance(70 * time.Second)
	deadline := time.Now().Add(5 * time.Second)
	for cp.renews() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if cp.renews() == 0 {
		t.Fatal("background renewal never fired")
	}
}

func TestSessionGoneFailsFastWithoutFallback(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusGone} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			st := newFakeStorage(t)
			cp := newFakeControlPlane(t, st)
			cp.set(func(cp *fakeControlPlane) {
				cp.resolveHook = func(_ int, _ []string, w http.ResponseWriter) bool {
					http.Error(w, "no", status)
					return true
				}
			})
			p := newTestProvider(t, cp, testDescriptor(cp, time.Now()), Options{})
			dir := t.TempDir()
			for i := 0; i < 3; i++ {
				err := p.Download(fmt.Sprintf("snapshots/s1/files/%d", i), filepath.Join(dir, "o"))
				if err == nil || !strings.Contains(err.Error(), "storage session") {
					t.Fatalf("Download error = %v, want a storage session failure", err)
				}
				if errors.Is(err, providers.ErrObjectNotFound) {
					t.Fatal("a session rejection must never read as a confirmed-absent object")
				}
			}
			if got := len(cp.calls()); got != 1 {
				t.Fatalf("resolve calls = %d; a rejected session must fail later downloads without contacting the server", got)
			}
		})
	}
}

func TestRenewGoneEndsSession(t *testing.T) {
	clock := &fakeClock{now: time.Now()}
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	cp.set(func(cp *fakeControlPlane) {
		cp.now = clock.Now
		cp.renewHook = func(int, http.ResponseWriter) bool { return false }
		cp.renewHook = func(_ int, w http.ResponseWriter) bool {
			http.Error(w, "revoked", http.StatusGone)
			return true
		}
	})
	d := testDescriptor(cp, clock.Now())
	d.ExpiresAt = clock.Now().Add(90 * time.Second).UTC().Format(time.RFC3339)
	p := newTestProvider(t, cp, d, Options{Now: clock.Now, RenewCheckInterval: time.Hour})
	clock.Advance(70 * time.Second)
	err := p.Download("snapshots/s1/files/k", filepath.Join(t.TempDir(), "o"))
	if err == nil || !strings.Contains(err.Error(), "storage session") {
		t.Fatalf("Download = %v, want session ended", err)
	}
	if len(cp.calls()) != 0 {
		t.Fatal("resolved after the session was revoked")
	}
}

func TestDeadlineEndsSession(t *testing.T) {
	clock := &fakeClock{now: time.Now()}
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	d := testDescriptor(cp, clock.Now())
	d.ExpiresAt = clock.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339)
	d.Deadline = clock.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339)
	p := newTestProvider(t, cp, d, Options{Now: clock.Now, RenewCheckInterval: time.Hour})
	clock.Advance(11 * time.Minute)
	if err := p.Download("snapshots/s1/files/k", filepath.Join(t.TempDir(), "o")); err == nil {
		t.Fatal("download after the absolute deadline must fail")
	}
	if len(cp.calls()) != 0 {
		t.Fatal("contacted the server after the deadline")
	}
}

func TestDeniedKeyFailsButBatchNeighboursSucceed(t *testing.T) {
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	keys := []string{"snapshots/s1/files/a", "snapshots/other/files/b", "snapshots/s1/files/c"}
	for _, k := range keys {
		st.put(k, []byte("v"))
	}
	cp.set(func(cp *fakeControlPlane) { cp.denied[keys[1]] = true })
	p := newTestProvider(t, cp, testDescriptor(cp, time.Now()), Options{})
	p.PrepareDownloads(keys)
	dir := t.TempDir()
	if err := p.Download(keys[0], filepath.Join(dir, "a")); err != nil {
		t.Fatalf("a: %v", err)
	}
	err := p.Download(keys[1], filepath.Join(dir, "b"))
	if err == nil || errors.Is(err, providers.ErrObjectNotFound) {
		t.Fatalf("denied key: err = %v, want a non-not-found refusal", err)
	}
	if _, statErr := os.Stat(filepath.Join(dir, "b")); statErr == nil {
		t.Fatal("denied key produced a local file")
	}
	if err := p.Download(keys[2], filepath.Join(dir, "c")); err != nil {
		t.Fatalf("c: %v", err)
	}
	if got := len(cp.calls()); got != 1 {
		t.Fatalf("resolve calls = %d, want one batch", got)
	}
	for _, r := range st.recorded() {
		if r.URL.Query().Get("k") == keys[1] {
			t.Fatal("denied key reached storage")
		}
	}
}

func TestStorageNotFoundIsConfirmedAbsent(t *testing.T) {
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	p := newTestProvider(t, cp, testDescriptor(cp, time.Now()), Options{})
	err := p.Download("snapshots/s1/system-state/manifest.json", filepath.Join(t.TempDir(), "o"))
	if !errors.Is(err, providers.ErrObjectNotFound) {
		t.Fatalf("err = %v, want ErrObjectNotFound", err)
	}
}

func TestWriteOperationsFailClosed(t *testing.T) {
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	p := newTestProvider(t, cp, testDescriptor(cp, time.Now()), Options{})
	if err := p.Upload("/tmp/x", "snapshots/s1/files/x"); err == nil {
		t.Fatal("Upload must fail")
	}
	if _, err := p.List("snapshots/s1"); err == nil {
		t.Fatal("List must fail")
	}
	if err := p.Delete("snapshots/s1/files/x"); err == nil {
		t.Fatal("Delete must fail")
	}
	if len(cp.calls()) != 0 || len(st.recorded()) != 0 {
		t.Fatal("write operations touched the network")
	}
}

func TestResolveResponseValidation(t *testing.T) {
	cases := []struct {
		name string
		body func(storageURL string, keys []string) string
	}{
		{"unrequested key", func(u string, _ []string) string {
			return `{"objects":[{"key":"snapshots/other/manifest.json","method":"GET","url":"` + u + `","headers":{},"expiresAt":"` + time.Now().Add(time.Minute).UTC().Format(time.RFC3339) + `"}],"denied":[]}`
		}},
		{"non-GET method", func(u string, k []string) string {
			return `{"objects":[{"key":"` + k[0] + `","method":"PUT","url":"` + u + `","headers":{},"expiresAt":"` + time.Now().Add(time.Minute).UTC().Format(time.RFC3339) + `"}],"denied":[]}`
		}},
		{"authorization header", func(u string, k []string) string {
			return `{"objects":[{"key":"` + k[0] + `","method":"GET","url":"` + u + `","headers":{"Authorization":"x"},"expiresAt":"` + time.Now().Add(time.Minute).UTC().Format(time.RFC3339) + `"}],"denied":[]}`
		}},
		{"cookie header", func(u string, k []string) string {
			return `{"objects":[{"key":"` + k[0] + `","method":"GET","url":"` + u + `","headers":{"cookie":"x"},"expiresAt":"` + time.Now().Add(time.Minute).UTC().Format(time.RFC3339) + `"}],"denied":[]}`
		}},
		{"missing expiry", func(u string, k []string) string {
			return `{"objects":[{"key":"` + k[0] + `","method":"GET","url":"` + u + `","headers":{}}],"denied":[]}`
		}},
		{"plain http url", func(u string, k []string) string {
			return `{"objects":[{"key":"` + k[0] + `","method":"GET","url":"` + strings.Replace(u, "https://", "http://", 1) + `","headers":{},"expiresAt":"` + time.Now().Add(time.Minute).UTC().Format(time.RFC3339) + `"}],"denied":[]}`
		}},
		{"url with userinfo", func(u string, k []string) string {
			return `{"objects":[{"key":"` + k[0] + `","method":"GET","url":"` + strings.Replace(u, "https://", "https://u:p@", 1) + `","headers":{},"expiresAt":"` + time.Now().Add(time.Minute).UTC().Format(time.RFC3339) + `"}],"denied":[]}`
		}},
		{"key missing from answer", func(string, []string) string { return `{"objects":[],"denied":[]}` }},
		{"malformed json", func(string, []string) string { return `{"objects":` }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			st := newFakeStorage(t)
			cp := newFakeControlPlane(t, st)
			key := "snapshots/s1/files/v"
			st.put(key, []byte("v"))
			cp.set(func(cp *fakeControlPlane) {
				cp.resolveHook = func(_ int, keys []string, w http.ResponseWriter) bool {
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(tc.body(st.urlFor(keys[0], 1), keys)))
					return true
				}
			})
			p := newTestProvider(t, cp, testDescriptor(cp, time.Now()), Options{})
			if err := p.Download(key, filepath.Join(t.TempDir(), "o")); err == nil {
				t.Fatal("invalid resolve answer accepted")
			}
			if len(st.recorded()) != 0 {
				t.Fatal("storage contacted on an invalid resolve answer")
			}
		})
	}
}

// otherHost is a TLS server on a different host than the fake storage, used
// as a redirect target that resolve never returned. httptest binds
// 127.0.0.1; "localhost" names the same socket under a different host.
func otherHostURL(srv *httptest.Server) string {
	return strings.Replace(srv.URL, "127.0.0.1", "localhost", 1)
}

func TestStorageRedirectRules(t *testing.T) {
	type env struct {
		st       *fakeStorage
		foreign  *httptest.Server
		foreignN *int
		plain    *httptest.Server
		plainN   *int
		mu       *sync.Mutex
	}
	cases := []struct {
		name    string
		hook    func(e env) func(w http.ResponseWriter, r *http.Request) bool
		wantErr string
		check   func(t *testing.T, e env)
	}{
		{
			name: "same-host redirect followed without credentials or cookies",
			hook: func(e env) func(http.ResponseWriter, *http.Request) bool {
				return func(w http.ResponseWriter, r *http.Request) bool {
					if r.URL.Path == "/obj" {
						http.SetCookie(w, &http.Cookie{Name: "track", Value: "1"})
						http.Redirect(w, r, "/final?k="+r.URL.Query().Get("k"), http.StatusFound)
						return true
					}
					if r.URL.Path == "/final" {
						_, _ = w.Write([]byte("redirected"))
						return true
					}
					return false
				}
			},
			check: func(t *testing.T, e env) {
				reqs := e.st.recorded()
				if len(reqs) != 2 {
					t.Fatalf("storage requests = %d, want 2", len(reqs))
				}
				for _, r := range reqs {
					if r.Header.Get("Cookie") != "" || r.Header.Get(SessionHeader) != "" || r.Header.Get("Authorization") != "" {
						t.Fatalf("redirect hop carried credentials: %v", r.Header)
					}
				}
			},
		},
		{
			name: "redirect to a host resolve never returned is refused",
			hook: func(e env) func(http.ResponseWriter, *http.Request) bool {
				return func(w http.ResponseWriter, r *http.Request) bool {
					http.Redirect(w, r, otherHostURL(e.foreign)+"/elsewhere", http.StatusTemporaryRedirect)
					return true
				}
			},
			wantErr: "did not return",
			check: func(t *testing.T, e env) {
				e.mu.Lock()
				defer e.mu.Unlock()
				if *e.foreignN != 0 {
					t.Fatal("foreign host was contacted")
				}
			},
		},
		{
			name: "https to http downgrade is refused even on loopback",
			hook: func(e env) func(http.ResponseWriter, *http.Request) bool {
				return func(w http.ResponseWriter, r *http.Request) bool {
					http.Redirect(w, r, e.plain.URL+"/obj", http.StatusFound)
					return true
				}
			},
			wantErr: "downgrades",
			check: func(t *testing.T, e env) {
				e.mu.Lock()
				defer e.mu.Unlock()
				if *e.plainN != 0 {
					t.Fatal("plain-http target was contacted")
				}
			},
		},
		{
			name: "more than three hops is refused",
			hook: func(e env) func(http.ResponseWriter, *http.Request) bool {
				return func(w http.ResponseWriter, r *http.Request) bool {
					http.Redirect(w, r, "/loop?k=x", http.StatusFound)
					return true
				}
			},
			wantErr: "too many storage redirects",
			check: func(t *testing.T, e env) {
				if n := len(e.st.recorded()); n != 4 {
					t.Fatalf("storage requests = %d, want initial + 3 hops", n)
				}
			},
		},
		{
			name: "non-http scheme redirect is refused",
			hook: func(e env) func(http.ResponseWriter, *http.Request) bool {
				return func(w http.ResponseWriter, r *http.Request) bool {
					w.Header().Set("Location", "file:///etc/passwd")
					w.WriteHeader(http.StatusFound)
					return true
				}
			},
			wantErr: "unacceptable URL",
		},
	}
	restore := AllowLoopbackHTTPForTest()
	defer restore()
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var mu sync.Mutex
			foreignN, plainN := 0, 0
			foreign := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				foreignN++
				mu.Unlock()
				_, _ = w.Write([]byte("foreign"))
			}))
			defer foreign.Close()
			plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				plainN++
				mu.Unlock()
				_, _ = w.Write([]byte("plain"))
			}))
			defer plain.Close()

			st := newFakeStorage(t)
			cp := newFakeControlPlane(t, st)
			e := env{st: st, foreign: foreign, foreignN: &foreignN, plain: plain, plainN: &plainN, mu: &mu}
			st.setHook(tc.hook(e))
			p := newTestProvider(t, cp, testDescriptor(cp, time.Now()), Options{})
			dst := filepath.Join(t.TempDir(), "o")
			err := p.Download("snapshots/s1/files/r", dst)
			if tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)) {
				t.Fatalf("Download error = %v, want refusal containing %q", err, tc.wantErr)
			}
			if tc.wantErr == "" && err != nil {
				t.Fatalf("Download: %v", err)
			}
			if tc.wantErr != "" {
				if _, statErr := os.Stat(dst); statErr == nil {
					t.Fatal("refused download left a local file")
				}
			}
			if tc.check != nil {
				tc.check(t, e)
			}
		})
	}
}

func TestControlPlaneRedirectIsNotFollowed(t *testing.T) {
	var hits int
	var mu sync.Mutex
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
	}))
	defer target.Close()
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	cp.set(func(cp *fakeControlPlane) {
		cp.resolveHook = func(_ int, _ []string, w http.ResponseWriter) bool {
			w.Header().Set("Location", target.URL+"/capture")
			w.WriteHeader(http.StatusTemporaryRedirect)
			return true
		}
	})
	p := newTestProvider(t, cp, testDescriptor(cp, time.Now()), Options{})
	if err := p.Download("snapshots/s1/files/k", filepath.Join(t.TempDir(), "o")); err == nil {
		t.Fatal("redirected resolve accepted")
	}
	mu.Lock()
	defer mu.Unlock()
	if hits != 0 {
		t.Fatal("control-plane redirect was followed with session credentials")
	}
}

func TestNewRequiresConfiguredControlPlaneOrigin(t *testing.T) {
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	d := testDescriptor(cp, time.Now())
	creds := testCredentials(cp)
	creds.ControlPlaneOrigins = []string{"https://configured-server.example"}
	if _, err := New(context.Background(), d, creds, Options{ControlClient: cp.srv.Client(), StorageClient: st.srv.Client()}); err == nil {
		t.Fatal("session base URL outside the configured control plane accepted")
	}
	creds = testCredentials(cp)
	creds.AgentToken = ""
	if _, err := New(context.Background(), d, creds, Options{ControlClient: cp.srv.Client(), StorageClient: st.srv.Client()}); err == nil {
		t.Fatal("missing agent credentials accepted")
	}
	creds = testCredentials(cp)
	creds.AgentID = "../x"
	if _, err := New(context.Background(), d, creds, Options{ControlClient: cp.srv.Client(), StorageClient: st.srv.Client()}); err == nil {
		t.Fatal("agent id with path characters accepted")
	}
	if len(cp.calls()) != 0 {
		t.Fatal("construction contacted the server")
	}
}

func TestDownloadContextCancellationStopsBody(t *testing.T) {
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	release := make(chan struct{})
	defer close(release)
	st.setHook(func(w http.ResponseWriter, r *http.Request) bool {
		w.Header().Set("Content-Length", "1048576")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("partial"))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		select {
		case <-r.Context().Done():
		case <-release:
		}
		return true
	})
	p := newTestProvider(t, cp, testDescriptor(cp, time.Now()), Options{})
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	dst := filepath.Join(t.TempDir(), "o")
	start := time.Now()
	err := p.DownloadContext(ctx, "snapshots/s1/files/stall", dst)
	if err == nil {
		t.Fatal("stalled body did not fail")
	}
	if time.Since(start) > 5*time.Second {
		t.Fatalf("cancellation took %v", time.Since(start))
	}
	if _, statErr := os.Stat(dst); statErr == nil {
		t.Fatal("cancelled download left a partial file")
	}
}

func TestCloseStopsFurtherDownloads(t *testing.T) {
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	st.put("snapshots/s1/files/k", []byte("k"))
	p := newTestProvider(t, cp, testDescriptor(cp, time.Now()), Options{})
	p.Close()
	if err := p.Download("snapshots/s1/files/k", filepath.Join(t.TempDir(), "o")); err == nil {
		t.Fatal("download after Close succeeded")
	}
}

func TestStorageTransportErrorsDoNotCarrySignedQuery(t *testing.T) {
	noSleep(t)
	closed := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	deadURL := closed.URL
	closed.Close()
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	cp.set(func(cp *fakeControlPlane) {
		cp.resolveHook = func(_ int, keys []string, w http.ResponseWriter) bool {
			_, _ = fmt.Fprintf(w, `{"objects":[{"key":%q,"method":"GET","url":%q,"headers":{},"expiresAt":%q}],"denied":[]}`,
				keys[0], deadURL+"/o?X-Amz-Signature=signed-query-value", time.Now().Add(time.Minute).UTC().Format(time.RFC3339))
			return true
		}
	})
	p := newTestProvider(t, cp, testDescriptor(cp, time.Now()), Options{})
	err := p.Download("snapshots/s1/files/k", filepath.Join(t.TempDir(), "o"))
	if err == nil {
		t.Fatal("download from a closed endpoint succeeded")
	}
	if strings.Contains(err.Error(), "signed-query-value") {
		t.Fatalf("error exposes the signed URL query: %v", err)
	}
}

func TestDescriptorValueFormattingRedactsToken(t *testing.T) {
	d := Descriptor{Token: testSessionToken, SessionID: testSessionID}
	if s := fmt.Sprintf("%v %+v %#v %s", d, d, d, d); strings.Contains(s, testSessionToken) {
		t.Fatalf("value formatting contains the token: %q", s)
	}
}
