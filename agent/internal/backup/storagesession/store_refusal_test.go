package storagesession

import (
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// s3ErrorBody is the XML body an S3-compatible store answers a refusal with.
// The Message, RequestId and HostId must never reach an error or a log.
func s3ErrorBody(code string) string {
	return `<?xml version="1.0" encoding="UTF-8"?>` + "\n" +
		`<Error><Code>` + code + `</Code><Message>Secret detail for bucket private-bucket-name</Message>` +
		`<RequestId>REQ1234567890</RequestId><HostId>host-id-must-not-leak</HostId></Error>`
}

func answerS3Error(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(s3ErrorBody(code)))
}

func TestReadStoreErrorCode(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"s3 error", s3ErrorBody("AccessDenied"), "AccessDenied"},
		{"no declaration", `<Error><Code>NoSuchBucket</Code></Error>`, "NoSuchBucket"},
		{"whitespace around code", "<Error>\n  <Code>\n SignatureDoesNotMatch \n</Code>\n</Error>", "SignatureDoesNotMatch"},
		{"empty body", "", ""},
		{"plain text", "AccessDenied", ""},
		{"json", `{"Code":"AccessDenied"}`, ""},
		{"html", `<html><body><Code>AccessDenied</Code></body></html>`, ""},
		{"code not a direct child of Error", `<Error><Detail><Code>Nested</Code></Detail></Error>`, ""},
		{"code with spaces", `<Error><Code>Access Denied</Code></Error>`, ""},
		{"code with markup", `<Error><Code>Access<b>Denied</b></Code></Error>`, ""},
		{"code with punctuation", `<Error><Code>Access-Denied</Code></Error>`, ""},
		{"code with an entity", `<Error><Code>Access&amp;Denied</Code></Error>`, ""},
		{"code too long", `<Error><Code>` + strings.Repeat("A", 65) + `</Code></Error>`, ""},
		{"code at the length limit", `<Error><Code>` + strings.Repeat("A", 64) + `</Code></Error>`, strings.Repeat("A", 64)},
		{"empty code", `<Error><Code></Code></Error>`, ""},
		{"unterminated code", `<Error><Code>AccessDenied`, ""},
		{"undeclared entity", `<!DOCTYPE Error [<!ENTITY x "AccessDenied">]><Error><Code>&x;</Code></Error>`, ""},
		{"code past the read limit", `<Error><Message>` + strings.Repeat("x", 5000) + `</Message><Code>AccessDenied</Code></Error>`, ""},
		{"code before a huge tail", `<Error><Code>AccessDenied</Code><Message>` + strings.Repeat("x", 1<<20) + `</Message></Error>`, "AccessDenied"},
		{"binary", string([]byte{0, 1, 2, 0xff, 0xfe, '<'}), ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := readStoreErrorCode(strings.NewReader(tc.body)); got != tc.want {
				t.Fatalf("readStoreErrorCode = %q, want %q", got, tc.want)
			}
		})
	}
}

// A refusal carries the store's S3 code, and nothing else from the response.
func TestWriteProviderStoreRefusalCarriesS3Code(t *testing.T) {
	noSleep(t)
	b := newFakeWriteBackend(t)
	b.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
		answerS3Error(w, http.StatusForbidden, "AccessDenied")
		return true
	}
	p := newTestWriteProvider(t, b, Options{})
	err := p.UploadContext(t.Context(), writeTempData(t, []byte("abc")), objKey("files/a"))
	if err == nil {
		t.Fatal("upload to a refusing store succeeded")
	}
	if got, want := err.Error(), "storage session: storage answered status 403 (AccessDenied)"; got != want {
		t.Fatalf("error = %q, want %q", got, want)
	}
	if got := providers.StoreErrorCode(err); got != "AccessDenied" {
		t.Fatalf("StoreErrorCode = %q, want AccessDenied", got)
	}
	assertNoResponseLeak(t, err.Error(), b)
}

