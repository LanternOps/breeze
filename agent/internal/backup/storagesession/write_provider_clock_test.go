package storagesession

import (
	"context"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

// TestWriteProviderCutoffFollowsTheLocalClock: the per-attempt cutoff is
// timed from when the URL was received, so a device clock ten minutes off
// the control plane's neither cancels every attempt nor lets an attempt run
// long past its URL.
func TestWriteProviderCutoffFollowsTheLocalClock(t *testing.T) {
	for _, tc := range []struct {
		name      string
		offset    time.Duration
		expiresIn bool
	}{
		{"device fast, expiresIn", -10 * time.Minute, true},
		{"device slow, expiresIn", 10 * time.Minute, true},
		{"device fast, Date header", -10 * time.Minute, false},
		{"device slow, Date header", 10 * time.Minute, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			shortTransferGrace(t, 200*time.Millisecond)
			b := newFakeWriteBackend(t)
			release := make(chan struct{})
			t.Cleanup(func() { close(release) })
			var held atomic.Bool
			b.set(func(b *fakeWriteBackend) {
				b.urlTTL = 2 * time.Second
				b.clockOffset = tc.offset
				b.sendExpiresIn = tc.expiresIn
				b.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
					if r.Method == http.MethodPut && held.CompareAndSwap(false, true) {
						blockUntilCancelled(r, release)
						return true
					}
					return false
				}
			})
			p := newTestWriteProvider(t, b, Options{StorageIdleTimeout: time.Minute})
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			start := time.Now()
			data := []byte("payload")
			d, err := p.UploadWithDigest(ctx, writeTempData(t, data), objKey("files/a"))
			if err != nil || d.SHA256 != digestHex(data) {
				t.Fatalf("upload: %+v %v", d, err)
			}
			if n := len(b.callsFor("objects:resolve")); n != 2 {
				t.Fatalf("resolve calls = %d, want the blocked attempt cut off once and the next to succeed", n)
			}
			if elapsed := time.Since(start); elapsed > 10*time.Second {
				t.Fatalf("attempt not cut off near its URL's expiry (%s)", elapsed)
			}
		})
	}
}
