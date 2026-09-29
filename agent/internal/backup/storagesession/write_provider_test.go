package storagesession

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

func objKey(rest string) string { return "snapshots/" + testWriteSnapshotID + "/" + rest }

func TestNewWriteProviderRefusesReadSession(t *testing.T) {
	b := newFakeWriteBackend(t)
	d := testWriteDescriptor(b, time.Now())
	d.Scope = ""
	d.SnapshotID = ""
	creds := Credentials{AgentID: testAgentID, AgentToken: testAgentToken, ControlPlaneOrigins: []string{b.control.URL}}
	if p, err := NewWriteProvider(context.Background(), d, creds, Options{ControlClient: b.control.Client()}); err == nil {
		p.Close()
		t.Fatal("write provider accepted a read session")
	}
}

func TestWriteProviderSmallPut(t *testing.T) {
	b := newFakeWriteBackend(t)
	b.set(func(b *fakeWriteBackend) { b.conditional = true })
	p := newTestWriteProvider(t, b, Options{})
	if p.SnapshotID() != testWriteSnapshotID {
		t.Fatalf("SnapshotID = %q", p.SnapshotID())
	}
	data := patternBytes(4096)
	src := writeTempData(t, data)
	d, err := p.UploadWithDigest(context.Background(), src, objKey("files/a.bin"))
	if err != nil {
		t.Fatalf("UploadWithDigest: %v", err)
	}
	if d.Size != int64(len(data)) || d.SHA256 != digestHex(data) {
		t.Fatalf("digest = %+v, want %d/%s", d, len(data), digestHex(data))
	}
	stored, ok := b.object(objKey("files/a.bin"))
	if !ok || string(stored) != string(data) {
		t.Fatal("stored object differs from the source")
	}
	for _, r := range b.storageRequests() {
		if r.Header.Get(SessionHeader) != "" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Fatalf("storage request carried a credential header: %v", r.Header)
		}
		if r.Method == http.MethodPut && r.Header.Get("If-None-Match") != "*" {
			t.Fatalf("PUT without the create-only condition: %v", r.Header)
		}
		if r.Method == http.MethodPut && r.ContentLength != int64(len(data)) {
			t.Fatalf("PUT content length %d, want %d", r.ContentLength, len(data))
		}
	}
	calls := b.callsFor("objects:resolve")
	if len(calls) != 1 || calls[0].headers.Get(SessionHeader) != testSessionToken || calls[0].headers.Get("Authorization") != "Bearer "+testAgentToken {
		t.Fatalf("resolve calls = %+v", calls)
	}
}

func TestWriteProviderMultipart(t *testing.T) {
	b := newFakeWriteBackend(t)
	p := newTestWriteProvider(t, b, Options{})
	p.singlePutMax = 4 << 10
	p.partSize = 3 << 10
	p.minPartSize = 1 << 10
	data := patternBytes(10<<10 + 17)
	src := writeTempData(t, data)
	d, err := p.UploadWithDigest(context.Background(), src, objKey("files/big.bin"))
	if err != nil {
		t.Fatalf("UploadWithDigest: %v", err)
	}
	if d.Size != int64(len(data)) || d.SHA256 != digestHex(data) {
		t.Fatalf("digest = %+v", d)
	}
	stored, ok := b.object(objKey("files/big.bin"))
	if !ok || string(stored) != string(data) {
		t.Fatalf("stored object differs (ok=%v len=%d)", ok, len(stored))
	}
	if n := len(b.callsFor("multipart:create")); n != 1 {
		t.Fatalf("multipart:create calls = %d", n)
	}
	complete := b.callsFor("multipart:complete")
	if len(complete) != 1 {
		t.Fatalf("multipart:complete calls = %d", len(complete))
	}
	if parts := complete[0].body["parts"].([]any); len(parts) != 4 {
		t.Fatalf("completed with %d parts, want 4", len(parts))
	}
}

