package sessionbroker

import (
	"context"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

type stubLeaseDetector struct{ sessions []DetectedSession }

func (d *stubLeaseDetector) ListSessions() ([]DetectedSession, error) { return d.sessions, nil }
func (d *stubLeaseDetector) WatchSessions(ctx context.Context) <-chan SessionEvent {
	ch := make(chan SessionEvent)
	close(ch)
	return ch
}

func activeRDP(id, user string) DetectedSession {
	return DetectedSession{Session: id, Username: user, State: "active", Type: "rdp"}
}

func TestLeasedDesired(t *testing.T) {
	base := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	sysKey := HelperKey{WindowsSessionID: 3, Role: ipc.HelperRoleSystem}
	live := func() *helperLease {
		return &helperLease{key: sysKey, username: "bob", owners: map[string]time.Time{"op1": base.Add(time.Minute)}}
	}

	t.Run("owned lease on live session is desired", func(t *testing.T) {
		desired, expired := leasedDesired(map[HelperKey]*helperLease{sysKey: live()}, []DetectedSession{activeRDP("3", "bob")}, base)
		if !desired[sysKey] || len(expired) != 0 {
			t.Fatalf("desired=%v expired=%v", desired, expired)
		}
	})

	t.Run("session gone expires lease", func(t *testing.T) {
		desired, expired := leasedDesired(map[HelperKey]*helperLease{sysKey: live()}, nil, base)
		if len(desired) != 0 || len(expired) != 1 || expired[0] != sysKey {
			t.Fatalf("desired=%v expired=%v", desired, expired)
		}
	})

	t.Run("session id reused by different user expires lease", func(t *testing.T) {
		desired, expired := leasedDesired(map[HelperKey]*helperLease{sysKey: live()}, []DetectedSession{activeRDP("3", "mallory")}, base)
		if len(desired) != 0 || len(expired) != 1 {
			t.Fatalf("desired=%v expired=%v", desired, expired)
		}
	})

	t.Run("all owners expired starts linger, not expiry", func(t *testing.T) {
		lease := live()
		lease.owners = map[string]time.Time{"op1": base.Add(-time.Second)}
		desired, expired := leasedDesired(map[HelperKey]*helperLease{sysKey: lease}, []DetectedSession{activeRDP("3", "bob")}, base)
		if !desired[sysKey] || len(expired) != 0 {
			t.Fatalf("freshly idle lease must stay desired through linger; desired=%v expired=%v", desired, expired)
		}
		if lease.idleSince.IsZero() {
			t.Fatal("idleSince not stamped when owners emptied")
		}
	})

	t.Run("idle past linger expires", func(t *testing.T) {
		lease := live()
		lease.owners = map[string]time.Time{}
		lease.idleSince = base.Add(-leaseLinger - time.Second)
		_, expired := leasedDesired(map[HelperKey]*helperLease{sysKey: lease}, []DetectedSession{activeRDP("3", "bob")}, base)
		if len(expired) != 1 {
			t.Fatalf("idle-past-linger lease not expired: %v", expired)
		}
	})

	t.Run("re-acquire clears idleSince", func(t *testing.T) {
		lease := live()
		lease.owners = map[string]time.Time{}
		lease.idleSince = base.Add(-time.Minute)
		lease.owners["op2"] = base.Add(time.Minute)
		lease.idleSince = time.Time{} // AcquireLease does this; leasedDesired must then keep it
		desired, _ := leasedDesired(map[HelperKey]*helperLease{sysKey: lease}, []DetectedSession{activeRDP("3", "bob")}, base)
		if !desired[sysKey] {
			t.Fatal("re-acquired lease must be desired")
		}
	})

	t.Run("user role requires active session", func(t *testing.T) {
		userKey := HelperKey{WindowsSessionID: 3, Role: ipc.HelperRoleUser}
		lease := &helperLease{key: userKey, username: "bob", owners: map[string]time.Time{"op1": base.Add(time.Minute)}}
		disconnected := DetectedSession{Session: "3", Username: "bob", State: "disconnected", Type: "rdp"}
		desired, expired := leasedDesired(map[HelperKey]*helperLease{userKey: lease}, []DetectedSession{disconnected}, base)
		if desired[userKey] {
			t.Fatal("user-role helper must not be desired in a disconnected session")
		}
		if len(expired) != 0 {
			t.Fatal("ineligible-but-live session must not expire the lease (it may reconnect)")
		}
	})
}

func TestAcquireRenewReleaseLease(t *testing.T) {
	base := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	det := &stubLeaseDetector{sessions: []DetectedSession{activeRDP("3", "bob")}}
	m := newHelperLifecycleManager(nil, det, nil, nil)
	m.now = func() time.Time { return base }
	sysKey := HelperKey{WindowsSessionID: 3, Role: ipc.HelperRoleSystem}

	if err := m.AcquireLease(3, ipc.HelperRoleSystem, "op1", 0); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	lease := m.leases[sysKey]
	if lease == nil || lease.username != "bob" {
		t.Fatalf("lease not recorded with username: %+v", lease)
	}
	if got := lease.owners["op1"]; !got.Equal(base.Add(defaultLeaseTTL)) {
		t.Fatalf("zero ttl must clamp to default: %v", got)
	}

	if err := m.RenewLease(3, ipc.HelperRoleSystem, "op1", time.Hour); err != nil {
		t.Fatalf("renew: %v", err)
	}
	if got := lease.owners["op1"]; !got.Equal(base.Add(maxLeaseTTL)) {
		t.Fatalf("oversized ttl must clamp to max: %v", got)
	}

	if err := m.RenewLease(3, ipc.HelperRoleSystem, "ghost", time.Minute); err != ErrLeaseUnknownOwner {
		t.Fatalf("renewing unknown owner: got %v", err)
	}
	if err := m.AcquireLease(99, ipc.HelperRoleSystem, "op1", 0); err != ErrLeaseSessionNotFound {
		t.Fatalf("acquire on missing session: got %v", err)
	}
	if err := m.AcquireLease(3, ipc.HelperRoleAssist, "op1", 0); err != ErrLeaseRoleNotSpawnable {
		t.Fatalf("acquire for assist role: got %v", err)
	}

	m.ReleaseLease(3, ipc.HelperRoleSystem, "op1")
	if len(lease.owners) != 0 || lease.idleSince.IsZero() {
		t.Fatalf("release must empty owners and stamp idleSince: %+v", lease)
	}

	// Second acquire on the same key clears idleSince.
	if err := m.AcquireLease(3, ipc.HelperRoleSystem, "op2", 0); err != nil {
		t.Fatalf("re-acquire: %v", err)
	}
	if !m.leases[sysKey].idleSince.IsZero() {
		t.Fatal("re-acquire must clear idleSince")
	}
}

func TestAcquireLeaseKicksReconcile(t *testing.T) {
	det := &stubLeaseDetector{sessions: []DetectedSession{activeRDP("3", "bob")}}
	m := newHelperLifecycleManager(nil, det, nil, nil)
	if err := m.AcquireLease(3, ipc.HelperRoleSystem, "op1", 0); err != nil {
		t.Fatal(err)
	}
	select {
	case <-m.kickCh:
	default:
		t.Fatal("AcquireLease must queue a reconcile kick")
	}
}
