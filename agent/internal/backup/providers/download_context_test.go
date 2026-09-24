package providers

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Every production provider must support a cancellable download (#6598):
// verification and test restore bound each transfer with a per-file deadline
// through this interface, and a provider that silently lacks it falls back to
// an uncancellable Download that one stalled object can wedge for hours.
var (
	_ ContextDownloader = (*S3Provider)(nil)
	_ ContextDownloader = (*AzureProvider)(nil)
	_ ContextDownloader = (*GCSProvider)(nil)
	_ ContextDownloader = (*B2Provider)(nil)
	_ ContextDownloader = (*LocalProvider)(nil)
	_ ContextDownloader = (*FallbackProvider)(nil)
)

// TestS3Provider_DownloadContext_MidBodyStallIsCancelled reproduces the
// #6598 stall: the S3-compatible endpoint answers the GET with headers and a
// few body bytes, then stops sending. ResponseHeaderTimeout cannot fire (the
// headers arrived), so before DownloadContext the only way out was the 2 h
// command ceiling. The caller's context deadline must now abort the body read.
func TestS3Provider_DownloadContext_MidBodyStallIsCancelled(t *testing.T) {
	release := make(chan struct{})
	var releaseOnce sync.Once
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1048576")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(strings.Repeat("x", 16)))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer server.Close()
	defer releaseOnce.Do(func() { close(release) })

	provider := NewS3ProviderWithEndpoint("bucket", "us-east-1", server.URL, "key", "secret", "")
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- provider.DownloadContext(ctx, "snapshots/s/files/big.bin", filepath.Join(t.TempDir(), "out.bin"))
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected an error from a stalled download, got nil")
		}
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("err = %v, want it to wrap context.DeadlineExceeded", err)
		}
	case <-time.After(10 * time.Second):
		releaseOnce.Do(func() { close(release) })
		t.Fatal("DownloadContext did not return after its context deadline: a mid-body stall still wedges the download")
	}
}

// ctxRecordingProvider is a minimal BackupProvider + ContextDownloader that
// records which download path was used.
type ctxRecordingProvider struct {
	mu       sync.Mutex
	calls    int
	ctxCalls int
	err      error
	block    bool
}

func (p *ctxRecordingProvider) Upload(string, string) error   { return nil }
func (p *ctxRecordingProvider) List(string) ([]string, error) { return nil, nil }
func (p *ctxRecordingProvider) Delete(string) error           { return nil }

func (p *ctxRecordingProvider) Download(_, localPath string) error {
	p.mu.Lock()
	p.calls++
	p.mu.Unlock()
	if p.err != nil {
		return p.err
	}
	return os.WriteFile(localPath, []byte("ok"), 0o644)
}

func (p *ctxRecordingProvider) DownloadContext(ctx context.Context, _, localPath string) error {
	p.mu.Lock()
	p.ctxCalls++
	p.mu.Unlock()
	if p.block {
		<-ctx.Done()
		return ctx.Err()
	}
	if p.err != nil {
		return p.err
	}
	return os.WriteFile(localPath, []byte("ok"), 0o644)
}

func TestFallbackProvider_DownloadContext_PassesContextAndStopsWhenDone(t *testing.T) {
	primary := &ctxRecordingProvider{block: true}
	secondary := &ctxRecordingProvider{}
	f := NewFallbackProvider(primary, secondary)

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	err := f.DownloadContext(ctx, "a/b", filepath.Join(t.TempDir(), "out"))
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want context.DeadlineExceeded", err)
	}
	if primary.ctxCalls != 1 || primary.calls != 0 {
		t.Fatalf("primary ctxCalls=%d calls=%d, want the context-aware path used once", primary.ctxCalls, primary.calls)
	}
	if secondary.ctxCalls != 0 || secondary.calls != 0 {
		t.Fatalf("secondary was tried after the context expired (ctxCalls=%d calls=%d)", secondary.ctxCalls, secondary.calls)
	}
}

func TestFallbackProvider_DownloadContext_FallsBackOnOrdinaryError(t *testing.T) {
	primary := &ctxRecordingProvider{err: errors.New("boom")}
	secondary := &ctxRecordingProvider{}
	f := NewFallbackProvider(primary, secondary)

	out := filepath.Join(t.TempDir(), "out")
	if err := f.DownloadContext(context.Background(), "a/b", out); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if secondary.ctxCalls != 1 {
		t.Fatalf("secondary ctxCalls = %d, want 1", secondary.ctxCalls)
	}
}

func TestLocalProvider_DownloadContext_HonoursCancelledContext(t *testing.T) {
	base := t.TempDir()
	src := filepath.Join(t.TempDir(), "src.txt")
	if err := os.WriteFile(src, []byte(strings.Repeat("data", 1024)), 0o644); err != nil {
		t.Fatal(err)
	}
	p := NewLocalProvider(base)
	for _, key := range []string{"s/files/plain.txt", "s/files/packed.txt.gz"} {
		if err := p.Upload(src, key); err != nil {
			t.Fatalf("upload %s: %v", key, err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		err := p.DownloadContext(ctx, key, filepath.Join(t.TempDir(), "out"))
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("%s: err = %v, want context.Canceled", key, err)
		}
		// The plain Download still works for the same object.
		if err := p.Download(key, filepath.Join(t.TempDir(), "out2")); err != nil {
			t.Fatalf("%s: plain Download: %v", key, err)
		}
	}
}
