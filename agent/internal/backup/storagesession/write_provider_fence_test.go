package storagesession

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

func shortTransferGrace(t *testing.T, d time.Duration) {
	t.Helper()
	orig := urlTransferGrace
	urlTransferGrace = d
	t.Cleanup(func() { urlTransferGrace = orig })
}

// boundedCtx fails an expiry test quickly instead of letting it hang until
// the idle timeout when the expiry cutoff does not fire.
func boundedCtx(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	return ctx
}

// blockUntilCancelled holds a storage request open until the client gives up
// on it.
func blockUntilCancelled(r *http.Request, release <-chan struct{}) {
	select {
	case <-r.Context().Done():
	case <-release:
	}
}

func TestWriteProviderAbandonsAnAttemptPastItsURLExpiry(t *testing.T) {
	shortTransferGrace(t, 200*time.Millisecond)
	b := newFakeWriteBackend(t)
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	var held atomic.Bool
	b.set(func(b *fakeWriteBackend) {
		b.urlTTL = time.Second
		b.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
			if r.Method == http.MethodPut && held.CompareAndSwap(false, true) {
				blockUntilCancelled(r, release)
				return true
			}
			return false
		}
	})
	p := newTestWriteProvider(t, b, Options{StorageIdleTimeout: time.Minute})
	data := []byte("payload")
	start := time.Now()
	d, err := p.UploadWithDigest(boundedCtx(t), writeTempData(t, data), objKey("files/a"))
	if err != nil || d.SHA256 != digestHex(data) {
		t.Fatalf("upload: %+v %v", d, err)
	}
	if n := len(b.callsFor("objects:resolve")); n != 2 {
		t.Fatalf("resolve calls = %d, want a fresh URL after the first expired", n)
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("the expired attempt was not abandoned promptly (%s)", elapsed)
	}
}

func TestWriteProviderShrinksPartsThatOutlastTheirURL(t *testing.T) {
	shortTransferGrace(t, 100*time.Millisecond)
	b := newFakeWriteBackend(t)
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	b.set(func(b *fakeWriteBackend) {
		b.urlTTL = 500 * time.Millisecond
		b.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
			if r.URL.Path == "/part" && r.ContentLength > 4<<10 {
				blockUntilCancelled(r, release)
				return true
			}
			return false
		}
	})
	p := newTestWriteProvider(t, b, Options{StorageIdleTimeout: time.Minute})
	p.singlePutMax = 4 << 10
	p.partSize = 16 << 10
	p.minPartSize = 2 << 10
	data := patternBytes(40<<10 + 3)
	d, err := p.UploadWithDigest(boundedCtx(t), writeTempData(t, data), objKey("files/big"))
	if err != nil || d.SHA256 != digestHex(data) {
		t.Fatalf("upload: %+v %v", d, err)
	}
	stored, _ := b.object(objKey("files/big"))
	if string(stored) != string(data) {
		t.Fatal("stored object differs")
	}
}

func TestWriteProviderSwitchesToMultipartWhenAPutOutlastsItsURL(t *testing.T) {
	shortTransferGrace(t, 100*time.Millisecond)
	b := newFakeWriteBackend(t)
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	b.set(func(b *fakeWriteBackend) {
		b.urlTTL = 500 * time.Millisecond
		b.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
			if r.URL.Path == "/put" {
				blockUntilCancelled(r, release)
				return true
			}
			return false
		}
	})
	p := newTestWriteProvider(t, b, Options{StorageIdleTimeout: time.Minute})
	p.singlePutMax = 64 << 10
	p.partSize = 4 << 10
	p.minPartSize = 2 << 10
	data := patternBytes(10 << 10)
	d, err := p.UploadWithDigest(boundedCtx(t), writeTempData(t, data), objKey("files/mid"))
	if err != nil || d.SHA256 != digestHex(data) {
		t.Fatalf("upload: %+v %v", d, err)
	}
	if len(b.callsFor("multipart:complete")) != 1 {
		t.Fatal("did not fall back to a multipart upload")
	}
}

func TestWriteProviderMultipartDigestFollowsRetriedPartBytes(t *testing.T) {
	noSleep(t)
	b := newFakeWriteBackend(t)
	p := newTestWriteProvider(t, b, Options{})
	p.singlePutMax = 1 << 10
	p.partSize = 3 << 10
	p.minPartSize = 1 << 10
	data := patternBytes(8 << 10)
	src := writeTempData(t, data)
	var once sync.Once
	b.set(func(b *fakeWriteBackend) {
		b.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
			if r.URL.Path != "/part" || r.URL.Query().Get("n") != "2" {
				return false
			}
			failed := false
			once.Do(func() {
				// The source changes under part 2 before its retry.
				f, err := os.OpenFile(src, os.O_WRONLY, 0)
				if err == nil {
					_, _ = f.WriteAt([]byte("CHANGED!"), 3<<10+10)
					_ = f.Close()
				}
				http.Error(w, "SlowDown", http.StatusServiceUnavailable)
				failed = true
			})
			return failed
		}
	})
	d, err := p.UploadWithDigest(context.Background(), src, objKey("files/big"))
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	stored, _ := b.object(objKey("files/big"))
	if d.SHA256 != digestHex(stored) || d.Size != int64(len(stored)) {
		t.Fatalf("digest %+v does not describe the stored object", d)
	}
	if d.SHA256 == digestHex(data) {
		t.Fatal("test setup: the retried part was not changed")
	}
}