// Without a code the message is exactly what it always was.
func TestWriteProviderStoreRefusalWithoutCodeKeepsMessage(t *testing.T) {
	noSleep(t)
	b := newFakeWriteBackend(t)
	b.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
		http.Error(w, "AccessDenied", http.StatusForbidden)
		return true
	}
	p := newTestWriteProvider(t, b, Options{})
	err := p.UploadContext(t.Context(), writeTempData(t, []byte("abc")), objKey("files/a"))
	if err == nil {
		t.Fatal("upload to a refusing store succeeded")
	}
	if got, want := err.Error(), "storage session: storage answered status 403"; got != want {
		t.Fatalf("error = %q, want %q", got, want)
	}
	if got := providers.StoreErrorCode(err); got != "" {
		t.Fatalf("StoreErrorCode = %q, want none", got)
	}
}

// The read-back path (GET) carries the code too.
func TestWriteProviderReadBackRefusalCarriesS3Code(t *testing.T) {
	noSleep(t)
	b := newFakeWriteBackend(t)
	b.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
		answerS3Error(w, http.StatusForbidden, "SignatureDoesNotMatch")
		return true
	}
	p := newTestWriteProvider(t, b, Options{})
	_, err := p.StoredObjectDigest(t.Context(), objKey("files/a"))
	if err == nil || err.Error() != "storage session: storage answered status 403 (SignatureDoesNotMatch)" {
		t.Fatalf("error = %v, want the 403 with its code", err)
	}
	if errors.Is(err, providers.ErrObjectNotFound) {
		t.Fatal("a 403 must not read as a missing object")
	}
}

// The read-only provider (restore, verify) carries the code too.
func TestStorageRefusalCarriesS3Code(t *testing.T) {
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	st.setHook(func(w http.ResponseWriter, r *http.Request) bool {
		answerS3Error(w, http.StatusForbidden, "AccessDenied")
		return true
	})
	p := newTestProvider(t, cp, testDescriptor(cp, time.Now()), Options{})
	err := p.Download("snapshots/s1/files/never", filepath.Join(t.TempDir(), "o"))
	if err == nil || err.Error() != "storage session: storage answered status 403 (AccessDenied)" {
		t.Fatalf("error = %v, want the 403 with its code", err)
	}
}

func assertNoResponseLeak(t *testing.T, msg string, b *fakeWriteBackend) {
	t.Helper()
	for _, leak := range []string{"Secret detail", "private-bucket-name", "REQ1234567890", "host-id-must-not-leak", b.storage.URL, "?k=", "X-Amz"} {
		if strings.Contains(msg, leak) {
			t.Fatalf("error %q leaks %q from the store's response or URL", msg, leak)
		}
	}
}

const destinationRefusedMessage = "backup destination refused every request: storage answered status 403 (AccessDenied)"

// A store refusing every request ends in ONE destination-level error once
// destinationRefusalThreshold different keys were refused in a row; every
// later call fails with it at once, without contacting the store.
func TestWriteProviderDestinationRefusingEveryRequest(t *testing.T) {
	noSleep(t)
	b := newFakeWriteBackend(t)
	var storeRequests atomic.Int64
	b.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
		storeRequests.Add(1)
		answerS3Error(w, http.StatusForbidden, "AccessDenied")
		return true
	}
	p := newTestWriteProvider(t, b, Options{})
	src := writeTempData(t, []byte("abc"))
	tripped := -1
	for i := 0; i < destinationRefusalThreshold+5; i++ {
		err := p.UploadContext(t.Context(), src, objKey(fmt.Sprintf("files/f%03d", i)))
		if err == nil {
			t.Fatalf("upload %d succeeded against a refusing store", i)
		}
		if errors.Is(err, providers.ErrDestinationRefused) {
			if err.Error() != destinationRefusedMessage {
				t.Fatalf("destination error = %q, want %q", err.Error(), destinationRefusedMessage)
			}
			if errors.Is(err, providers.ErrObjectNotFound) {
				t.Fatal("a destination refusal must not read as a missing object")
			}
			if providers.StoreErrorCode(err) != "AccessDenied" {
				t.Fatalf("StoreErrorCode = %q", providers.StoreErrorCode(err))
			}
			assertNoResponseLeak(t, err.Error(), b)
			if tripped < 0 {
				tripped = i
			}
			continue
		}
		if tripped >= 0 {
			t.Fatalf("upload %d answered %v after the destination was declared refusing", i, err)
		}
		if !strings.Contains(err.Error(), "storage answered status 403") {
			t.Fatalf("upload %d error = %v", i, err)
		}
	}
	if tripped != destinationRefusalThreshold-1 {
		t.Fatalf("destination declared refusing at upload %d, want %d", tripped, destinationRefusalThreshold-1)
	}
	before := storeRequests.Load()
	if _, err := p.StoredObjectDigest(t.Context(), objKey("files/f000")); !errors.Is(err, providers.ErrDestinationRefused) {
		t.Fatalf("read after the trip = %v, want the destination error", err)
	}
	if err := p.UploadContext(t.Context(), src, objKey("files/later")); !errors.Is(err, providers.ErrDestinationRefused) {
		t.Fatalf("upload after the trip = %v, want the destination error", err)
	}
	if after := storeRequests.Load(); after != before {
		t.Fatalf("%d store requests after the destination was declared refusing", after-before)
	}
}

