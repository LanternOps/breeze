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

	t.Run("system role lease on disconnected rdp session is not desired but not expired", func(t *testing.T) {
		lease := &helperLease{key: sysKey, username: "bob", owners: map[string]time.Time{"op1": base.Add(time.Minute)}}
		disconnected := DetectedSession{Session: "3", Username: "bob", State: "disconnected", Type: "rdp"}
		desired, expired := leasedDesired(map[HelperKey]*helperLease{sysKey: lease}, []DetectedSession{disconnected}, base)
		if desired[sysKey] {
			t.Fatal("on-demand system-role helper must not be desired in a disconnected session — disconnected sessions aren't shadowable")
		}
		if len(expired) != 0 {
			t.Fatal("disconnected-but-live session must not expire the lease (it may reconnect)")
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

func TestComputeDesiredModeSwitch(t *testing.T) {
	det := &stubLeaseDetector{sessions: []DetectedSession{activeRDP("3", "bob")}}
	sysKey := HelperKey{WindowsSessionID: 3, Role: ipc.HelperRoleSystem}
	userKey := HelperKey{WindowsSessionID: 3, Role: ipc.HelperRoleUser}

	t.Run("always-on ignores leases and desires every eligible session", func(t *testing.T) {
		m := newHelperLifecycleManager(nil, det, nil, nil)
		desired, err := m.computeDesired()
		if err != nil {
			t.Fatal(err)
		}
		if !desired[sysKey] || !desired[userKey] {
			t.Fatalf("always-on must desire both roles: %v", desired)
		}
	})

	t.Run("on-demand with no leases desires nothing", func(t *testing.T) {
		m := newHelperLifecycleManager(nil, det, nil, nil)
		m.mode = LifecycleModeOnDemand
		desired, err := m.computeDesired()
		if err != nil {
			t.Fatal(err)
		}
		if len(desired) != 0 {
			t.Fatalf("on-demand at rest must desire nothing: %v", desired)
		}
	})

	t.Run("on-demand desires exactly the leased key and reaps expired leases", func(t *testing.T) {
		m := newHelperLifecycleManager(nil, det, nil, nil)
		m.mode = LifecycleModeOnDemand
		if err := m.AcquireLease(3, ipc.HelperRoleSystem, "op1", 0); err != nil {
			t.Fatal(err)
		}
		desired, err := m.computeDesired()
		if err != nil {
			t.Fatal(err)
		}
		if !desired[sysKey] || desired[userKey] || len(desired) != 1 {
			t.Fatalf("on-demand must desire exactly the leased key: %v", desired)
		}

		// Session disappears -> lease reaped from the table on next compute.
		det2 := &stubLeaseDetector{}
		m.detector = det2
		desired, err = m.computeDesired()
		if err != nil {
			t.Fatal(err)
		}
		if len(desired) != 0 {
			t.Fatalf("gone session must not be desired: %v", desired)
		}
		m.mu.Lock()
		_, still := m.leases[sysKey]
		m.mu.Unlock()
		if still {
			t.Fatal("expired lease must be deleted from the table")
		}
	})
}

func TestDropLeases(t *testing.T) {
	det := &stubLeaseDetector{sessions: []DetectedSession{activeRDP("3", "bob")}}
	m := newHelperLifecycleManager(nil, det, nil, nil)
	m.mode = LifecycleModeOnDemand
	if err := m.AcquireLease(3, ipc.HelperRoleSystem, "op1", 0); err != nil {
		t.Fatal(err)
	}
	if err := m.AcquireLease(3, ipc.HelperRoleUser, "op1", 0); err != nil {
		t.Fatal(err)
	}
	m.dropLeases(3, ipc.HelperRoleSystem, ipc.HelperRoleUser)
	desired, err := m.computeDesired()
	if err != nil {
		t.Fatal(err)
	}
	if len(desired) != 0 {
		t.Fatalf("dropped leases must leave nothing desired: %v", desired)
	}
}

// #6812: an on-demand connect to a logged-off console must be able to learn,
// before it waits, that no user-role helper can exist there. The Winlogon
// console reports WTSConnected with no username; a signed-in (even locked)
// session reports WTSActive with one.
func TestHelperRoleAvailable(t *testing.T) {
	det := &stubLeaseDetector{sessions: []DetectedSession{
		activeRDP("3", "bob"),
		{Session: "2", Username: "", State: "connected", Type: "console"},     // logged-off console (Winlogon)
		{Session: "4", Username: "", State: "active", Type: "console"},        // active but no user token source
		{Session: "5", Username: "carol", State: "disconnected", Type: "rdp"}, // user present, not at the screen
	}}
	m := newHelperLifecycleManager(nil, det, nil, nil)

	tests := []struct {
		name    string
		key     HelperKey
		want    bool
		wantErr error
	}{
		{"signed-in session hosts a user helper", HelperKey{3, ipc.HelperRoleUser}, true, nil},
		{"signed-in session hosts a system helper", HelperKey{3, ipc.HelperRoleSystem}, true, nil},
		{"logged-off console cannot host a user helper", HelperKey{2, ipc.HelperRoleUser}, false, nil},
		{"logged-off console still hosts a system helper", HelperKey{2, ipc.HelperRoleSystem}, true, nil},
		{"active session with no username cannot host a user helper", HelperKey{4, ipc.HelperRoleUser}, false, nil},
		{"disconnected session cannot host a user helper", HelperKey{5, ipc.HelperRoleUser}, false, nil},
		{"missing session reports not found", HelperKey{99, ipc.HelperRoleUser}, false, ErrLeaseSessionNotFound},
		{"non-lifecycle role is refused", HelperKey{3, ipc.HelperRoleAssist}, false, ErrLeaseRoleNotSpawnable},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := m.HelperRoleAvailable(tt.key)
			if err != tt.wantErr {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Fatalf("available = %v, want %v", got, tt.want)
			}
		})
	}

	t.Run("no detector reports not found", func(t *testing.T) {
		bare := newHelperLifecycleManager(nil, nil, nil, nil)
		if _, err := bare.HelperRoleAvailable(HelperKey{3, ipc.HelperRoleUser}); err != ErrLeaseSessionNotFound {
			t.Fatalf("err = %v, want ErrLeaseSessionNotFound", err)
		}
	})
}
