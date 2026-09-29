package providers

import (
	"time"

	"bytes"
	"cloud.google.com/go/storage"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/bloberror"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func hexSHA256(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// fakeS3 is an in-memory S3-compatible endpoint: PutObject, GetObject and the
// three multipart calls, keyed by request path.
type fakeS3 struct {
	mu        sync.Mutex
	objects   map[string][]byte
	parts     map[string]map[int][]byte // uploadId -> part number -> bytes
	putCount  int
	partCount int
	// failPuts makes the first N PutObject requests answer 500 after
	// reading the body, so the SDK retries.
	failPuts int32
	// failParts makes the first N UploadPart requests answer 500.
	failParts int32
	// onPart runs as each part arrives (before it is stored).
	onPart func()
}

func newFakeS3(t *testing.T) (*fakeS3, *httptest.Server) {
	t.Helper()
	f := &fakeS3{objects: map[string][]byte{}, parts: map[string]map[int][]byte{}}
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(srv.Close)
	return f, srv
}

func (f *fakeS3) serve(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	key := r.URL.Path
	switch {
	case r.Method == http.MethodPost && q.Has("uploads"):
		id := fmt.Sprintf("upload-%d", len(f.parts)+1)
		f.mu.Lock()
		f.parts[id] = map[int][]byte{}
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/xml")
		_, _ = fmt.Fprintf(w, `<InitiateMultipartUploadResult><Bucket>bucket</Bucket><Key>%s</Key><UploadId>%s</UploadId></InitiateMultipartUploadResult>`, key, id)
	case r.Method == http.MethodPut && q.Get("uploadId") != "":
		body, _ := io.ReadAll(r.Body)
		if f.onPart != nil {
			f.onPart()
		}
		if atomic.AddInt32(&f.failParts, -1) >= 0 {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = io.WriteString(w, `<Error><Code>InternalError</Code><Message>try again</Message></Error>`)
			return
		}
		n, _ := strconv.Atoi(q.Get("partNumber"))
		f.mu.Lock()
		f.parts[q.Get("uploadId")][n] = body
		f.partCount++
		f.mu.Unlock()
		w.Header().Set("ETag", fmt.Sprintf(`"part-%d"`, n))
	case r.Method == http.MethodPost && q.Get("uploadId") != "":
		_, _ = io.ReadAll(r.Body)
		f.mu.Lock()
		parts := f.parts[q.Get("uploadId")]
		nums := make([]int, 0, len(parts))
		for n := range parts {
			nums = append(nums, n)
		}
		sort.Ints(nums)
		var all []byte
		for _, n := range nums {
			all = append(all, parts[n]...)
		}
		f.objects[key] = all
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/xml")
		_, _ = fmt.Fprintf(w, `<CompleteMultipartUploadResult><Bucket>bucket</Bucket><Key>%s</Key><ETag>"done"</ETag></CompleteMultipartUploadResult>`, key)
	case r.Method == http.MethodDelete && q.Get("uploadId") != "":
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodPut:
		body, _ := io.ReadAll(r.Body)
		if atomic.AddInt32(&f.failPuts, -1) >= 0 {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = io.WriteString(w, `<Error><Code>InternalError</Code><Message>try again</Message></Error>`)
			return
		}
		f.mu.Lock()
		f.objects[key] = body
		f.putCount++
		f.mu.Unlock()
		w.Header().Set("ETag", `"etag"`)
	case r.Method == http.MethodGet:
		f.mu.Lock()
		body, ok := f.objects[key]
		f.mu.Unlock()
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			_ = xml.NewEncoder(w).Encode(struct {
				XMLName xml.Name `xml:"Error"`
				Code    string   `xml:"Code"`
			}{Code: "NoSuchKey"})
			return
		}
		_, _ = w.Write(body)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (f *fakeS3) only(t *testing.T) []byte {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.objects) != 1 {
		t.Fatalf("want exactly one stored object, got %d", len(f.objects))
	}
	for _, b := range f.objects {
		return b
	}
	return nil
}

func downloadBytes(t *testing.T, p BackupProvider, key string) []byte {
	t.Helper()
	dst := filepath.Join(t.TempDir(), "dl")
	if err := p.Download(key, dst); err != nil {
		t.Fatalf("download %s: %v", key, err)
	}
	b, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestS3Provider_UploadWithDigestDescribesStoredObject(t *testing.T) {
	store, srv := newFakeS3(t)
	src, data := writeUploadSource(t, 300*1024)
	p := NewS3ProviderWithEndpoint("bucket", "us-east-1", srv.URL, "key", "secret", "")

	var du DigestUploader = p
	got, err := du.UploadWithDigest(context.Background(), src, "snapshots/s1/files/a.bin")
	if err != nil {
		t.Fatalf("UploadWithDigest: %v", err)
	}
	stored := store.only(t)
	if got.SHA256 != hexSHA256(stored) || got.Size != int64(len(stored)) {
		t.Fatalf("digest %s/%d does not describe the stored object %s/%d", got.SHA256, got.Size, hexSHA256(stored), len(stored))
	}
	if got.SHA256 != hexSHA256(data) {
		t.Fatal("digest does not match the unchanged source")
	}
	if dl := downloadBytes(t, p, "snapshots/s1/files/a.bin"); hexSHA256(dl) != got.SHA256 {
		t.Fatal("Download does not return the digested bytes")
	}
}

// The SDK re-sends a retried PutObject from the start of the body; the digest
// must describe the attempt that was stored, not the sum of every pass.
func TestS3Provider_UploadWithDigestAfterRetry(t *testing.T) {
	store, srv := newFakeS3(t)
	store.failPuts = 1
	src, data := writeUploadSource(t, 64*1024)
	p := NewS3ProviderWithEndpoint("bucket", "us-east-1", srv.URL, "key", "secret", "")

	got, err := p.UploadWithDigest(context.Background(), src, "snapshots/s1/files/a.bin")
	if err != nil {
		t.Fatalf("UploadWithDigest: %v", err)
	}
	if atomic.LoadInt32(&store.failPuts) >= 0 {
		t.Fatal("the fake endpoint never refused a request; the retry path did not run")
	}
	if got.SHA256 != hexSHA256(data) || got.Size != int64(len(data)) {
		t.Fatalf("digest after a retried request = %s/%d, want %s/%d", got.SHA256, got.Size, hexSHA256(data), len(data))
	}
	if got.SHA256 != hexSHA256(store.only(t)) {
		t.Fatal("digest does not describe the stored object")
	}
}

func TestS3Provider_UploadWithDigestMultipart(t *testing.T) {
	restore := setS3MultipartThresholdForTest(1 << 20)
	defer restore()
	store, srv := newFakeS3(t)
	src, data := writeUploadSource(t, 12<<20)
	p := NewS3ProviderWithEndpoint("bucket", "us-east-1", srv.URL, "key", "secret", "")

	got, err := p.UploadWithDigest(context.Background(), src, "snapshots/s1/files/big.bin")
	if err != nil {
		t.Fatalf("UploadWithDigest: %v", err)
	}
	store.mu.Lock()
	parts := store.partCount
	store.mu.Unlock()
	if parts < 2 {
		t.Fatalf("expected a multipart upload with several parts, got %d part(s)", parts)
	}
	stored := store.only(t)
	if !bytes.Equal(stored, data) {
		t.Fatal("reassembled object differs from the source")
	}
	if got.SHA256 != hexSHA256(stored) || got.Size != int64(len(stored)) {
		t.Fatalf("multipart digest %s/%d does not describe the stored object", got.SHA256, got.Size)
	}
}

func TestS3MultipartPartSizeStaysWithinPartLimit(t *testing.T) {
	for _, size := range []int64{0, 5 << 20, 100 << 20, 50 << 30, 500 << 30, 1 << 40, 2 << 40, 5 << 40} {
		part, conc := s3SequentialPartPlan(size)
		if part < 5<<20 {
			t.Fatalf("size %d: part size %d under the 5 MiB minimum", size, part)
		}
		if size > 0 && (size+part-1)/part > 9000 {
			t.Fatalf("size %d: %d parts leaves no headroom under the 10000-part limit", size, (size+part-1)/part)
		}
		if conc < 1 || conc > 5 {
			t.Fatalf("size %d: concurrency %d out of range", size, conc)
		}
		// The documented bound, concurrency 1 included: the budget, or four
		// parts once parts outgrow it.
		if got, bound := s3SequentialBufferedBytes(size), max(int64(s3SequentialMemoryBudget), 4*part); got > bound {
			t.Fatalf("size %d: %d buffered bytes over the documented bound %d", size, got, bound)
		}
		if size <= 500<<30 && s3SequentialBufferedBytes(size) > s3SequentialMemoryBudget {
			t.Fatalf("size %d: up to 500 GiB the buffered parts must stay within %d, got %d", size, s3SequentialMemoryBudget, s3SequentialBufferedBytes(size))
		}
	}
}

// A file that cannot change while the backup runs (a database or VM export
// the helper wrote itself) is hashed in one read and then uploaded through
// the SDK's unbuffered ranged-read path.
func TestS3Provider_ImmutableLargeUploadIsUnbufferedAndDigested(t *testing.T) {
	restore := setS3MultipartThresholdForTest(1 << 20)
	defer restore()
	var modes []string
	restoreHook := setLargeDigestUploadHookForTest(func(mode string) { modes = append(modes, mode) })
	defer restoreHook()
	store, srv := newFakeS3(t)
	store.failParts = 1 // one part retried
	src, data := writeUploadSource(t, 12<<20)
	p := NewS3ProviderWithEndpoint("bucket", "us-east-1", srv.URL, "key", "secret", "")

	got, err := p.UploadWithDigest(WithImmutableSource(context.Background()), src, "snapshots/s1/files/disk.vhdx")
	if err != nil {
		t.Fatalf("UploadWithDigest: %v", err)
	}
	if len(modes) != 1 || modes[0] != "immutable" {
		t.Fatalf("upload mode = %v, want [immutable]", modes)
	}
	if atomic.LoadInt32(&store.failParts) >= 0 {
		t.Fatal("no part was refused; the part retry did not run")
	}
	stored := store.only(t)
	if !bytes.Equal(stored, data) || got.SHA256 != hexSHA256(data) || got.Size != int64(len(data)) {
		t.Fatalf("digest %s/%d does not describe the stored object", got.SHA256, got.Size)
	}
}

func TestS3Provider_ImmutableSourceChangedDuringUploadFails(t *testing.T) {
	restore := setS3MultipartThresholdForTest(1 << 20)
	defer restore()
	store, srv := newFakeS3(t)
	src, _ := writeUploadSource(t, 12<<20)
	var once sync.Once
	store.onPart = func() {
		once.Do(func() {
			f, err := os.OpenFile(src, os.O_APPEND|os.O_WRONLY, 0o644)
			if err == nil {
				_, _ = f.WriteString("more")
				_ = f.Close()
			}
		})
	}
	p := NewS3ProviderWithEndpoint("bucket", "us-east-1", srv.URL, "key", "secret", "")
	if _, err := p.UploadWithDigest(WithImmutableSource(context.Background()), src, "snapshots/s1/files/disk.vhdx"); err == nil {
		t.Fatal("a source that changed during the upload must fail the file")
	}
}

func TestS3Provider_LiveLargeUploadPartRetryKeepsDigest(t *testing.T) {
	restore := setS3MultipartThresholdForTest(1 << 20)
	defer restore()
	var modes []string
	restoreHook := setLargeDigestUploadHookForTest(func(mode string) { modes = append(modes, mode) })
	defer restoreHook()
	store, srv := newFakeS3(t)
	store.failParts = 1
	src, data := writeUploadSource(t, 12<<20)
	p := NewS3ProviderWithEndpoint("bucket", "us-east-1", srv.URL, "key", "secret", "")
	got, err := p.UploadWithDigest(context.Background(), src, "snapshots/s1/files/live.bin")
	if err != nil {
		t.Fatalf("UploadWithDigest: %v", err)
	}
	if len(modes) != 1 || modes[0] != "sequential" {
		t.Fatalf("upload mode = %v, want [sequential]", modes)
	}
	if atomic.LoadInt32(&store.failParts) >= 0 {
		t.Fatal("no part was refused; the part retry did not run")
	}
	if got.SHA256 != hexSHA256(data) || !bytes.Equal(store.only(t), data) {
		t.Fatal("digest after a part retry does not describe the stored object")
	}
}

func TestDigestSource_LastCompletePassWins(t *testing.T) {
	path, data := writeUploadSource(t, 1000)
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	src := newRewindableDigestSource(f)

	// Length probe, a hashing pass, a rewind and the sending pass.
	if _, err := src.Seek(0, io.SeekEnd); err != nil {
		t.Fatal(err)
	}
	if _, err := src.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(io.Discard, src); err != nil {
		t.Fatal(err)
	}
	if _, err := src.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(io.Discard, src); err != nil {
		t.Fatal(err)
	}
	got, ok := src.digest()
	if !ok || got.SHA256 != hexSHA256(data) || got.Size != 1000 {
		t.Fatalf("digest = %+v ok=%v, want %s/1000", got, ok, hexSHA256(data))
	}
}

func TestDigestSource_ReadAfterJumpIsNotVouchedFor(t *testing.T) {
	path, _ := writeUploadSource(t, 1000)
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	src := newRewindableDigestSource(f)
	if _, err := src.Seek(500, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(io.Discard, src); err != nil {
		t.Fatal(err)
	}
	if _, ok := src.digest(); ok {
		t.Fatal("a pass that did not start at offset 0 must not produce a digest")
	}
}

func TestLocalProvider_UploadWithDigestDescribesDownloadedContent(t *testing.T) {
	for _, remote := range []string{"snapshots/s1/files/a.bin", "snapshots/s1/files/a.bin.gz"} {
		t.Run(remote, func(t *testing.T) {
			src, data := writeUploadSource(t, 200*1024)
			p := NewLocalProvider(t.TempDir())
			var du DigestUploader = p
			got, err := du.UploadWithDigest(context.Background(), src, remote)
			if err != nil {
				t.Fatalf("UploadWithDigest: %v", err)
			}
			dl := downloadBytes(t, p, remote)
			if got.SHA256 != hexSHA256(dl) || got.Size != int64(len(dl)) {
				t.Fatalf("digest %s/%d does not describe the downloaded content %s/%d", got.SHA256, got.Size, hexSHA256(dl), len(dl))
			}
			if !bytes.Equal(dl, data) {
				t.Fatal("downloaded content differs from the source")
			}
		})
	}
}

// A failed upload over an existing object leaves that object as it was, so a
// manifest entry describing the earlier upload stays true.
func TestLocalProvider_UploadWithDigestFailureKeepsExistingObject(t *testing.T) {
	src, data := writeUploadSource(t, 4096)
	base := t.TempDir()
	p := NewLocalProvider(base)
	const remote = "snapshots/s1/files/a.bin.gz"
	if _, err := p.UploadWithDigest(context.Background(), src, remote); err != nil {
		t.Fatalf("first upload: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := p.UploadWithDigest(ctx, src, remote); err == nil {
		t.Fatal("expected a cancelled upload to fail")
	}
	if dl := downloadBytes(t, p, remote); !bytes.Equal(dl, data) {
		t.Fatal("a failed upload replaced or removed the existing object")
	}
	entries, err := os.ReadDir(filepath.Join(base, "snapshots", "s1", "files"))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.Name() != "a.bin.gz" {
			t.Fatalf("a failed upload left %q behind", e.Name())
		}
	}
}

type digestOnlyProvider struct {
	mockProvider
	digest UploadDigest
	calls  int
}

func (d *digestOnlyProvider) UploadWithDigest(_ context.Context, _, remotePath string) (UploadDigest, error) {
	d.calls++
	d.files[remotePath] = "digest"
	return d.digest, nil
}

func TestFallbackProvider_ForwardsDigestUploadToPrimary(t *testing.T) {
	primary := &digestOnlyProvider{mockProvider: *newMockProvider(), digest: UploadDigest{SHA256: strings.Repeat("a", 64), Size: 3}}
	secondary := newMockProvider()
	f := NewFallbackProvider(primary, secondary)
	var du DigestUploader = f
	got, err := du.UploadWithDigest(context.Background(), "/tmp/x", "k")
	if err != nil {
		t.Fatalf("UploadWithDigest: %v", err)
	}
	if got != primary.digest || primary.calls != 1 || len(secondary.uploads) != 0 {
		t.Fatalf("digest upload not forwarded to the primary only: got %+v calls=%d secondary=%v", got, primary.calls, secondary.uploads)
	}
}

func TestFallbackProvider_DigestUploadUnavailableWithoutPrimarySupport(t *testing.T) {
	primary := newMockProvider()
	f := NewFallbackProvider(primary)
	if _, err := f.UploadWithDigest(context.Background(), "/tmp/x", "k"); !errors.Is(err, ErrDigestUnavailable) {
		t.Fatalf("want ErrDigestUnavailable, got %v", err)
	}
	if len(primary.uploads) != 0 {
		t.Fatal("nothing should be uploaded when the digest cannot be produced")
	}
}

// Renaming the finished temp file over an existing object can fail for a
// moment on Windows (a scanner holding the target open); it is retried.
func TestLocalProvider_UploadWithDigestRetriesATransientRenameFailure(t *testing.T) {
	src, data := writeUploadSource(t, 4096)
	base := t.TempDir()
	p := NewLocalProvider(base)
	fails := 2
	restore := setLocalRenameForTest(func(from, to string) error {
		if fails > 0 {
			fails--
			return &os.LinkError{Op: "rename", Old: from, New: to, Err: errors.New("the process cannot access the file because it is being used by another process")}
		}
		return os.Rename(from, to)
	})
	defer restore()
	if _, err := p.UploadWithDigest(context.Background(), src, "snapshots/s1/files/a.bin"); err != nil {
		t.Fatalf("a transient rename failure must be retried: %v", err)
	}
	if !bytes.Equal(downloadBytes(t, p, "snapshots/s1/files/a.bin"), data) {
		t.Fatal("object content wrong after a retried rename")
	}
}

func TestLocalProvider_UploadWithDigestPersistentRenameFailureLeavesNoTemp(t *testing.T) {
	src, _ := writeUploadSource(t, 4096)
	base := t.TempDir()
	p := NewLocalProvider(base)
	restore := setLocalRenameForTest(func(string, string) error { return errors.New("access denied") })
	defer restore()
	if _, err := p.UploadWithDigest(context.Background(), src, "snapshots/s1/files/a.bin"); err == nil {
		t.Fatal("expected a persistent rename failure to fail the upload")
	}
	entries, _ := os.ReadDir(filepath.Join(base, "snapshots", "s1", "files"))
	if len(entries) != 0 {
		t.Fatalf("temp file left behind: %v", entries)
	}
}

func TestLocalProvider_SweepStaleUploadsRemovesOnlyOldTempFiles(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "snapshots", "s1", "files", "sub")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name string, age time.Duration) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		old := time.Now().Add(-age)
		_ = os.Chtimes(p, old, old)
		return p
	}
	stale := write(".a.bin.gz.upload-123", 48*time.Hour)
	fresh := write(".b.bin.gz.upload-456", time.Minute)
	object := write("c.bin.gz", 48*time.Hour)
	lookalike := write("d.upload-789", 48*time.Hour)
	outside := filepath.Join(base, "other")
	_ = os.MkdirAll(outside, 0o755)
	outsideStale := filepath.Join(outside, ".e.upload-1")
	_ = os.WriteFile(outsideStale, []byte("x"), 0o644)
	old := time.Now().Add(-48 * time.Hour)
	_ = os.Chtimes(outsideStale, old, old)

	n, err := NewLocalProvider(base).SweepStaleUploads("snapshots/s1", 24*time.Hour)
	if err != nil {
		t.Fatalf("SweepStaleUploads: %v", err)
	}
	if n != 1 {
		t.Fatalf("removed %d files, want 1", n)
	}
	for _, p := range []string{fresh, object, lookalike, outsideStale} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("%s must be kept: %v", p, err)
		}
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatal("stale temp upload not removed")
	}
	if _, err := NewLocalProvider(base).SweepStaleUploads("../escape", time.Hour); err == nil {
		t.Fatal("a prefix outside the base must be refused")
	}
}

func TestDeleteNotFoundClassifiers(t *testing.T) {
	if !gcsIsNotFound(fmt.Errorf("wrapped: %w", storage.ErrObjectNotExist)) || gcsIsNotFound(errors.New("boom")) {
		t.Fatal("gcs not-found classification wrong")
	}
	notFound := &azcore.ResponseError{ErrorCode: string(bloberror.BlobNotFound), StatusCode: http.StatusNotFound}
	if !azureIsNotFound(fmt.Errorf("wrapped: %w", notFound)) || azureIsNotFound(&azcore.ResponseError{ErrorCode: "AuthorizationFailure", StatusCode: 403}) {
		t.Fatal("azure not-found classification wrong")
	}
	if b2IsNotFound(errors.New("boom")) {
		t.Fatal("b2 not-found classification wrong")
	}
}