// The count spans every path to the store: uploads and read-backs alike.
func TestWriteProviderRefusalCountSpansReadsAndWrites(t *testing.T) {
	noSleep(t)
	b := newFakeWriteBackend(t)
	b.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
		answerS3Error(w, http.StatusForbidden, "AccessDenied")
		return true
	}
	p := newTestWriteProvider(t, b, Options{})
	src := writeTempData(t, []byte("abc"))
	var last error
	for i := 0; i < destinationRefusalThreshold; i++ {
		key := objKey(fmt.Sprintf("files/f%03d", i))
		if i%2 == 0 {
			last = p.UploadContext(t.Context(), src, key)
		} else {
			_, last = p.StoredObjectDigest(t.Context(), key)
		}
	}
	if !errors.Is(last, providers.ErrDestinationRefused) {
		t.Fatalf("last error = %v, want the destination error", last)
	}
}

// One key refused over and over is that object's problem, not the
// destination's: only different keys count.
func TestWriteProviderSameKeyRefusalsDoNotTrip(t *testing.T) {
	noSleep(t)
	b := newFakeWriteBackend(t)
	b.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
		answerS3Error(w, http.StatusForbidden, "AccessDenied")
		return true
	}
	p := newTestWriteProvider(t, b, Options{})
	src := writeTempData(t, []byte("abc"))
	for i := 0; i < destinationRefusalThreshold*2; i++ {
		err := p.UploadContext(t.Context(), src, objKey("files/one"))
		if errors.Is(err, providers.ErrDestinationRefused) {
			t.Fatalf("attempt %d declared the destination refusing on one key", i)
		}
	}
}

// A few missing or forbidden objects among successes never fail the run:
// any success resets the count.
func TestWriteProviderScatteredRefusalsAmongSuccessesDoNotTrip(t *testing.T) {
	noSleep(t)
	b := newFakeWriteBackend(t)
	b.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
		k := r.URL.Query().Get("k")
		switch {
		case strings.Contains(k, "/forbidden-"):
			answerS3Error(w, http.StatusForbidden, "AccessDenied")
			return true
		case strings.Contains(k, "/gone-"):
			answerS3Error(w, http.StatusNotFound, "NoSuchBucket")
			return true
		}
		return false
	}
	p := newTestWriteProvider(t, b, Options{})
	src := writeTempData(t, []byte("abc"))
	refusalsPerRound := destinationRefusalThreshold - 1
	for round := 0; round < 4; round++ {
		for i := 0; i < refusalsPerRound; i++ {
			prefix := "forbidden-"
			if i%2 == 1 {
				prefix = "gone-"
			}
			err := p.UploadContext(t.Context(), src, objKey(fmt.Sprintf("files/%s%d-%d", prefix, round, i)))
			if err == nil || errors.Is(err, providers.ErrDestinationRefused) {
				t.Fatalf("round %d refusal %d: err = %v, want a per-object refusal", round, i, err)
			}
		}
		if err := p.UploadContext(t.Context(), src, objKey(fmt.Sprintf("files/ok-%d", round))); err != nil {
			t.Fatalf("round %d: a good upload failed: %v", round, err)
		}
	}
}

