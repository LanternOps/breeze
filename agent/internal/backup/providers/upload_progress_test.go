package providers

import (
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// progressRecorder collects every offset an upload-progress callback sees.
// Safe for concurrent use: providers may report from SDK goroutines.
type progressRecorder struct {
	mu      sync.Mutex
	offsets []int64
}

func (r *progressRecorder) record(off int64) {
	r.mu.Lock()
	r.offsets = append(r.offsets, off)
	r.mu.Unlock()
}

func (r *progressRecorder) snapshot() (calls int, max int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, o := range r.offsets {
		if o > max {
			max = o
		}
	}
	return len(r.offsets), max
}

func writeUploadSource(t *testing.T, size int) (string, []byte) {
	t.Helper()
	data := bytes.Repeat([]byte("0123456789abcdef"), size/16+1)[:size]
	p := filepath.Join(t.TempDir(), "src.bin")
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatalf("write source: %v", err)
	}
	return p, data
}

func TestUploadProgressSource_NoCallbackReturnsFileUnwrapped(t *testing.T) {
	p, _ := writeUploadSource(t, 16)
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if got := uploadProgressSource(context.Background(), f); got != uploadSource(f) {
		t.Fatalf("without a callback the source must be the *os.File itself (keeps SDK fast paths), got %T", got)
	}
}

func TestUploadProgressSource_ReportsReadSeekAndReadAtOffsets(t *testing.T) {
	p, data := writeUploadSource(t, 1000)
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	rec := &progressRecorder{}
	src := uploadProgressSource(WithUploadProgress(context.Background(), rec.record), f)

	buf := make([]byte, 300)
	if _, err := io.ReadFull(src, buf); err != nil {
		t.Fatal(err)
	}
	if _, max := rec.snapshot(); max != 300 {
		t.Fatalf("after reading 300 bytes want offset 300, got %d", max)
	}
	// A rewind (the S3 SDK seeks back after hashing the payload) must not be
	// reported as progress beyond what was already reached; reading again
	// from 0 reports the real position, not a cumulative 600.
	if _, err := src.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(src, buf); err != nil {
		t.Fatal(err)
	}
	rec.mu.Lock()
	last := rec.offsets[len(rec.offsets)-1]
	rec.mu.Unlock()
	if last != 300 {
		t.Fatalf("re-reading after a rewind must report the absolute offset 300, got %d", last)
	}
	// ReadAt (the S3 multipart uploader reads parts through ReaderAt) reports
	// the end offset of the chunk it read.
	if _, err := src.ReadAt(buf, 700); err != nil {
		t.Fatal(err)
	}
	if _, max := rec.snapshot(); max != 1000 {
		t.Fatalf("ReadAt ending at 1000 must report 1000, got %d", max)
	}
	if !bytes.Equal(buf, data[700:]) {
		t.Fatal("ReadAt returned the wrong bytes")
	}
}

func TestLocalProvider_UploadContextReportsUploadProgress(t *testing.T) {
	const size = 256 * 1024 // several io.Copy buffers
	for _, remote := range []string{"snap/files/a.bin", "snap/files/a.bin.gz"} {
		t.Run(remote, func(t *testing.T) {
			src, data := writeUploadSource(t, size)
			base := t.TempDir()
			provider := NewLocalProvider(base)
			rec := &progressRecorder{}
			ctx := WithUploadProgress(context.Background(), rec.record)
			if err := provider.UploadContext(ctx, src, remote); err != nil {
				t.Fatalf("upload: %v", err)
			}
			calls, max := rec.snapshot()
			if calls < 2 {
				t.Fatalf("want in-file progress (several callbacks) for a %d-byte file, got %d", size, calls)
			}
			if max != size {
				t.Fatalf("final reported offset = %d, want %d", max, size)
			}
			got, err := os.ReadFile(filepath.Join(base, remote))
			if err != nil {
				t.Fatal(err)
			}
			if filepath.Ext(remote) == ".gz" {
				zr, err := gzip.NewReader(bytes.NewReader(got))
				if err != nil {
					t.Fatal(err)
				}
				if got, err = io.ReadAll(zr); err != nil {
					t.Fatal(err)
				}
			}
			if !bytes.Equal(got, data) {
				t.Fatal("uploaded content differs from source")
			}
		})
	}
}

func TestS3Provider_UploadContextReportsUploadProgress(t *testing.T) {
	const size = 200 * 1024
	src, data := writeUploadSource(t, size)

	var mu sync.Mutex
	var received []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		received = body
		mu.Unlock()
		w.Header().Set("ETag", `"etag"`)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	provider := NewS3ProviderWithEndpoint("bucket", "us-east-1", server.URL, "key", "secret", "")
	rec := &progressRecorder{}
	ctx := WithUploadProgress(context.Background(), rec.record)
	if err := provider.UploadContext(ctx, src, "snap/files/a.bin"); err != nil {
		t.Fatalf("upload: %v", err)
	}
	if _, max := rec.snapshot(); max != size {
		t.Fatalf("final reported offset = %d, want %d", max, size)
	}
	mu.Lock()
	defer mu.Unlock()
	if !bytes.Equal(received, data) {
		t.Fatalf("server received %d bytes, want the %d-byte source unchanged", len(received), size)
	}
}

func TestAzureUploadFileOptions_ForwardsProgressOnlyWhenWatched(t *testing.T) {
	if azureUploadFileOptions(context.Background()) != nil {
		t.Fatal("without a callback the SDK default (nil options) must be kept")
	}
	rec := &progressRecorder{}
	opts := azureUploadFileOptions(WithUploadProgress(context.Background(), rec.record))
	if opts == nil || opts.Progress == nil {
		t.Fatal("a watched upload must set the SDK Progress hook")
	}
	opts.Progress(4096)
	if _, max := rec.snapshot(); max != 4096 {
		t.Fatalf("Progress(4096) must reach the callback as offset 4096, got %d", max)
	}
}