func TestWriteProviderMultipartEncryption(t *testing.T) {
	kmsReq := map[string]any{"algorithm": "aws:kms", "kmsKeyId": "key-1"}
	cases := []struct {
		name      string
		alg, kms  string
		applied   map[string]any
		null      bool
		wantError bool
	}{
		{"confirmed as planned", "AES256", "", map[string]any{"algorithm": "AES256", "requested": map[string]any{"algorithm": "AES256"}, "matches": true}, false, false},
		{"storage ignored the request", "AES256", "", map[string]any{"algorithm": nil, "requested": map[string]any{"algorithm": "AES256"}, "matches": false}, false, true},
		{"other algorithm", "AES256", "", map[string]any{"algorithm": "aws:kms", "kmsKeyId": "k", "requested": map[string]any{"algorithm": "AES256"}, "matches": true}, false, true},
		{"kms key confirmed by its full name", "aws:kms", "key-1", map[string]any{"algorithm": "aws:kms", "kmsKeyId": "arn:aws:kms:us-east-1:111:key/key-1", "requested": kmsReq, "matches": true}, false, false},
		{"kms key differs", "aws:kms", "key-1", map[string]any{"algorithm": "aws:kms", "kmsKeyId": "arn:aws:kms:us-east-1:111:key/key-2", "requested": kmsReq, "matches": false}, false, true},
		{"required, none reported", "AES256", "", nil, true, true},
		{"required, field absent", "AES256", "", nil, false, true},
		{"not required, none reported", "", "", nil, true, false},
		{"not required, bucket default applied", "", "", map[string]any{"algorithm": "AES256", "requested": nil, "matches": true}, false, false},
		{"not required, mismatch", "", "", map[string]any{"algorithm": nil, "requested": nil, "matches": false}, false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b := newFakeWriteBackend(t)
			b.set(func(b *fakeWriteBackend) {
				b.createEncryption = tc.applied
				b.createEncryptionNull = tc.null
				if tc.alg != "" {
					b.sse = map[string]string{"x-amz-server-side-encryption": tc.alg}
				}
			})
			p := newTestWriteProvider(t, b, Options{})
			p.singlePutMax = 1 << 10
			p.partSize = 2 << 10
			p.minPartSize = 1 << 10
			if tc.alg != "" {
				p.SetServerSideEncryption(tc.alg, tc.kms)
			}
			_, err := p.UploadWithDigest(context.Background(), writeTempData(t, patternBytes(5<<10)), objKey("files/big"))
			if tc.wantError {
				if err == nil {
					t.Fatal("multipart upload with the wrong encryption succeeded")
				}
				if len(b.callsFor("multipart:abort")) != 1 || len(b.callsFor("objects:resolve")) != 0 {
					t.Fatal("upload not aborted before any part was sent")
				}
				return
			}
			if err != nil {
				t.Fatalf("upload: %v", err)
			}
		})
	}
}

