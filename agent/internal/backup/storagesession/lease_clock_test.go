package storagesession

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// The lease is renewed on the control plane's timeline whatever the device
// clock says: a device ten minutes slow still renews once a third of the
// lease remains, and one ten minutes fast does not renew on every call.

func TestReadLeaseRenewalFollowsTheControlPlaneClock(t *testing.T) {
	for _, offset := range []time.Duration{-10 * time.Minute, 10 * time.Minute} {
		t.Run(offset.String(), func(t *testing.T) {
			server := &fakeClock{now: time.Now().Truncate(time.Second)}
			device := func() time.Time { return server.Now().Add(offset) }
			st := newFakeStorage(t)
			cp := newFakeControlPlane(t, st)
			cp.set(func(cp *fakeControlPlane) { cp.now = server.Now })
			d := testDescriptor(cp, server.Now())
			d.ExpiresAt = server.Now().Add(90 * time.Second).UTC().Format(time.RFC3339)
			d.Deadline = server.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339)
			p := newTestProvider(t, cp, d, Options{Now: device, RenewCheckInterval: time.Hour})
			dir := t.TempDir()
			fetch := func(name string) {
				t.Helper()
				err := p.Download("snapshots/s1/files/"+name, filepath.Join(dir, name))
				if err != nil && !errors.Is(err, providers.ErrObjectNotFound) {
					t.Fatalf("Download %s: %v", name, err)
				}
			}
			fetch("a")
			base := cp.renews()
			fetch("b")
			if cp.renews() != base {
				t.Fatal("renewed again with the whole lease left")
			}
			server.Advance(65 * time.Second) // 25 s of the 90 s lease left
			fetch("c")
			renewed := cp.renews()
			if renewed < 1 {
				t.Fatal("the lease was not renewed once a third of it remained")
			}
			server.Advance(4 * time.Minute) // well inside the renewed 15-minute lease
			fetch("d")
			if cp.renews() != renewed {
				t.Fatalf("renew calls = %d, want %d: renewed with most of the renewed lease left", cp.renews(), renewed)
			}
		})
	}
}

func TestWriteLeaseRenewalFollowsTheControlPlaneClock(t *testing.T) {
	for _, offset := range []time.Duration{-10 * time.Minute, 10 * time.Minute} {
		t.Run(offset.String(), func(t *testing.T) {
			server := &fakeClock{now: time.Now().Truncate(time.Second)}
			device := func() time.Time { return server.Now().Add(offset) }
			b := newFakeWriteBackend(t)
			b.set(func(b *fakeWriteBackend) { b.nowFn = server.Now })
			d := testWriteDescriptor(b, server.Now())
			d.ExpiresAt = server.Now().Add(90 * time.Second).UTC().Format(time.RFC3339)
			d.Deadline = server.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339)
			creds := Credentials{AgentID: testAgentID, AgentToken: testAgentToken, ControlPlaneOrigins: []string{b.control.URL}}
			p, err := NewWriteProvider(context.Background(), d, creds, Options{
				ControlClient: b.control.Client(), StorageClient: b.storage.Client(), Now: device, RenewCheckInterval: time.Hour,
			})
			if err != nil {
				t.Fatal(err)
			}
			defer p.Close()
			touch := func() {
				t.Helper()
				if err := p.AwaitWriteAccess(context.Background()); err != nil {
					t.Fatalf("control call: %v", err)
				}
			}
			renews := func() int { return len(b.callsFor("renew")) }
			touch()
			base := renews()
			touch()
			if renews() != base {
				t.Fatal("renewed again with the whole lease left")
			}
			server.Advance(65 * time.Second)
			touch()
			renewed := renews()
			if renewed < 1 {
				t.Fatal("the lease was not renewed once a third of it remained")
			}
			server.Advance(4 * time.Minute)
			touch()
			if renews() != renewed {
				t.Fatalf("renew calls = %d, want %d: renewed with most of the renewed lease left", renews(), renewed)
			}
		})
	}
}