func TestWriteProviderMultipartPartFailureAborts(t *testing.T) {
	noSleep(t)
	b := newFakeWriteBackend(t)
	b.set(func(b *fakeWriteBackend) {
		b.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
			if r.URL.Path == "/part" && r.URL.Query().Get("n") == "2" {
				http.Error(w, "InvalidRequest", http.StatusBadRequest)
				return true
			}
			return false
		}
	})
	p := newTestWriteProvider(t, b, Options{})
	p.singlePutMax = 1 << 10
	p.partSize = 2 << 10
	p.minPartSize = 1 << 10
	src := writeTempData(t, patternBytes(7<<10))
	if _, err := p.UploadWithDigest(context.Background(), src, objKey("files/big.bin")); err == nil {
		t.Fatal("multipart upload succeeded despite a failed part")
	}
	if n := len(b.callsFor("multipart:abort")); n != 1 {
		t.Fatalf("multipart:abort calls = %d, want 1", n)
	}
	if n := b.openUploads(); n != 0 {
		t.Fatalf("%d multipart uploads left open", n)
	}
	if n := len(b.callsFor("multipart:complete")); n != 0 {
		t.Fatalf("multipart:complete called %d times after a failed part", n)
	}
	if _, ok := b.object(objKey("files/big.bin")); ok {
		t.Fatal("object stored despite the failure")
	}
}

func TestWriteProviderRequiresPlannedEncryption(t *testing.T) {
	b := newFakeWriteBackend(t)
	p := newTestWriteProvider(t, b, Options{})
	p.SetServerSideEncryption("AES256", "")
	src := writeTempData(t, []byte("hello"))
	if _, err := p.UploadWithDigest(context.Background(), src, objKey("files/a")); err == nil || !strings.Contains(err.Error(), "encryption") {
		t.Fatalf("upload without the planned encryption header: %v", err)
	}
	if len(b.storageRequests()) != 0 {
		t.Fatal("storage was contacted for an upload lacking the planned encryption")
	}
	b.set(func(b *fakeWriteBackend) { b.sse = map[string]string{"x-amz-server-side-encryption": "AES256"} })
	if _, err := p.UploadWithDigest(context.Background(), src, objKey("files/a")); err != nil {
		t.Fatalf("upload with the planned encryption: %v", err)
	}
	p.SetServerSideEncryption("aws:kms", "key-1")
	b.set(func(b *fakeWriteBackend) {
		b.sse = map[string]string{"x-amz-server-side-encryption": "aws:kms", "x-amz-server-side-encryption-aws-kms-key-id": "key-2"}
	})
	if _, err := p.UploadWithDigest(context.Background(), src, objKey("files/b")); err == nil {
		t.Fatal("upload with a different KMS key accepted")
	}
}

func TestWriteProviderDoesNotFollowStorageRedirects(t *testing.T) {
	noSleep(t)
	b := newFakeWriteBackend(t)
	b.set(func(b *fakeWriteBackend) {
		b.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
			if r.Method == http.MethodPut {
				w.Header().Set("Location", "https://elsewhere.example/put")
				w.WriteHeader(http.StatusTemporaryRedirect)
				return true
			}
			return false
		}
	})
	p := newTestWriteProvider(t, b, Options{})
	src := writeTempData(t, []byte("hello"))
	if _, err := p.UploadWithDigest(context.Background(), src, objKey("files/a")); err == nil || !strings.Contains(err.Error(), "redirect") {
		t.Fatalf("redirected PUT: %v", err)
	}
}

func TestWriteProviderRefusesKeysOutsideItsSnapshot(t *testing.T) {
	b := newFakeWriteBackend(t)
	p := newTestWriteProvider(t, b, Options{})
	src := writeTempData(t, []byte("x"))
	for _, key := range []string{
		"snapshots/snapshot-20260101T000000Z-aaaaaaaaaaaaaaaaaaaaaaaa/files/a",
		"snapshots/" + testWriteSnapshotID + "/../other/a",
		"other/" + testWriteSnapshotID + "/a",
		"snapshots/" + testWriteSnapshotID,
	} {
		if _, err := p.UploadWithDigest(context.Background(), src, key); err == nil {
			t.Fatalf("upload to %q accepted", key)
		}
		if err := p.Delete(key); err == nil {
			t.Fatalf("delete of %q accepted", key)
		}
	}
	if _, err := p.List("snapshots/"); err == nil {
		t.Fatal("listing outside the snapshot accepted")
	}
	if len(b.callsFor("objects:resolve"))+len(b.callsFor("objects:delete"))+len(b.callsFor("objects:list")) != 0 {
		t.Fatal("control plane contacted for a key outside the snapshot")
	}
}

