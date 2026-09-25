package providers

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

// Verify's manifest download is bounded by a no-progress window fed by this
// callback (#6929). A provider that stops reporting would make every large
// manifest look stalled, so each instrumented provider is checked here.

func TestDownloadProgressWriter_NoCallbackReturnsWriterUnchanged(t *testing.T) {
	var buf bytes.Buffer
	if w := DownloadProgressWriter(context.Background(), &buf); w != &buf {
		t.Fatalf("got %T, want the original writer when nobody watches progress", w)
	}
}

func TestS3Provider_DownloadContext_ReportsProgress(t *testing.T) {
	body := strings.Repeat("m", 256*1024)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "262144")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(body))
	}))
	defer server.Close()

	provider := NewS3ProviderWithEndpoint("bucket", "us-east-1", server.URL, "key", "secret", "")
	var got atomic.Int64
	ctx := WithDownloadProgress(context.Background(), func(n int64) { got.Add(n) })
	if err := provider.DownloadContext(ctx, "snapshots/s/manifest.json", filepath.Join(t.TempDir(), "out")); err != nil {
		t.Fatal(err)
	}
	if got.Load() != int64(len(body)) {
		t.Fatalf("progress reported %d bytes, want %d", got.Load(), len(body))
	}
}

func TestLocalProvider_DownloadContext_ReportsProgress(t *testing.T) {
	src := filepath.Join(t.TempDir(), "src.txt")
	data := []byte(strings.Repeat("data", 4096))
	if err := os.WriteFile(src, data, 0o644); err != nil {
		t.Fatal(err)
	}
	p := NewLocalProvider(t.TempDir())
	for _, key := range []string{"s/files/plain.txt", "s/files/packed.txt.gz"} {
		if err := p.Upload(src, key); err != nil {
			t.Fatalf("upload %s: %v", key, err)
		}
		var got atomic.Int64
		ctx := WithDownloadProgress(context.Background(), func(n int64) { got.Add(n) })
		if err := p.DownloadContext(ctx, key, filepath.Join(t.TempDir(), "out")); err != nil {
			t.Fatalf("%s: %v", key, err)
		}
		if got.Load() != int64(len(data)) {
			t.Fatalf("%s: progress reported %d bytes, want %d", key, got.Load(), len(data))
		}
	}
}

// The Azure SDK reports a running total; the callback must receive deltas
// that add up to it, and a repeated or smaller total must add nothing.
func TestAzureDownloadFileOptions_ReportsDeltas(t *testing.T) {
	if azureDownloadFileOptions(context.Background()) != nil {
		t.Fatal("want nil options (SDK default) when nobody watches progress")
	}
	var got atomic.Int64
	var calls atomic.Int32
	ctx := WithDownloadProgress(context.Background(), func(n int64) {
		got.Add(n)
		calls.Add(1)
	})
	opts := azureDownloadFileOptions(ctx)
	if opts == nil || opts.Progress == nil {
		t.Fatal("want a Progress callback when progress is watched")
	}
	for _, total := range []int64{100, 250, 250, 1000} {
		opts.Progress(total)
	}
	if got.Load() != 1000 || calls.Load() != 3 {
		t.Fatalf("sum=%d calls=%d, want 1000 over 3 calls", got.Load(), calls.Load())
	}
}
