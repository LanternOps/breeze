package storagesession

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

func ceilDiv(a, b int) int { return (a + b - 1) / b }

// A large file is uploaded with few control-plane calls: part URLs are
// resolved in batches, never one call per part.
func TestWriteProviderLargeFileBatchesPartURLs(t *testing.T) {
	if testing.Short() {
		t.Skip("uploads 1.2 GiB")
	}
	b := newFakeWriteBackend(t)
	b.set(func(b *fakeWriteBackend) { b.discardBodies = true })
	p := newTestWriteProvider(t, b, Options{})
	const size = 1200 << 20 // 1.2 GiB
	src := filepath.Join(t.TempDir(), "big.bin")
	f, err := os.Create(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(size); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	d, err := p.UploadWithDigest(context.Background(), src, objKey("files/big.bin"))
	if err != nil || d.Size != size {
		t.Fatalf("upload: %+v %v", d, err)
	}
	parts := ceilDiv(size, 64<<20)
	resolves := len(b.callsFor("objects:resolve"))
	total := resolves + len(b.callsFor("multipart:create")) + len(b.callsFor("multipart:complete"))
	t.Logf("1.2 GiB, %d parts: %d resolves, %d control-plane calls", parts, resolves, total)
	if resolves > ceilDiv(parts, 100)+2 {
		t.Fatalf("%d resolves for %d parts", resolves, parts)
	}
}

// Many small files cost about one control-plane call per maxBatch files.
func TestWriteProviderSmallFilesBatchPutURLs(t *testing.T) {
	n := 20000
	if testing.Short() {
		n = 2000
	}
	b := newFakeWriteBackend(t)
	p := newTestWriteProvider(t, b, Options{})
	dir := t.TempDir()
	plan := make([]providers.PlannedUpload, n)
	for i := range plan {
		local := filepath.Join(dir, fmt.Sprintf("f%05d", i))
		if err := os.WriteFile(local, []byte{byte(i)}, 0o600); err != nil {
			t.Fatal(err)
		}
		plan[i] = providers.PlannedUpload{LocalPath: local, Key: objKey(fmt.Sprintf("files/f%05d", i))}
	}
	p.PrepareUploads(plan)
	for _, e := range plan {
		if _, err := p.UploadWithDigest(context.Background(), e.LocalPath, e.Key); err != nil {
			t.Fatalf("upload %s: %v", e.Key, err)
		}
	}
	resolves := len(b.callsFor("objects:resolve"))
	t.Logf("%d small files: %d resolves", n, resolves)
	if resolves > ceilDiv(n, 100)+2 {
		t.Fatalf("%d resolves for %d files", resolves, n)
	}
}

// Stored-object checks read back through batched GET URLs.
func TestWriteProviderPlannedDownloadsAreBatched(t *testing.T) {
	b := newFakeWriteBackend(t)
	p := newTestWriteProvider(t, b, Options{})
	var keys []string
	for i := 0; i < 250; i++ {
		k := objKey(fmt.Sprintf("files/g%03d", i))
		b.put(k, []byte{byte(i)})
		keys = append(keys, k)
	}
	p.PrepareDownloads(keys)
	for _, k := range keys {
		if _, err := p.StoredObjectDigest(context.Background(), k); err != nil {
			t.Fatal(err)
		}
	}
	if resolves := len(b.callsFor("objects:resolve")); resolves > ceilDiv(len(keys), 100)+1 {
		t.Fatalf("%d resolves for %d reads", resolves, len(keys))
	}
}

func rateLimited(times int, retryAfter string) func(op string, _ map[string]any, w http.ResponseWriter) bool {
	var mu sync.Mutex
	n := 0
	return func(op string, _ map[string]any, w http.ResponseWriter) bool {
		if op != "objects:resolve" {
			return false
		}
		mu.Lock()
		defer mu.Unlock()
		if times >= 0 && n >= times {
			return false
		}
		n++
		if retryAfter != "" {
			w.Header().Set("Retry-After", retryAfter)
		}
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "rate limited"})
		return true
	}
}

func TestWriteProviderRateLimitHonoursRetryAfter(t *testing.T) {
	waits := noSleep(t)
	b := newFakeWriteBackend(t)
	b.set(func(b *fakeWriteBackend) { b.controlHook = rateLimited(2, "7") })
	p := newTestWriteProvider(t, b, Options{})
	if _, err := p.UploadWithDigest(context.Background(), writeTempData(t, []byte("x")), objKey("files/a")); err != nil {
		t.Fatal(err)
	}
	if len(*waits) != 2 || (*waits)[0] != 7*time.Second || (*waits)[1] != 7*time.Second {
		t.Fatalf("waits = %v, want two 7 s Retry-After waits", *waits)
	}
}

func TestWriteProviderRateLimitBacksOffExponentially(t *testing.T) {
	for _, retryAfter := range []string{"", "1"} {
		t.Run("Retry-After="+retryAfter, func(t *testing.T) {
			waits := noSleep(t)
			b := newFakeWriteBackend(t)
			b.set(func(b *fakeWriteBackend) { b.controlHook = rateLimited(5, retryAfter) })
			p := newTestWriteProvider(t, b, Options{})
			if _, err := p.UploadWithDigest(context.Background(), writeTempData(t, []byte("x")), objKey("files/a")); err != nil {
				t.Fatal(err)
			}
			w := *waits
			if len(w) != 5 {
				t.Fatalf("waits = %v", w)
			}
			for i := 1; i < len(w); i++ {
				if w[i] <= w[i-1] {
					t.Fatalf("backoff did not grow: %v", w)
				}
			}
			if w[4] < 8*time.Second {
				t.Fatalf("still retrying every few seconds: %v", w)
			}
		})
	}
}

func TestWriteProviderLongThrottleEndsTheSession(t *testing.T) {
	noSleep(t)
	b := newFakeWriteBackend(t)
	b.set(func(b *fakeWriteBackend) { b.controlHook = rateLimited(-1, "60") })
	p := newTestWriteProvider(t, b, Options{})
	src := writeTempData(t, []byte("x"))
	var err error
	for i := 0; i < 10 && !errors.Is(err, ErrSessionUnavailable); i++ {
		_, err = p.UploadWithDigest(context.Background(), src, objKey("files/a"))
	}
	if !errors.Is(err, ErrSessionUnavailable) {
		t.Fatalf("a throttle that never ends did not end the session: %v", err)
	}
	before := len(b.callsFor("objects:resolve"))
	if _, err := p.UploadWithDigest(context.Background(), src, objKey("files/a")); err == nil {
		t.Fatal("upload after the session ended succeeded")
	}
	if len(b.callsFor("objects:resolve")) != before {
		t.Fatal("kept calling the control plane after the session ended")
	}
}

func TestControlCallsArePaced(t *testing.T) {
	var mu sync.Mutex
	var paced []time.Duration
	orig := paceSleep
	paceSleep = func(_ context.Context, d time.Duration) error {
		mu.Lock()
		paced = append(paced, d)
		mu.Unlock()
		return nil
	}
	t.Cleanup(func() { paceSleep = orig })
	b := newFakeWriteBackend(t)
	p := newTestWriteProvider(t, b, Options{ControlCallsPerMinute: 60})
	for i := 0; i < controlCallBurst+5; i++ {
		if _, err := p.List(objKey("files/")); err != nil {
			t.Fatal(err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(paced) < 5 {
		t.Fatalf("paced %d of %d calls; the calls after the burst must wait", len(paced), controlCallBurst+5)
	}
	for _, d := range paced {
		if d <= 0 || d > 10*time.Second {
			t.Fatalf("pace waits = %v", paced)
		}
	}
}
