package sessionbroker

import (
	"context"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// rdsHostSessions models an RD Session Host at rest: two signed-in RDP users,
// a logon-screen session nobody has signed into yet, a disconnected user, and
// the services session.
func rdsHostSessions() []DetectedSession {
	return []DetectedSession{
		{Session: "0", State: "disconnected", Type: "services"},
		{Session: "2", Username: "alice", State: "active", Type: "rdp"},
		{Session: "3", Username: "bob", State: "active", Type: "rdp"},
		{Session: "4", State: "connected", Type: "rdp"},
		{Session: "5", Username: "carol", State: "disconnected", Type: "rdp"},
	}
}

func sysKey(id uint32) HelperKey  { return HelperKey{WindowsSessionID: id, Role: ipc.HelperRoleSystem} }
func userKey(id uint32) HelperKey { return HelperKey{WindowsSessionID: id, Role: ipc.HelperRoleUser} }

func desiredKeys(t *testing.T, m *HelperLifecycleManager) []HelperKey {
	t.Helper()
	desired, err := m.computeDesired()
	if err != nil {
		t.Fatalf("computeDesired: %v", err)
	}
	keys := make([]HelperKey, 0, len(desired))
	for key, wanted := range desired {
		if wanted {
			keys = append(keys, key)
		}
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i].String() < keys[j].String() })
	return keys
}

func onDemandHarness(t *testing.T, sessions []DetectedSession) (*HelperLifecycleManager, *countingHelperSpawner) {
	t.Helper()
	spawner := newCountingHelperSpawner()
	m := newLifecycleHarness(t, sessions, spawner)
	m.mode = LifecycleModeOnDemand
	m.rdsHost = true
	return m, spawner
}

// #8996: with UAC interception on, an on-demand (RDS) host must keep a SYSTEM
// helper in every session a user is signed into — that helper is what shows
// the PAM dialog and drives consent.exe.
func TestPAMHoldOnDemandSpawnsSystemHelperPerSignedInSession(t *testing.T) {
	m, spawner := onDemandHarness(t, rdsHostSessions())
	m.SetPAMHelperHold(true)

	m.reconcile()

	for _, key := range []HelperKey{sysKey(2), sysKey(3)} {
		if got := spawner.SpawnCount(key); got != 1 {
			t.Fatalf("%s spawned %d times, want 1", key, got)
		}
	}
	if got := spawner.TotalSpawnCount(); got != 2 {
		t.Fatalf("spawned %d helpers (%v), want exactly the 2 signed-in SYSTEM helpers — no user role, no logon-screen, disconnected or services session", got, spawner.Keys())
	}
}

func TestPAMHoldOffSpawnsNothingAtRestOnDemand(t *testing.T) {
	m, spawner := onDemandHarness(t, rdsHostSessions())

	m.reconcile()

	if got := spawner.TotalSpawnCount(); got != 0 {
		t.Fatalf("spawned %d helpers with interception off, want 0 (on-demand at rest)", got)
	}
}

func TestPAMHoldReleaseReapsHeldHelpers(t *testing.T) {
	m, _ := onDemandHarness(t, rdsHostSessions())
	m.SetPAMHelperHold(true)
	if got := desiredKeys(t, m); len(got) != 2 {
		t.Fatalf("held desired = %v, want 2 SYSTEM keys", got)
	}

	m.SetPAMHelperHold(false)

	if got := desiredKeys(t, m); len(got) != 0 {
		t.Fatalf("desired after interception turned off = %v, want empty", got)
	}
}

// Remote-desktop leases must behave exactly as before, with or without the
// PAM hold: the RD lease still brings its user-role helper, and the hold adds
// only SYSTEM helpers.
func TestPAMHoldLeavesRemoteDesktopLeasesUnchanged(t *testing.T) {
	m, _ := onDemandHarness(t, rdsHostSessions())
	if err := m.AcquireLease(3, ipc.HelperRoleSystem, "desk-1", 0); err != nil {
		t.Fatalf("acquire system: %v", err)
	}
	if err := m.AcquireLease(3, ipc.HelperRoleUser, "desk-1", 0); err != nil {
		t.Fatalf("acquire user: %v", err)
	}

	without := desiredKeys(t, m)
	if want := []HelperKey{sysKey(3), userKey(3)}; !equalKeys(without, want) {
		t.Fatalf("RD-lease desired = %v, want %v", without, want)
	}

	m.SetPAMHelperHold(true)
	with := desiredKeys(t, m)
	if want := []HelperKey{sysKey(2), sysKey(3), userKey(3)}; !equalKeys(with, want) {
		t.Fatalf("RD-lease + PAM hold desired = %v, want %v", with, want)
	}

	m.SetPAMHelperHold(false)
	if got := desiredKeys(t, m); !equalKeys(got, without) {
		t.Fatalf("releasing the PAM hold changed RD leases: %v, want %v", got, without)
	}
	m.mu.Lock()
	leases := len(m.leases)
	m.mu.Unlock()
	if leases != 2 {
		t.Fatalf("lease table has %d entries after hold release, want the 2 RD leases", leases)
	}
}