// A 404 that says the object (not the bucket) is absent is an answer from a
// working destination: reading back thousands of genuinely missing objects
// must never fail the run.
func TestWriteProviderMissingObjectsDoNotTrip(t *testing.T) {
	noSleep(t)
	b := newFakeWriteBackend(t)
	b.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method == http.MethodGet {
			answerS3Error(w, http.StatusNotFound, "NoSuchKey")
			return true
		}
		return false
	}
	p := newTestWriteProvider(t, b, Options{})
	for i := 0; i < destinationRefusalThreshold*3; i++ {
		_, err := p.StoredObjectDigest(t.Context(), objKey(fmt.Sprintf("files/missing-%d", i)))
		if !errors.Is(err, providers.ErrObjectNotFound) {
			t.Fatalf("read %d: err = %v, want ErrObjectNotFound", i, err)
		}
	}
}

// A 404 naming the bucket is the destination's refusal and counts.
func TestWriteProviderMissingBucketTrips(t *testing.T) {
	noSleep(t)
	b := newFakeWriteBackend(t)
	b.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
		answerS3Error(w, http.StatusNotFound, "NoSuchBucket")
		return true
	}
	p := newTestWriteProvider(t, b, Options{})
	src := writeTempData(t, []byte("abc"))
	var last error
	for i := 0; i < destinationRefusalThreshold; i++ {
		last = p.UploadContext(t.Context(), src, objKey(fmt.Sprintf("files/f%03d", i)))
	}
	want := "backup destination refused every request: storage answered status 404 (NoSuchBucket)"
	if !errors.Is(last, providers.ErrDestinationRefused) || last.Error() != want {
		t.Fatalf("last error = %v, want %q", last, want)
	}
}

// 5xx and transport failures are the transient path and never count.
func TestWriteProviderServerErrorsDoNotTrip(t *testing.T) {
	noSleep(t)
	b := newFakeWriteBackend(t)
	b.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
		answerS3Error(w, http.StatusServiceUnavailable, "SlowDown")
		return true
	}
	p := newTestWriteProvider(t, b, Options{})
	src := writeTempData(t, []byte("abc"))
	for i := 0; i < destinationRefusalThreshold*2; i++ {
		err := p.UploadContext(t.Context(), src, objKey(fmt.Sprintf("files/f%03d", i)))
		if err == nil || errors.Is(err, providers.ErrDestinationRefused) {
			t.Fatalf("upload %d: err = %v, want a transient failure", i, err)
		}
	}
}

// Concurrent uploads (the upload pool) share one count, race-free.
func TestWriteProviderRefusalCountIsConcurrencySafe(t *testing.T) {
	noSleep(t)
	b := newFakeWriteBackend(t)
	b.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
		answerS3Error(w, http.StatusForbidden, "AccessDenied")
		return true
	}
	p := newTestWriteProvider(t, b, Options{})
	src := writeTempData(t, []byte("abc"))
	var wg sync.WaitGroup
	var destination atomic.Int64
	for w := 0; w < 8; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < destinationRefusalThreshold; i++ {
				err := p.UploadContext(t.Context(), src, objKey(fmt.Sprintf("files/w%d-%03d", w, i)))
				if errors.Is(err, providers.ErrDestinationRefused) {
					destination.Add(1)
				}
			}
		}(w)
	}
	wg.Wait()
	if destination.Load() == 0 {
		t.Fatal("concurrent refusals never declared the destination refusing")
	}
	if err := p.UploadContext(t.Context(), src, objKey("files/after")); !errors.Is(err, providers.ErrDestinationRefused) {
		t.Fatalf("upload after the trip = %v", err)
	}
}

// A dead session's error is recognisable through the shared sentinel.
func TestSessionUnavailableIsTheSharedSentinel(t *testing.T) {
	if !errors.Is(fmt.Errorf("wrapped: %w", ErrSessionUnavailable), providers.ErrStorageSessionUnavailable) {
		t.Fatal("ErrSessionUnavailable is not providers.ErrStorageSessionUnavailable")
	}
	if ErrSessionUnavailable.Error() != "storage session: session is no longer usable" {
		t.Fatalf("message changed: %q", ErrSessionUnavailable.Error())
	}
}