func TestWriteProviderCompleteOutcomes(t *testing.T) {
	const key = "files/big"
	data := patternBytes(5 << 10)
	run := func(t *testing.T, first func(b *fakeWriteBackend, w http.ResponseWriter) bool) (*fakeWriteBackend, error) {
		b := newFakeWriteBackend(t)
		calls := 0
		b.set(func(b *fakeWriteBackend) {
			b.controlHook = func(op string, _ map[string]any, w http.ResponseWriter) bool {
				if op != "multipart:complete" {
					return false
				}
				calls++
				if calls == 1 {
					return first(b, w)
				}
				return false
			}
		})
		p := newTestWriteProvider(t, b, Options{})
		p.singlePutMax = 1 << 10
		p.partSize = 2 << 10
		p.minPartSize = 1 << 10
		_, err := p.UploadWithDigest(context.Background(), writeTempData(t, data), objKey(key))
		return b, err
	}
	answer := func(stored []byte, status int, code string) func(b *fakeWriteBackend, w http.ResponseWriter) bool {
		return func(b *fakeWriteBackend, w http.ResponseWriter) bool {
			if stored != nil {
				b.objects[objKey(key)] = stored
			}
			writeJSON(w, status, map[string]string{"code": code})
			return true
		}
	}

	t.Run("object exists with these bytes", func(t *testing.T) {
		b, err := run(t, answer(data, http.StatusPreconditionFailed, "object_exists"))
		if err != nil || len(b.callsFor("objects:delete")) != 0 {
			t.Fatalf("err=%v deletes=%d", err, len(b.callsFor("objects:delete")))
		}
	})
	t.Run("object exists with other bytes", func(t *testing.T) {
		b, err := run(t, answer([]byte("older"), http.StatusPreconditionFailed, "object_exists"))
		if err != nil {
			t.Fatal(err)
		}
		if len(b.callsFor("objects:delete")) != 1 || len(b.callsFor("multipart:complete")) != 2 {
			t.Fatal("the stale object was not replaced")
		}
		if stored, _ := b.object(objKey(key)); string(stored) != string(data) {
			t.Fatal("stored object differs")
		}
	})
	t.Run("upload unknown but already stored", func(t *testing.T) {
		if _, err := run(t, answer(data, http.StatusForbidden, "unknown_upload")); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("upload unknown and not stored", func(t *testing.T) {
		b, err := run(t, answer(nil, http.StatusForbidden, "unknown_upload"))
		if err == nil {
			t.Fatal("completion of an unknown upload succeeded")
		}
		if len(b.callsFor("multipart:abort")) != 1 {
			t.Fatal("upload not aborted")
		}
	})
}

func TestWriteProviderAbortsAfterContextCancel(t *testing.T) {
	b := newFakeWriteBackend(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	b.set(func(b *fakeWriteBackend) {
		b.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
			if r.URL.Path == "/part" {
				cancel()
				blockUntilCancelled(r, release)
				return true
			}
			return false
		}
	})
	p := newTestWriteProvider(t, b, Options{})
	p.singlePutMax = 1 << 10
	p.partSize = 2 << 10
	p.minPartSize = 1 << 10
	if _, err := p.UploadWithDigest(ctx, writeTempData(t, patternBytes(5<<10)), objKey("files/big")); err == nil {
		t.Fatal("cancelled upload succeeded")
	}
	if len(b.callsFor("multipart:abort")) != 1 {
		t.Fatal("a cancelled multipart upload was not aborted")
	}
}

func TestWriteProviderGivesUpWaitingForAnEarlierWriter(t *testing.T) {
	waits := noSleep(t)
	b := newFakeWriteBackend(t)
	b.set(func(b *fakeWriteBackend) {
		b.controlHook = func(op string, _ map[string]any, w http.ResponseWriter) bool {
			if op != "objects:resolve" {
				return false
			}
			w.Header().Set("Retry-After", strconv.Itoa(100))
			writeJSON(w, http.StatusConflict, map[string]string{"code": "previous_writer_active"})
			return true
		}
	})
	p := newTestWriteProvider(t, b, Options{})
	err := p.AwaitWriteAccess(context.Background())
	if !errors.Is(err, providers.ErrPreviousWriterActive) {
		t.Fatalf("err = %v", err)
	}
	var total time.Duration
	for _, w := range *waits {
		total += w
	}
	if total > previousWriterMaxWait || len(*waits) == 0 {
		t.Fatalf("waited %s over %d waits", total, len(*waits))
	}
}

func TestWriteProviderRaisesPartsToStayWithinThePartLimit(t *testing.T) {
	b := newFakeWriteBackend(t)
	p := newTestWriteProvider(t, b, Options{})
	p.singlePutMax = 1 << 10
	p.partSize = 1 << 10
	p.minPartSize = 1 << 10
	p.partLimit = 3
	data := patternBytes(10<<10 + 5)
	d, err := p.UploadWithDigest(boundedCtx(t), writeTempData(t, data), objKey("files/big"))
	if err != nil || d.SHA256 != digestHex(data) {
		t.Fatalf("upload: %+v %v", d, err)
	}
	complete := b.callsFor("multipart:complete")
	if len(complete) != 1 || len(complete[0].body["parts"].([]any)) > 3 {
		t.Fatalf("completed with more parts than the limit: %v", complete)
	}
}

func TestWriteProviderNamesTheSizeLimitWhenPartsCannotShrinkEnough(t *testing.T) {
	shortTransferGrace(t, 100*time.Millisecond)
	b := newFakeWriteBackend(t)
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	b.set(func(b *fakeWriteBackend) {
		b.urlTTL = 500 * time.Millisecond
		b.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
			if r.URL.Path == "/part" && r.ContentLength > 3<<10 {
				blockUntilCancelled(r, release)
				return true
			}
			return false
		}
	})
	p := newTestWriteProvider(t, b, Options{StorageIdleTimeout: time.Minute})
	p.singlePutMax = 1 << 10
	p.partSize = 8 << 10
	p.minPartSize = 1 << 10
	p.partLimit = 2
	_, err := p.UploadWithDigest(boundedCtx(t), writeTempData(t, patternBytes(8<<10)), objKey("files/big"))
	if err == nil || !strings.Contains(err.Error(), "too large to upload over this link") {
		t.Fatalf("err = %v, want the size limit named", err)
	}
	if len(b.callsFor("multipart:abort")) != 1 {
		t.Fatal("upload not aborted")
	}
}