// A user whose username query failed is still treated as signed in: failing
// toward a helper keeps PAM working, while failing away silently drops it.
func TestPAMHoldIncludesUsernameUnknownActiveSession(t *testing.T) {
	m, _ := onDemandHarness(t, []DetectedSession{{Session: "6", State: "active", Type: "rdp", UsernameUnknown: true}})
	m.SetPAMHelperHold(true)
	if got := desiredKeys(t, m); !equalKeys(got, []HelperKey{sysKey(6)}) {
		t.Fatalf("desired = %v, want [6-system]", got)
	}
}

// The hold is a policy, not mode state: a server-driven flip to always-on and
// back must not drop it.
func TestPAMHoldSurvivesModeOverrideFlip(t *testing.T) {
	m, _ := onDemandHarness(t, rdsHostSessions())
	m.SetPAMHelperHold(true)

	m.SetModeOverride(string(LifecycleModeAlwaysOn))
	m.SetModeOverride(string(LifecycleModeOnDemand))

	if got := desiredKeys(t, m); !equalKeys(got, []HelperKey{sysKey(2), sysKey(3)}) {
		t.Fatalf("desired after mode flip = %v, want the 2 held SYSTEM keys", got)
	}
}

// Always-on already spawns for every eligible session; the hold must not
// change that desired set.
func TestPAMHoldNoOpInAlwaysOnMode(t *testing.T) {
	spawner := newCountingHelperSpawner()
	m := newLifecycleHarness(t, rdsHostSessions(), spawner)
	m.consoleSessionIDFn = func() string { return "1" }
	before := desiredKeys(t, m)
	m.SetPAMHelperHold(true)
	if after := desiredKeys(t, m); !equalKeys(before, after) {
		t.Fatalf("always-on desired changed with PAM hold: before=%v after=%v", before, after)
	}
}

// A WTSConnected session with a known user (mid-logon / reconnect) is held;
// one without a user is a logon screen and is not. A non-numeric session id
// is skipped.
func TestPAMHoldIncludesConnectedSessionWithUser(t *testing.T) {
	m, _ := onDemandHarness(t, []DetectedSession{
		{Session: "7", Username: "dave", State: "connected", Type: "rdp"},
		{Session: "8", State: "connected", Type: "rdp"},
		{Session: "x", Username: "eve", State: "active", Type: "rdp"},
	})
	m.SetPAMHelperHold(true)
	if got := desiredKeys(t, m); !equalKeys(got, []HelperKey{sysKey(7)}) {
		t.Fatalf("desired = %v, want [7-system]", got)
	}
}

type mutableLifecycleDetector struct {
	mu       sync.Mutex
	sessions []DetectedSession
}

func (d *mutableLifecycleDetector) set(sessions ...DetectedSession) {
	d.mu.Lock()
	d.sessions = sessions
	d.mu.Unlock()
}

func (d *mutableLifecycleDetector) ListSessions() ([]DetectedSession, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]DetectedSession(nil), d.sessions...), nil
}

func (d *mutableLifecycleDetector) WatchSessions(context.Context) <-chan SessionEvent {
	ch := make(chan SessionEvent)
	close(ch)
	return ch
}

// Disconnect then reconnect: the held helper is reaped while the session is
// disconnected (no input desktop for the dialog) and comes back on reconnect.
func TestPAMHoldFollowsDisconnectAndReconnect(t *testing.T) {
	det := &mutableLifecycleDetector{}
	det.set(DetectedSession{Session: "2", Username: "alice", State: "active", Type: "rdp"})
	spawner := newCountingHelperSpawner()
	b := New("lifecycle-"+t.Name(), nil)
	m := newHelperLifecycleManager(b, det, nil, spawner)
	m.gracePeriod = 5 * time.Millisecond
	m.finalWait = 100 * time.Millisecond
	m.mode = LifecycleModeOnDemand
	m.rdsHost = true
	t.Cleanup(func() { m.Stop(); b.Close() })
	m.SetPAMHelperHold(true)

	m.reconcile()
	if got := m.registry.keys(); !equalKeys(got, []HelperKey{sysKey(2)}) {
		t.Fatalf("tracked after logon = %v, want [2-system]", got)
	}

	det.set(DetectedSession{Session: "2", Username: "alice", State: "disconnected", Type: "rdp"})
	m.reconcile()
	if got := m.registry.keys(); len(got) != 0 {
		t.Fatalf("tracked after disconnect = %v, want none", got)
	}

	det.set(DetectedSession{Session: "2", Username: "alice", State: "active", Type: "rdp"})
	m.reconcile()
	if got := m.registry.keys(); !equalKeys(got, []HelperKey{sysKey(2)}) {
		t.Fatalf("tracked after reconnect = %v, want [2-system]", got)
	}
	if got := spawner.SpawnCount(sysKey(2)); got != 2 {
		t.Fatalf("2-system spawned %d times, want 2 (logon + reconnect)", got)
	}
}

func equalKeys(a, b []HelperKey) bool {
	if len(a) != len(b) {
		return false
	}
	a = append([]HelperKey(nil), a...)
	b = append([]HelperKey(nil), b...)
	sort.Slice(a, func(i, j int) bool { return a[i].String() < a[j].String() })
	sort.Slice(b, func(i, j int) bool { return b[i].String() < b[j].String() })
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
