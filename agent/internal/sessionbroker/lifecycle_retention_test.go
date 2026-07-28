package sessionbroker

import (
	"context"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestApplyDisconnectedRetention(t *testing.T) {
	base := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	ttl := 10 * time.Minute
	sysKey := func(id uint32) HelperKey { return HelperKey{WindowsSessionID: id, Role: ipc.HelperRoleSystem} }
	userKey := func(id uint32) HelperKey { return HelperKey{WindowsSessionID: id, Role: ipc.HelperRoleUser} }

	rdpDisconnected := DetectedSession{Session: "3", Type: "rdp", State: "disconnected"}
	rdpActive := DetectedSession{Session: "3", Type: "rdp", State: "active"}

	t.Run("first sighting records but does not prune", func(t *testing.T) {
		desired := map[HelperKey]bool{sysKey(3): true}
		seen := map[uint32]time.Time{}
		applyDisconnectedRetention(desired, []DetectedSession{rdpDisconnected}, seen, base, ttl)
		if !desired[sysKey(3)] {
			t.Fatal("system key pruned on first sighting")
		}
		if _, ok := seen[3]; !ok {
			t.Fatal("disconnected-since not recorded")
		}
	})

	t.Run("prunes system key after ttl", func(t *testing.T) {
		desired := map[HelperKey]bool{sysKey(3): true}
		seen := map[uint32]time.Time{3: base}
		applyDisconnectedRetention(desired, []DetectedSession{rdpDisconnected}, seen, base.Add(ttl), ttl)
		if desired[sysKey(3)] {
			t.Fatal("system key not pruned after ttl")
		}
	})

	t.Run("under ttl is retained", func(t *testing.T) {
		desired := map[HelperKey]bool{sysKey(3): true}
		seen := map[uint32]time.Time{3: base}
		applyDisconnectedRetention(desired, []DetectedSession{rdpDisconnected}, seen, base.Add(ttl-time.Second), ttl)
		if !desired[sysKey(3)] {
			t.Fatal("system key pruned before ttl elapsed")
		}
	})

	t.Run("reconnect clears tracking", func(t *testing.T) {
		desired := map[HelperKey]bool{sysKey(3): true, userKey(3): true}
		seen := map[uint32]time.Time{3: base}
		applyDisconnectedRetention(desired, []DetectedSession{rdpActive}, seen, base.Add(ttl), ttl)
		if _, ok := seen[3]; ok {
			t.Fatal("tracking not cleared when session left disconnected state")
		}
		if !desired[sysKey(3)] || !desired[userKey(3)] {
			t.Fatal("active session keys must be untouched")
		}
	})

	t.Run("session gone from snapshot clears tracking", func(t *testing.T) {
		desired := map[HelperKey]bool{}
		seen := map[uint32]time.Time{3: base}
		applyDisconnectedRetention(desired, nil, seen, base.Add(ttl), ttl)
		if len(seen) != 0 {
			t.Fatalf("stale tracking entries remain: %v", seen)
		}
	})

	t.Run("console disconnected sessions are not tracked", func(t *testing.T) {
		desired := map[HelperKey]bool{sysKey(2): true}
		seen := map[uint32]time.Time{}
		applyDisconnectedRetention(desired, []DetectedSession{{Session: "2", Type: "console", State: "disconnected"}}, seen, base, ttl)
		if len(seen) != 0 {
			t.Fatal("console session must not be tracked for RDP retention")
		}
	})
}

type stubRetentionDetector struct{ sessions []DetectedSession }

func (d *stubRetentionDetector) ListSessions() ([]DetectedSession, error) { return d.sessions, nil }
func (d *stubRetentionDetector) WatchSessions(ctx context.Context) <-chan SessionEvent {
	ch := make(chan SessionEvent)
	close(ch)
	return ch
}

func TestDetectedDesiredPrunesLongDisconnectedRDP(t *testing.T) {
	det := &stubRetentionDetector{sessions: []DetectedSession{
		{Session: "3", Username: "bob", Type: "rdp", State: "disconnected"},
	}}
	m := newHelperLifecycleManager(nil, det, nil, nil)

	base := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	current := base
	m.now = func() time.Time { return current }

	sysKey := HelperKey{WindowsSessionID: 3, Role: ipc.HelperRoleSystem}

	desired, err := m.detectedDesired()
	if err != nil {
		t.Fatal(err)
	}
	if !desired[sysKey] {
		t.Fatal("freshly disconnected RDP session should still desire a SYSTEM helper")
	}

	current = base.Add(disconnectedHelperRetention + time.Second)
	desired, err = m.detectedDesired()
	if err != nil {
		t.Fatal(err)
	}
	if desired[sysKey] {
		t.Fatal("SYSTEM helper still desired after retention window elapsed")
	}
}
