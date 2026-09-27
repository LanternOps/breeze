package storagesession

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

func TestNewComparesOriginsWithDefaultPortsNormalised(t *testing.T) {
	cases := []struct {
		name       string
		baseURL    string
		configured string
		accept     bool
	}{
		{"session without port, configured with :443", "https://cp.example", "https://cp.example:443", true},
		{"session with :443, configured without port", "https://cp.example:443", "https://cp.example", true},
		{"session with :443 and slash, configured with path", "https://cp.example:443/", "https://cp.example/api", true},
		{"host case differs", "https://CP.Example", "HTTPS://cp.example:443", true},
		{"ipv6 with and without :443", "https://[::1]:443", "https://[::1]", true},
		{"non-default port differs", "https://cp.example:8443", "https://cp.example", false},
		{"non-default port vs :443", "https://cp.example:8443", "https://cp.example:443", false},
		{"scheme differs", "https://cp.example", "http://cp.example", false},
		{"https on port 80 vs plain http default", "https://cp.example:80", "http://cp.example", false},
		{"different host", "https://cp.example", "https://cp.example.other-origin.example", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			now := time.Now()
			d := &Descriptor{
				Version:      ProtocolVersion,
				SessionID:    testSessionID,
				Token:        testSessionToken,
				BaseURL:      tc.baseURL,
				ExpiresAt:    now.Add(10 * time.Minute).UTC().Format(time.RFC3339),
				Deadline:     now.Add(time.Hour).UTC().Format(time.RFC3339),
				Capabilities: []string{CapabilityResolveBatch},
				MaxBatch:     10,
			}
			p, err := New(context.Background(), d, Credentials{
				AgentID:             testAgentID,
				AgentToken:          testAgentToken,
				ControlPlaneOrigins: []string{tc.configured},
			}, Options{})
			if p != nil {
				defer p.Close()
			}
			if tc.accept && err != nil {
				t.Fatalf("New rejected equivalent origins: %v", err)
			}
			if !tc.accept && err == nil {
				t.Fatal("New accepted a different origin")
			}
		})
	}
}

func TestPlannedEmptyKeysAreNeverSentToResolve(t *testing.T) {
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	keys := []string{"snapshots/s1/files/a", "", "snapshots/s1/files/b"}
	st.put(keys[0], []byte("a"))
	st.put(keys[2], []byte("b"))
	p := newTestProvider(t, cp, testDescriptor(cp, time.Now()), Options{})
	p.PrepareDownloads(keys)
	dir := t.TempDir()
	if err := p.Download(keys[0], filepath.Join(dir, "a")); err != nil {
		t.Fatalf("a: %v", err)
	}
	if err := p.Download("", filepath.Join(dir, "empty")); err == nil {
		t.Fatal("empty key must fail locally")
	}
	if err := p.Download(keys[2], filepath.Join(dir, "b")); err != nil {
		t.Fatalf("b: %v", err)
	}
	calls := cp.calls()
	if len(calls) != 1 {
		t.Fatalf("resolve calls = %d, want 1 batch", len(calls))
	}
	for _, c := range calls {
		for _, k := range c.keys {
			if k == "" {
				t.Fatalf("resolve batch carried an empty key: %q", c.keys)
			}
		}
	}
}

func TestResolveAnswerOmittingAPlannedNeighbourIsRejected(t *testing.T) {
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	keys := []string{"snapshots/s1/files/a", "snapshots/s1/files/b"}
	for _, k := range keys {
		st.put(k, []byte("v"))
	}
	cp.set(func(cp *fakeControlPlane) {
		cp.resolveHook = func(_ int, req []string, w http.ResponseWriter) bool {
			if len(req) != 2 {
				t.Errorf("resolve keys = %q, want the planned pair", req)
			}
			// Answers the key being downloaded but silently drops its
			// planned neighbour.
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"objects":[{"key":"` + req[0] + `","method":"GET","url":"` + st.urlFor(req[0], 1) +
				`","headers":{},"expiresAt":"` + time.Now().Add(time.Minute).UTC().Format(time.RFC3339) + `"}],"denied":[]}`))
			return true
		}
	})
	p := newTestProvider(t, cp, testDescriptor(cp, time.Now()), Options{})
	p.PrepareDownloads(keys)
	if err := p.Download(keys[0], filepath.Join(t.TempDir(), "a")); err == nil {
		t.Fatal("a resolve answer that leaves a requested key unanswered was accepted")
	}
	if len(st.recorded()) != 0 {
		t.Fatal("storage contacted on an incomplete resolve answer")
	}
}

