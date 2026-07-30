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
		applyDisconnectedRetention(desired, []DetectedSession{rdpDisconnected}, seen, base, ttl, false, "1")
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
		applyDisconnectedRetention(desired, []DetectedSession{rdpDisconnected}, seen, base.Add(ttl), ttl, false, "1")
		if desired[sysKey(3)] {
			t.Fatal("system key not pruned after ttl")
		}
	})

	t.Run("under ttl is retained", func(t *testing.T) {
		desired := map[HelperKey]bool{sysKey(3): true}
		seen := map[uint32]time.Time{3: base}
		applyDisconnectedRetention(desired, []DetectedSession{rdpDisconnected}, seen, base.Add(ttl-time.Second), ttl, false, "1")
		if !desired[sysKey(3)] {
			t.Fatal("system key pruned before ttl elapsed")
		}
	})

	t.Run("reconnect clears tracking", func(t *testing.T) {
		desired := map[HelperKey]bool{sysKey(3): true, userKey(3): true}
		seen := map[uint32]time.Time{3: base}
		applyDisconnectedRetention(desired, []DetectedSession{rdpActive}, seen, base.Add(ttl), ttl, false, "1")
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
		applyDisconnectedRetention(desired, nil, seen, base.Add(ttl), ttl, false, "1")
		if len(seen) != 0 {
			t.Fatalf("stale tracking entries remain: %v", seen)
		}
	})

	t.Run("console disconnected sessions are not tracked on a workstation", func(t *testing.T) {
		desired := map[HelperKey]bool{sysKey(2): true}
		seen := map[uint32]time.Time{}
		applyDisconnectedRetention(desired, []DetectedSession{{Session: "2", Type: "console", State: "disconnected"}}, seen, base, ttl, false, "1")
		if len(seen) != 0 {
			t.Fatal("console session must not be tracked for RDP retention on a workstation (rdsHost=false)")
		}
	})

	// --- RDS-aware behavior (rdsHost=true) ---

	t.Run("rdsHost: disconnected former-RDP session now reporting Type=console is tracked", func(t *testing.T) {
		// The core bug this fix addresses: on a real RDS host,
		// WTSClientProtocolType reverts to 0 the moment a session disconnects,
		// so the detector reports Type="console" even though this was an RDP
		// session. Retention must key on state+non-console, not Type.
		desired := map[HelperKey]bool{sysKey(7): true}
		seen := map[uint32]time.Time{}
		formerRDPNowConsole := DetectedSession{Session: "7", Type: "console", State: "disconnected"}
		applyDisconnectedRetention(desired, []DetectedSession{formerRDPNowConsole}, seen, base, ttl, true, "1")
		if !desired[sysKey(7)] {
			t.Fatal("system key pruned on first sighting")
		}
		if _, ok := seen[7]; !ok {
			t.Fatal("disconnected-since not recorded for RDS non-console session")
		}

		applyDisconnectedRetention(desired, []DetectedSession{formerRDPNowConsole}, seen, base.Add(ttl), ttl, true, "1")
		if desired[sysKey(7)] {
			t.Fatal("system key not pruned after ttl on RDS host")
		}
	})

	t.Run("rdsHost: the physical console session itself is never tracked", func(t *testing.T) {
		desired := map[HelperKey]bool{sysKey(1): true}
		seen := map[uint32]time.Time{}
		consoleDisconnected := DetectedSession{Session: "1", Type: "console", State: "disconnected"}
		applyDisconnectedRetention(desired, []DetectedSession{consoleDisconnected}, seen, base, ttl, true, "1")
		if len(seen) != 0 {
			t.Fatal("console session must never be tracked for retention, even on an RDS host")
		}
	})

	t.Run("rdsHost=false leaves a Type=console disconnected session untracked (unchanged workstation behavior)", func(t *testing.T) {
		desired := map[HelperKey]bool{sysKey(7): true}
		seen := map[uint32]time.Time{}
		formerRDPNowConsole := DetectedSession{Session: "7", Type: "console", State: "disconnected"}
		applyDisconnectedRetention(desired, []DetectedSession{formerRDPNowConsole}, seen, base, ttl, false, "1")
		if len(seen) != 0 {
			t.Fatal("workstation path (rdsHost=false) must remain keyed on Type==rdp only")
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

// TestDetectedDesiredPrunesLongDisconnectedNonConsoleOnRDSHost is the RDS
// analogue of TestDetectedDesiredPrunesLongDisconnectedRDP: on an RDS host the
// detector reports a disconnected former-RDP session as Type="console" (WTS
// protocol type reverts to 0 on disconnect), so retention must still engage
// via state+non-console rather than Type=="rdp".
func TestDetectedDesiredPrunesLongDisconnectedNonConsoleOnRDSHost(t *testing.T) {
	det := &stubRetentionDetector{sessions: []DetectedSession{
		{Session: "7", Username: "bob", Type: "console", State: "disconnected"},
	}}
	m := newHelperLifecycleManager(nil, det, nil, nil)
	m.rdsHost = true
	m.consoleSessionIDFn = func() string { return "1" }

	base := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	current := base
	m.now = func() time.Time { return current }

	sysKey := HelperKey{WindowsSessionID: 7, Role: ipc.HelperRoleSystem}

	desired, err := m.detectedDesired()
	if err != nil {
		t.Fatal(err)
	}
	if !desired[sysKey] {
		t.Fatal("freshly disconnected non-console RDS session should still desire a SYSTEM helper")
	}

	current = base.Add(disconnectedHelperRetention + time.Second)
	desired, err = m.detectedDesired()
	if err != nil {
		t.Fatal(err)
	}
	if desired[sysKey] {
		t.Fatal("SYSTEM helper still desired after retention window elapsed on RDS host")
	}
}

// TestDetectedDesiredSameSessionRDSWorkstationUnchanged proves the workstation
// (rdsHost=false) path is unaffected by this change: the exact same disconnected
// Type="console" session that is retained on an RDS host must NOT be tracked or
// retained when rdsHost is false.
func TestDetectedDesiredSameSessionRDSWorkstationUnchanged(t *testing.T) {
	det := &stubRetentionDetector{sessions: []DetectedSession{
		{Session: "7", Username: "bob", Type: "console", State: "disconnected"},
	}}
	m := newHelperLifecycleManager(nil, det, nil, nil)
	// m.rdsHost defaults to false (zero value).

	sysKey := HelperKey{WindowsSessionID: 7, Role: ipc.HelperRoleSystem}
	desired, err := m.detectedDesired()
	if err != nil {
		t.Fatal(err)
	}
	if desired[sysKey] {
		t.Fatal("workstation (rdsHost=false) must not retain a disconnected Type=console session")
	}
}

// TestDetectedDesiredResolvesConsoleSessionIDBeforeLock is a regression test for
// the locking constraint in detectedDesired: GetConsoleSessionID makes a WTS
// syscall and MUST be resolved before m.mu is taken. If detectedDesired ever
// regresses to calling consoleSessionIDFn while holding m.mu, this test
// deadlocks (and is bounded by a timeout so it fails loudly instead of hanging
// the suite).
func TestDetectedDesiredResolvesConsoleSessionIDBeforeLock(t *testing.T) {
	det := &stubRetentionDetector{sessions: []DetectedSession{
		{Session: "7", Type: "console", State: "disconnected"},
	}}
	m := newHelperLifecycleManager(nil, det, nil, nil)
	m.rdsHost = true

	called := make(chan struct{}, 1)
	m.consoleSessionIDFn = func() string {
		// Acquiring m.mu here proves detectedDesired had not already locked it.
		if !m.mu.TryLock() {
			t.Error("consoleSessionIDFn ran while detectedDesired held m.mu")
		} else {
			m.mu.Unlock()
		}
		called <- struct{}{}
		return "1"
	}

	done := make(chan struct{})
	go func() {
		_, _ = m.detectedDesired()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("detectedDesired deadlocked: consoleSessionIDFn must be called before taking m.mu")
	}

	select {
	case <-called:
	default:
		t.Fatal("consoleSessionIDFn was never invoked")
	}
}