func TestWriteProviderConditionalPutOfExistingObject(t *testing.T) {
	b := newFakeWriteBackend(t)
	b.set(func(b *fakeWriteBackend) { b.conditional = true })
	p := newTestWriteProvider(t, b, Options{})
	data := []byte("same bytes")
	src := writeTempData(t, data)

	// Already stored with the same bytes: success, no delete.
	b.put(objKey("files/same"), data)
	d, err := p.UploadWithDigest(context.Background(), src, objKey("files/same"))
	if err != nil || d.SHA256 != digestHex(data) {
		t.Fatalf("same-bytes upload: %+v %v", d, err)
	}
	if n := len(b.callsFor("objects:delete")); n != 0 {
		t.Fatalf("deleted an object holding the same bytes (%d calls)", n)
	}

	// Stored with other bytes (an earlier attempt of this snapshot): the
	// stale object is removed and the upload goes through.
	b.put(objKey("files/stale"), []byte("older content"))
	d, err = p.UploadWithDigest(context.Background(), src, objKey("files/stale"))
	if err != nil || d.SHA256 != digestHex(data) {
		t.Fatalf("stale-object upload: %+v %v", d, err)
	}
	stored, _ := b.object(objKey("files/stale"))
	if string(stored) != string(data) {
		t.Fatalf("stored = %q", stored)
	}
}

func TestWriteProviderResume(t *testing.T) {
	const journalID = "snapshot-20261127T090000Z-fedcba9876543210fedcba98"
	answer := func(mode string, status int, code string) func(op string, body map[string]any, w http.ResponseWriter) bool {
		return func(op string, body map[string]any, w http.ResponseWriter) bool {
			if op != "snapshot:resume" {
				return false
			}
			if status != 200 {
				writeJSON(w, status, map[string]string{"code": code, "error": code})
				return true
			}
			writeJSON(w, 200, map[string]string{"snapshotId": body["snapshotId"].(string), "mode": mode})
			return true
		}
	}

	t.Run("write", func(t *testing.T) {
		b := newFakeWriteBackend(t)
		b.set(func(b *fakeWriteBackend) { b.controlHook = answer("write", 200, "") })
		p := newTestWriteProvider(t, b, Options{})
		mode, err := p.ResumeSnapshot(context.Background(), journalID)
		if err != nil || mode != providers.ResumeWrite {
			t.Fatalf("resume = %v %v", mode, err)
		}
		if p.SnapshotID() != journalID {
			t.Fatalf("SnapshotID = %q after resume", p.SnapshotID())
		}
		if got := b.callsFor("snapshot:resume"); len(got) != 1 || got[0].body["snapshotId"] != journalID {
			t.Fatalf("resume calls = %+v", got)
		}
		if _, err := p.ResumeSnapshot(context.Background(), journalID); err != nil {
			t.Fatalf("resuming the id already owned: %v", err)
		}
		if len(b.callsFor("snapshot:resume")) != 1 {
			t.Fatal("a second resume reached the server")
		}
	})

	t.Run("read-only completion", func(t *testing.T) {
		b := newFakeWriteBackend(t)
		b.set(func(b *fakeWriteBackend) { b.controlHook = answer("read_only_completion", 200, "") })
		p := newTestWriteProvider(t, b, Options{})
		mode, err := p.ResumeSnapshot(context.Background(), journalID)
		if err != nil || mode != providers.ResumeReadOnlyCompletion {
			t.Fatalf("resume = %v %v", mode, err)
		}
		src := writeTempData(t, []byte("x"))
		key := "snapshots/" + journalID + "/files/a"
		if _, err := p.UploadWithDigest(context.Background(), src, key); err == nil {
			t.Fatal("upload after a read-only resume accepted")
		}
		if err := p.Delete(key); err == nil {
			t.Fatal("delete after a read-only resume accepted")
		}
	})

	t.Run("not resumable", func(t *testing.T) {
		b := newFakeWriteBackend(t)
		p := newTestWriteProvider(t, b, Options{})
		_, err := p.ResumeSnapshot(context.Background(), journalID)
		if !errors.Is(err, providers.ErrSnapshotNotResumable) {
			t.Fatalf("resume err = %v", err)
		}
		if p.SnapshotID() != testWriteSnapshotID {
			t.Fatal("snapshot id changed after a refused resume")
		}
	})

	t.Run("previous writer active, then free", func(t *testing.T) {
		waits := noSleep(t)
		b := newFakeWriteBackend(t)
		calls := 0
		b.set(func(b *fakeWriteBackend) {
			b.controlHook = func(op string, body map[string]any, w http.ResponseWriter) bool {
				if op != "snapshot:resume" {
					return false
				}
				calls++
				if calls < 3 {
					w.Header().Set("Retry-After", "7")
					writeJSON(w, 409, map[string]string{"code": "previous_writer_active"})
					return true
				}
				writeJSON(w, 200, map[string]string{"snapshotId": journalID, "mode": "write"})
				return true
			}
		})
		p := newTestWriteProvider(t, b, Options{})
		if mode, err := p.ResumeSnapshot(context.Background(), journalID); err != nil || mode != providers.ResumeWrite {
			t.Fatalf("resume = %v %v", mode, err)
		}
		if len(*waits) != 2 || (*waits)[0] != 7*time.Second {
			t.Fatalf("waits = %v", *waits)
		}
	})

	t.Run("previous writer active past the bound", func(t *testing.T) {
		noSleep(t)
		b := newFakeWriteBackend(t)
		b.set(func(b *fakeWriteBackend) { b.controlHook = answer("", 409, "previous_writer_active") })
		p := newTestWriteProvider(t, b, Options{})
		_, err := p.ResumeSnapshot(context.Background(), journalID)
		if !errors.Is(err, providers.ErrPreviousWriterActive) {
			t.Fatalf("resume err = %v", err)
		}
		if p.SnapshotID() != testWriteSnapshotID {
			t.Fatal("snapshot id changed")
		}
	})

	t.Run("resume after an upload is refused locally", func(t *testing.T) {
		b := newFakeWriteBackend(t)
		p := newTestWriteProvider(t, b, Options{})
		if _, err := p.UploadWithDigest(context.Background(), writeTempData(t, []byte("x")), objKey("files/a")); err != nil {
			t.Fatal(err)
		}
		if _, err := p.ResumeSnapshot(context.Background(), journalID); !errors.Is(err, providers.ErrSnapshotNotResumable) {
			t.Fatalf("resume after an upload = %v", err)
		}
		if len(b.callsFor("snapshot:resume")) != 0 {
			t.Fatal("resume after an upload reached the server")
		}
	})

	t.Run("malformed journal id", func(t *testing.T) {
		b := newFakeWriteBackend(t)
		p := newTestWriteProvider(t, b, Options{})
		if _, err := p.ResumeSnapshot(context.Background(), "../x"); !errors.Is(err, providers.ErrSnapshotNotResumable) {
			t.Fatalf("resume of a malformed id = %v", err)
		}
	})
}

