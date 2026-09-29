package storagesession

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

const continuationJournalID = "snapshot-20261127T090000Z-fedcba9876543210fedcba98"

func resumeAnswer(mode string, takeover bool) func(op string, body map[string]any, w http.ResponseWriter) bool {
	return func(op string, body map[string]any, w http.ResponseWriter) bool {
		if op != "snapshot:resume" {
			return false
		}
		writeJSON(w, 200, map[string]any{"snapshotId": body["snapshotId"], "mode": mode, "takeover": takeover})
		return true
	}
}

func TestWriteProviderResumeReportsATakeover(t *testing.T) {
	cases := []struct {
		mode     string
		takeover bool
		want     providers.ResumeMode
	}{
		{"write", true, providers.ResumeTakeover},
		{"write", false, providers.ResumeWrite},
		{"read_only_completion", false, providers.ResumeReadOnlyCompletion},
	}
	for _, tc := range cases {
		b := newFakeWriteBackend(t)
		b.set(func(b *fakeWriteBackend) { b.controlHook = resumeAnswer(tc.mode, tc.takeover) })
		p := newTestWriteProvider(t, b, Options{})
		got, err := p.ResumeSnapshot(context.Background(), continuationJournalID)
		if err != nil || got != tc.want {
			t.Fatalf("%s/%v: resume = %v %v, want %v", tc.mode, tc.takeover, got, err, tc.want)
		}
		if p.SnapshotID() != continuationJournalID {
			t.Fatalf("snapshot id not moved to the continued id")
		}
	}
}

func TestWriteProviderWaitsOutAFullPreviousWriterFence(t *testing.T) {
	waits := noSleep(t)
	b := newFakeWriteBackend(t)
	calls := 0
	b.set(func(b *fakeWriteBackend) {
		b.controlHook = func(op string, body map[string]any, w http.ResponseWriter) bool {
			if op != "snapshot:resume" {
				return false
			}
			calls++
			if calls <= 2 {
				// An earlier writer's URLs stay live for their TTL plus the
				// control plane's transfer margin.
				w.Header().Set("Retry-After", "600")
				writeJSON(w, 409, map[string]string{"code": "previous_writer_active"})
				return true
			}
			writeJSON(w, 200, map[string]any{"snapshotId": continuationJournalID, "mode": "write", "takeover": true})
			return true
		}
	})
	p := newTestWriteProvider(t, b, Options{})
	mode, err := p.ResumeSnapshot(context.Background(), continuationJournalID)
	if err != nil || mode != providers.ResumeTakeover {
		t.Fatalf("resume after a 20-minute fence = %v %v", mode, err)
	}
	if len(*waits) != 2 {
		t.Fatalf("waits = %v", *waits)
	}
}

func TestWriteProviderFenceWaitCoversTheServerMargin(t *testing.T) {
	if previousWriterMaxWait < serverTransferMargin+maxURLLifetime {
		t.Fatalf("previousWriterMaxWait %s does not cover the control plane's fence (%s + %s)", previousWriterMaxWait, serverTransferMargin, maxURLLifetime)
	}
	// Every attempt ends long before the control plane stops counting its
	// URL as live.
	if urlTransferGrace*10 > serverTransferMargin {
		t.Fatalf("urlTransferGrace %s is not well under the control plane's transfer margin %s", urlTransferGrace, serverTransferMargin)
	}
}

func TestWriteProviderUsesTheDeliveredStorageIdentity(t *testing.T) {
	b := newFakeWriteBackend(t)
	creds := Credentials{AgentID: testAgentID, AgentToken: testAgentToken, ControlPlaneOrigins: []string{b.control.URL}}
	d := testWriteDescriptor(b, time.Now())
	d.StorageIdentity = "s3|https://minio.example:9000|us-east-1|backups"
	p, err := NewWriteProvider(context.Background(), d, creds, Options{ControlClient: b.control.Client(), IdentityHint: "cfg-1"})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if got := p.BackupIdentity(); got != d.StorageIdentity {
		t.Fatalf("BackupIdentity = %q, want the delivered %q", got, d.StorageIdentity)
	}
	if got := p.JournalScope(); got != "config=cfg-1" {
		t.Fatalf("JournalScope = %q; each configuration needs its own journal", got)
	}
	// The same destination through the credential-based S3 provider.
	legacy := providers.NewS3ProviderWithEndpoint("backups", "us-east-1", "https://minio.example:9000", "ak", "sk", "")
	if legacy.BackupIdentity() != p.BackupIdentity() {
		t.Fatalf("identities differ: %q vs %q", legacy.BackupIdentity(), p.BackupIdentity())
	}
	for _, bad := range []string{"gcs|x", "s3|a\nb|c|d", "s3|" + strings.Repeat("x", 2000)} {
		d2 := testWriteDescriptor(b, time.Now())
		d2.StorageIdentity = bad
		if q, err := NewWriteProvider(context.Background(), d2, creds, Options{ControlClient: b.control.Client()}); err == nil {
			q.Close()
			t.Fatalf("storage identity %q accepted", bad)
		}
	}
}

func TestWriteProviderMultipartNullEncryption(t *testing.T) {
	for _, required := range []bool{true, false} {
		b := newFakeWriteBackend(t)
		b.set(func(b *fakeWriteBackend) {
			b.createEncryptionNull = true
			if required {
				b.sse = map[string]string{"x-amz-server-side-encryption": "AES256"}
			}
		})
		p := newTestWriteProvider(t, b, Options{})
		p.singlePutMax = 1 << 10
		p.partSize = 2 << 10
		p.minPartSize = 1 << 10
		if required {
			p.SetServerSideEncryption("AES256", "")
		}
		_, err := p.UploadWithDigest(context.Background(), writeTempData(t, patternBytes(5<<10)), objKey("files/big"))
		if required && err == nil {
			t.Fatal("null appliedEncryption accepted when encryption is required")
		}
		if !required && err != nil {
			t.Fatalf("null appliedEncryption without required encryption: %v", err)
		}
	}
}