func TestResolveAnswerCarryingSessionHeaderIsRejected(t *testing.T) {
	for _, name := range []string{SessionHeader, strings.ToLower(SessionHeader), " " + strings.ToUpper(SessionHeader)} {
		t.Run(name, func(t *testing.T) {
			st := newFakeStorage(t)
			cp := newFakeControlPlane(t, st)
			key := "snapshots/s1/files/h"
			st.put(key, []byte("h"))
			cp.set(func(cp *fakeControlPlane) {
				cp.resolveHook = func(_ int, req []string, w http.ResponseWriter) bool {
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(`{"objects":[{"key":"` + req[0] + `","method":"GET","url":"` + st.urlFor(req[0], 1) +
						`","headers":{"` + name + `":"x"},"expiresAt":"` + time.Now().Add(time.Minute).UTC().Format(time.RFC3339) + `"}],"denied":[]}`))
					return true
				}
			})
			p := newTestProvider(t, cp, testDescriptor(cp, time.Now()), Options{})
			if err := p.Download(key, filepath.Join(t.TempDir(), "o")); err == nil {
				t.Fatal("resolve answer setting the session header on storage requests was accepted")
			}
			if len(st.recorded()) != 0 {
				t.Fatal("storage contacted on a rejected resolve answer")
			}
		})
	}
}

func (p *Provider) leaseExpiry() time.Time {
	p.leaseMu.Lock()
	defer p.leaseMu.Unlock()
	return p.leaseExpiresAt
}

func TestRenewedLeaseIsClampedToDeadline(t *testing.T) {
	clock := &fakeClock{now: time.Now().Truncate(time.Second)}
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	d := testDescriptor(cp, clock.Now())
	d.ExpiresAt = clock.Now().Add(90 * time.Second).UTC().Format(time.RFC3339)
	d.Deadline = clock.Now().Add(20 * time.Minute).UTC().Format(time.RFC3339)
	deadline, _ := time.Parse(time.RFC3339, d.Deadline)
	cp.set(func(cp *fakeControlPlane) {
		cp.now = clock.Now
		cp.renewedExpiry = deadline.Add(time.Hour)
	})
	key := "snapshots/s1/files/clamp"
	st.put(key, []byte("c"))
	p := newTestProvider(t, cp, d, Options{Now: clock.Now, RenewCheckInterval: time.Hour})
	clock.Advance(70 * time.Second)
	if err := p.Download(key, filepath.Join(t.TempDir(), "o")); err != nil {
		t.Fatalf("Download: %v", err)
	}
	if cp.renews() != 1 {
		t.Fatalf("renew calls = %d, want 1", cp.renews())
	}
	if got := p.leaseExpiry(); !got.Equal(deadline) {
		t.Fatalf("lease expiry after renew = %s, want clamped to deadline %s", got, deadline)
	}
}

func TestRenewAnswerInThePastLeavesLeaseUnchanged(t *testing.T) {
	clock := &fakeClock{now: time.Now().Truncate(time.Second)}
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	d := testDescriptor(cp, clock.Now())
	d.ExpiresAt = clock.Now().Add(90 * time.Second).UTC().Format(time.RFC3339)
	initial, _ := time.Parse(time.RFC3339, d.ExpiresAt)
	cp.set(func(cp *fakeControlPlane) {
		cp.now = clock.Now
		cp.renewedExpiry = clock.Now().Add(-time.Minute)
	})
	key := "snapshots/s1/files/past"
	st.put(key, []byte("p"))
	p := newTestProvider(t, cp, d, Options{Now: clock.Now, RenewCheckInterval: time.Hour})
	clock.Advance(70 * time.Second)
	if err := p.Download(key, filepath.Join(t.TempDir(), "o")); err != nil {
		t.Fatalf("Download: %v", err)
	}
	if got := p.leaseExpiry(); !got.Equal(initial) {
		t.Fatalf("lease expiry = %s, want unchanged %s", got, initial)
	}
}

// stallingStorage serves key with a body that stops after a few bytes for
// the first `stalls` requests, then serves it whole.
func stallingStorage(t *testing.T, st *fakeStorage, key string, data []byte, stalls int32, beforeHeaders bool) *atomic.Int32 {
	t.Helper()
	var served atomic.Int32
	release := make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	st.setHook(func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Query().Get("k") != key {
			return false
		}
		n := served.Add(1)
		if n > stalls {
			return false
		}
		if !beforeHeaders {
			w.Header().Set("Content-Length", "1048576")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(data[:1])
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}
		select {
		case <-r.Context().Done():
		case <-release:
		}
		return true
	})
	return &served
}