func TestWriteProviderUploadDoesNotWaitForAnEarlierWriter(t *testing.T) {
	waits := noSleep(t)
	b := newFakeWriteBackend(t)
	busy := true
	b.set(func(b *fakeWriteBackend) {
		b.controlHook = func(op string, body map[string]any, w http.ResponseWriter) bool {
			if op == "objects:resolve" && busy {
				w.Header().Set("Retry-After", "42")
				writeJSON(w, 409, map[string]string{"code": "previous_writer_active"})
				return true
			}
			return false
		}
	})
	p := newTestWriteProvider(t, b, Options{})
	src := writeTempData(t, []byte("x"))
	// The upload answers at once, so its caller can wait outside the file's
	// own deadline.
	if _, err := p.UploadWithDigest(context.Background(), src, objKey("files/a")); !errors.Is(err, providers.ErrPreviousWriterActive) {
		t.Fatalf("upload during an earlier writer's fence = %v", err)
	}
	if len(*waits) != 0 {
		t.Fatalf("the upload itself waited: %v", *waits)
	}
	calls := 0
	b.set(func(b *fakeWriteBackend) {
		b.controlHook = func(op string, body map[string]any, w http.ResponseWriter) bool {
			if op == "objects:resolve" {
				calls++
				if calls == 1 {
					w.Header().Set("Retry-After", "42")
					writeJSON(w, 409, map[string]string{"code": "previous_writer_active"})
					return true
				}
			}
			return false
		}
	})
	if err := p.AwaitWriteAccess(context.Background()); err != nil {
		t.Fatalf("AwaitWriteAccess: %v", err)
	}
	if len(*waits) != 1 || (*waits)[0] != 42*time.Second {
		t.Fatalf("waits = %v", *waits)
	}
	if _, err := p.UploadWithDigest(context.Background(), src, objKey("files/a")); err != nil {
		t.Fatalf("upload after the fence cleared: %v", err)
	}
}