// A 404 without a code on a READ is ambiguous: a proxy or a store that
// answers a missing object with a bare 404 is still answering about the
// object. It neither counts nor resets, so a read-back pass over missing
// objects never fails the run.
func TestWriteProviderCodelessReadNotFoundDoesNotTrip(t *testing.T) {
	for _, tc := range []struct {
		name   string
		answer func(w http.ResponseWriter)
	}{
		{"empty body", func(w http.ResponseWriter) { w.WriteHeader(http.StatusNotFound) }},
		{"plain text", func(w http.ResponseWriter) { http.Error(w, "Not Found", http.StatusNotFound) }},
		{"truncated xml", func(w http.ResponseWriter) {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte("<Error><Code>NoSuch"))
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			noSleep(t)
			b := newFakeWriteBackend(t)
			b.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
				tc.answer(w)
				return true
			}
			p := newTestWriteProvider(t, b, Options{})
			for i := 0; i < destinationRefusalThreshold*3; i++ {
				_, err := p.StoredObjectDigest(t.Context(), objKey(fmt.Sprintf("files/missing-%d", i)))
				if !errors.Is(err, providers.ErrObjectNotFound) {
					t.Fatalf("read %d: err = %v, want ErrObjectNotFound", i, err)
				}
			}
		})
	}
}

// A 404 without a code on a WRITE counts: a PUT creates the object, so a
// 404 there is the bucket (or the whole destination) missing.
func TestWriteProviderCodelessWriteNotFoundTrips(t *testing.T) {
	noSleep(t)
	b := newFakeWriteBackend(t)
	b.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
		w.WriteHeader(http.StatusNotFound)
		return true
	}
	p := newTestWriteProvider(t, b, Options{})
	src := writeTempData(t, []byte("abc"))
	var last error
	for i := 0; i < destinationRefusalThreshold; i++ {
		last = p.UploadContext(t.Context(), src, objKey(fmt.Sprintf("files/f%03d", i)))
	}
	want := "backup destination refused every request: storage answered status 404"
	if !errors.Is(last, providers.ErrDestinationRefused) || last.Error() != want {
		t.Fatalf("last error = %v, want %q", last, want)
	}
}

// Every part of a multipart upload is the same object: refused parts count
// once per object, and a stored part is a success that resets the count.
func TestWriteProviderMultipartPartsCountOncePerObject(t *testing.T) {
	noSleep(t)
	b := newFakeWriteBackend(t)
	var refuseParts atomic.Bool
	refuseParts.Store(true)
	b.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path == "/part" && refuseParts.Load() {
			answerS3Error(w, http.StatusForbidden, "AccessDenied")
			return true
		}
		return false
	}
	p := newTestWriteProvider(t, b, Options{})
	p.singlePutMax = 4 << 10
	p.partSize = 3 << 10
	p.minPartSize = 1 << 10
	big := writeTempData(t, patternBytes(10<<10+17))
	// One object refused many times over: never the destination.
	for i := 0; i < destinationRefusalThreshold*2; i++ {
		err := p.UploadContext(t.Context(), big, objKey("files/big.bin"))
		if err == nil || errors.Is(err, providers.ErrDestinationRefused) {
			t.Fatalf("attempt %d: err = %v, want a per-object refusal", i, err)
		}
	}
	// A stored part resets the count: 30 more refused objects (31 with the
	// one above), a stored multipart object, then 31 more never trip.
	for i := 0; i < destinationRefusalThreshold-2; i++ {
		_ = p.UploadContext(t.Context(), big, objKey(fmt.Sprintf("files/big-a%d.bin", i)))
	}
	refuseParts.Store(false)
	if err := p.UploadContext(t.Context(), big, objKey("files/big-ok.bin")); err != nil {
		t.Fatalf("multipart upload on a working store: %v", err)
	}
	refuseParts.Store(true)
	for i := 0; i < destinationRefusalThreshold-1; i++ {
		if err := p.UploadContext(t.Context(), big, objKey(fmt.Sprintf("files/big-b%d.bin", i))); errors.Is(err, providers.ErrDestinationRefused) {
			t.Fatalf("object %d after a stored multipart upload tripped the destination", i)
		}
	}
	// The next distinct refused object is the threshold'th in a row: it trips.
	if err := p.UploadContext(t.Context(), big, objKey("files/big-last.bin")); !errors.Is(err, providers.ErrDestinationRefused) {
		t.Fatalf("the %dth distinct refused object: err = %v, want the destination error", destinationRefusalThreshold, err)
	}
}