func TestStalledStorageTransferIsRetriedWithAFreshURL(t *testing.T) {
	for _, beforeHeaders := range []bool{false, true} {
		name := "body"
		if beforeHeaders {
			name = "headers"
		}
		t.Run(name, func(t *testing.T) {
			st := newFakeStorage(t)
			cp := newFakeControlPlane(t, st)
			key := "snapshots/s1/files/stall"
			data := []byte("complete-object")
			st.put(key, data)
			served := stallingStorage(t, st, key, data, 1, beforeHeaders)
			p := newTestProvider(t, cp, testDescriptor(cp, time.Now()), Options{StorageIdleTimeout: 150 * time.Millisecond})
			dst := filepath.Join(t.TempDir(), "o")
			start := time.Now()
			if err := p.Download(key, dst); err != nil {
				t.Fatalf("Download: %v", err)
			}
			if elapsed := time.Since(start); elapsed > 10*time.Second {
				t.Fatalf("stall recovery took %v", elapsed)
			}
			if got := readFile(t, dst); got != string(data) {
				t.Fatalf("content = %q", got)
			}
			if got := served.Load(); got != 2 {
				t.Fatalf("storage requests = %d, want 2", got)
			}
			if got := len(cp.calls()); got != 2 {
				t.Fatalf("resolve calls = %d, want a fresh URL for the retry", got)
			}
			reqs := st.recorded()
			if reqs[0].URL.RawQuery == reqs[len(reqs)-1].URL.RawQuery {
				t.Fatal("retry reused the stalled URL")
			}
		})
	}
}

func TestPersistentlyStalledStorageTransferGivesUp(t *testing.T) {
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	key := "snapshots/s1/files/stuck"
	data := []byte("never-finishes")
	st.put(key, data)
	served := stallingStorage(t, st, key, data, 1000, false)
	p := newTestProvider(t, cp, testDescriptor(cp, time.Now()), Options{StorageIdleTimeout: 100 * time.Millisecond})
	dst := filepath.Join(t.TempDir(), "o")
	err := p.Download(key, dst)
	if err == nil {
		t.Fatal("a transfer that never progresses must fail")
	}
	if errors.Is(err, providers.ErrObjectNotFound) || errors.Is(err, ErrSessionUnavailable) {
		t.Fatalf("stall error = %v, want a transfer failure, not absence or a lost session", err)
	}
	if got := served.Load(); got != int32(1+maxStallRetries) {
		t.Fatalf("storage requests = %d, want %d", got, 1+maxStallRetries)
	}
	if _, statErr := os.Stat(dst); statErr == nil {
		t.Fatal("stalled download left a partial file")
	}
	// The session itself is still usable for other objects.
	other := "snapshots/s1/files/fine"
	st.put(other, []byte("ok"))
	if err := p.Download(other, filepath.Join(t.TempDir(), "f")); err != nil {
		t.Fatalf("session unusable after a stalled object: %v", err)
	}
}

func TestSlowButProgressingTransferIsNotCutOff(t *testing.T) {
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	key := "snapshots/s1/files/slow"
	const chunks = 8
	st.setHook(func(w http.ResponseWriter, r *http.Request) bool {
		w.Header().Set("Content-Length", "8")
		w.WriteHeader(http.StatusOK)
		for i := 0; i < chunks; i++ {
			_, _ = w.Write([]byte("s"))
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			select {
			case <-r.Context().Done():
				return true
			case <-time.After(60 * time.Millisecond):
			}
		}
		return true
	})
	// Total transfer (~480ms) is well beyond the idle timeout, but bytes keep
	// arriving, so it must complete on the first URL.
	p := newTestProvider(t, cp, testDescriptor(cp, time.Now()), Options{StorageIdleTimeout: 200 * time.Millisecond})
	dst := filepath.Join(t.TempDir(), "o")
	if err := p.Download(key, dst); err != nil {
		t.Fatalf("Download: %v", err)
	}
	if got := readFile(t, dst); got != strings.Repeat("s", chunks) {
		t.Fatalf("content = %q", got)
	}
	if got := len(st.recorded()); got != 1 {
		t.Fatalf("storage requests = %d, want 1", got)
	}
	if got := len(cp.calls()); got != 1 {
		t.Fatalf("resolve calls = %d, want 1", got)
	}
}