func TestWriteProviderStoredObjectDigestAndDownload(t *testing.T) {
	b := newFakeWriteBackend(t)
	p := newTestWriteProvider(t, b, Options{})
	data := patternBytes(3000)
	b.put(objKey("files/a"), data)
	d, err := p.StoredObjectDigest(context.Background(), objKey("files/a"))
	if err != nil || d.SHA256 != digestHex(data) || d.Size != 3000 {
		t.Fatalf("StoredObjectDigest = %+v %v", d, err)
	}
	if _, err := p.StoredObjectDigest(context.Background(), objKey("files/missing")); !errors.Is(err, providers.ErrObjectNotFound) {
		t.Fatalf("missing object = %v", err)
	}
	dst := filepath.Join(t.TempDir(), "out")
	if err := p.Download(objKey("files/a"), dst); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(dst)
	if string(got) != string(data) {
		t.Fatal("downloaded bytes differ")
	}
}

func TestWriteProviderListAndDelete(t *testing.T) {
	b := newFakeWriteBackend(t)
	b.set(func(b *fakeWriteBackend) { b.listPage = 2 })
	p := newTestWriteProvider(t, b, Options{})
	for _, k := range []string{"files/a", "files/b", "files/c", "manifest.json", "upload.lease"} {
		b.put(objKey(k), []byte(k))
	}
	all, err := p.List("snapshots/" + testWriteSnapshotID)
	if err != nil || len(all) != 5 {
		t.Fatalf("List = %v %v", all, err)
	}
	files, err := p.List(objKey("files"))
	if err != nil || len(files) != 3 {
		t.Fatalf("List files = %v %v", files, err)
	}
	for _, c := range b.callsFor("objects:list") {
		if prefix := c.body["prefix"].(string); !strings.HasSuffix(prefix, "/") {
			t.Fatalf("list prefix %q is not slash-terminated", prefix)
		}
	}
	if err := p.Delete(objKey("upload.lease")); err != nil {
		t.Fatal(err)
	}
	if _, ok := b.object(objKey("upload.lease")); ok {
		t.Fatal("lease not deleted")
	}
	b.set(func(b *fakeWriteBackend) {
		b.controlHook = func(op string, body map[string]any, w http.ResponseWriter) bool {
			if op == "objects:delete" {
				writeJSON(w, 200, map[string]any{"deleted": []string{}, "denied": []map[string]string{{"key": objKey("manifest.json"), "code": "reservation_sealed"}}, "failed": []any{}})
				return true
			}
			return false
		}
	})
	if err := p.Delete(objKey("manifest.json")); err == nil || !strings.Contains(err.Error(), "reservation_sealed") {
		t.Fatalf("denied delete = %v", err)
	}
}

func TestWriteProviderIdentity(t *testing.T) {
	b := newFakeWriteBackend(t)
	p := newTestWriteProvider(t, b, Options{IdentityHint: "cfg-1"})
	if got := p.BackupIdentity(); got != "s3-session|cfg-1" {
		t.Fatalf("BackupIdentity = %q", got)
	}
	var _ providers.JournalIdentity = p
	var _ providers.DigestUploader = p
	var _ providers.SnapshotIDIssuer = p
	var _ providers.StoredObjectDigester = p
	var _ providers.ContextDownloader = p
}

func TestWriteProviderRestartsStalledUploadOnFreshURL(t *testing.T) {
	b := newFakeWriteBackend(t)
	var stalled atomic.Bool
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	b.set(func(b *fakeWriteBackend) {
		b.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
			if r.Method == http.MethodPut && stalled.CompareAndSwap(false, true) {
				select {
				case <-r.Context().Done():
				case <-release:
				}
				return true
			}
			return false
		}
	})
	p := newTestWriteProvider(t, b, Options{StorageIdleTimeout: 100 * time.Millisecond})
	data := []byte("payload")
	d, err := p.UploadWithDigest(context.Background(), writeTempData(t, data), objKey("files/a"))
	if err != nil || d.SHA256 != digestHex(data) {
		t.Fatalf("upload after a stall: %+v %v", d, err)
	}
	if n := len(b.callsFor("objects:resolve")); n != 2 {
		t.Fatalf("resolve calls = %d, want a fresh URL after the stall", n)
	}
}
