package helper

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"
)

// fakeHelperProcs is a stand-in OS process table for the duplicate-sweep tests.
// stop() removes a PID the way a successful TerminateProcess would.
type fakeHelperProcs struct {
	procs   []helperInstance
	listErr error
	stopped []int
}

func (f *fakeHelperProcs) list(string) ([]helperInstance, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	return append([]helperInstance(nil), f.procs...), nil
}

func (f *fakeHelperProcs) stop(pid int, _ string) (bool, error) {
	for i, p := range f.procs {
		if p.PID == pid {
			f.procs = append(f.procs[:i], f.procs[i+1:]...)
			f.stopped = append(f.stopped, pid)
			return true, nil
		}
	}
	return false, nil
}

func (f *fakeHelperProcs) alive(pid int) bool {
	for _, p := range f.procs {
		if p.PID == pid {
			return true
		}
	}
	return false
}

func (f *fakeHelperProcs) stoppedSorted() []int {
	out := append([]int(nil), f.stopped...)
	sort.Ints(out)
	return out
}

func installFakeProcs(t *testing.T, f *fakeHelperProcs) {
	t.Helper()
	orig := listHelperInstancesFunc
	t.Cleanup(func() { listHelperInstancesFunc = orig })
	listHelperInstancesFunc = f.list
}

func newSweepManager(t *testing.T, f *fakeHelperProcs) (*Manager, string) {
	t.Helper()
	tmpDir := t.TempDir()
	origRemove := removeAutoStartFunc
	origStopLegacy := stopHelperLegacyFunc
	t.Cleanup(func() {
		removeAutoStartFunc = origRemove
		stopHelperLegacyFunc = origStopLegacy
	})
	removeAutoStartFunc = func() error { return nil }
	stopHelperLegacyFunc = func() {}
	installFakeProcs(t, f)

	mgr := New(context.Background(), nil, nil, "")
	mgr.baseDir = tmpDir
	helperBinary := filepath.Join(tmpDir, "breeze-helper")
	if err := os.WriteFile(helperBinary, []byte("bin"), 0755); err != nil {
		t.Fatal(err)
	}
	mgr.binaryPath = helperBinary
	mgr.stopIfOursFunc = f.stop
	mgr.isOurProcessFunc = func(pid int, _ string) bool { return f.alive(pid) }
	return mgr, tmpDir
}

func writeSessionStatus(t *testing.T, baseDir, key, body string) {
	t.Helper()
	p := filepath.Join(baseDir, "sessions", key, "helper_status.yaml")
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0644); err != nil {
		t.Fatal(err)
	}
}

var sweepEpoch = time.Date(2026, 9, 17, 0, 0, 0, 0, time.UTC)

func inst(pid int, session string, ageMinutes int) helperInstance {
	return helperInstance{PID: pid, SessionKey: session, Created: sweepEpoch.Add(-time.Duration(ageMinutes) * time.Minute)}
}

// #6251: fifteen helpers accumulated in one console session because nothing
// ever removed an extra instance once it existed. A heartbeat Apply must leave
// exactly one, and must not touch helpers in any other session.
func TestApplyReapsDuplicateHelpersInManagedSession(t *testing.T) {
	f := &fakeHelperProcs{procs: []helperInstance{
		inst(300, "1", 10),
		inst(100, "1", 30), // oldest → survivor (nothing tracked)
		inst(200, "1", 20),
		inst(900, "2", 40), // another session: not ours to judge here
	}}
	mgr, _ := newSweepManager(t, f)
	mgr.sessionEnumerator = &mockEnumerator{sessions: []SessionInfo{{Key: "1", Username: "alice"}}}
	spawned := 0
	mgr.spawnFunc = func(string, string, ...string) (int, error) { spawned++; return 0, nil }

	state := newSessionState("1", mgr.baseDir)
	state.lastConfig = settingsToConfig(&Settings{Enabled: true})
	state.spawnedPID = 100 // makes ensureRunningSession see a running helper
	mgr.sessions["1"] = state
	t.Cleanup(mgr.Shutdown)

	mgr.Apply(&Settings{Enabled: true})

	if spawned != 0 {
		t.Fatalf("spawn called %d times, want 0 (a helper was already running)", spawned)
	}
	if got, want := f.stoppedSorted(), []int{200, 300}; !equalInts(got, want) {
		t.Fatalf("stopped %v, want %v", got, want)
	}
	if !f.alive(100) || !f.alive(900) {
		t.Fatalf("survivor 100 and other-session 900 must stay alive; remaining %v", f.procs)
	}
}

func TestReapDuplicatesKeepsStatusFilePIDOverOldest(t *testing.T) {
	f := &fakeHelperProcs{procs: []helperInstance{inst(100, "1", 30), inst(200, "1", 20), inst(300, "1", 10)}}
	mgr, _ := newSweepManager(t, f)
	state := newSessionState("1", mgr.baseDir)
	state.pid = 300
	state.spawnedPID = 200

	if n := mgr.reapDuplicateHelpersLocked(state); n != 2 {
		t.Fatalf("reaped %d, want 2", n)
	}
	if !f.alive(300) {
		t.Fatalf("status-file pid 300 should survive; stopped %v", f.stopped)
	}
	if state.spawnedPID != 0 {
		t.Fatalf("spawnedPID should be cleared once its process was reaped, got %d", state.spawnedPID)
	}
	if state.pid != 300 {
		t.Fatalf("status pid should be untouched, got %d", state.pid)
	}
}

func TestReapDuplicatesKeepsSpawnedPIDWhenStatusPIDIsGone(t *testing.T) {
	f := &fakeHelperProcs{procs: []helperInstance{inst(100, "1", 30), inst(200, "1", 20)}}
	mgr, _ := newSweepManager(t, f)
	state := newSessionState("1", mgr.baseDir)
	state.pid = 4242 // stale status file
	state.spawnedPID = 200

	mgr.reapDuplicateHelpersLocked(state)

	if !f.alive(200) || f.alive(100) {
		t.Fatalf("want spawned 200 kept and 100 reaped; remaining %v", f.procs)
	}
}

func TestReapDuplicatesDefersWhileChatActive(t *testing.T) {
	f := &fakeHelperProcs{procs: []helperInstance{inst(100, "1", 30), inst(200, "1", 20)}}
	mgr, _ := newSweepManager(t, f)
	writeSessionStatus(t, mgr.baseDir, "1",
		"pid: 0\nchat_active: true\nlast_activity: "+time.Now().UTC().Format(time.RFC3339)+"\n")
	state := newSessionState("1", mgr.baseDir)

	if n := mgr.reapDuplicateHelpersLocked(state); n != 0 {
		t.Fatalf("reaped %d during an active chat, want 0", n)
	}
	if len(f.stopped) != 0 {
		t.Fatalf("stopped %v during an active chat", f.stopped)
	}
}

func TestReapDuplicatesNoOpForSingleInstanceAndEnumerationError(t *testing.T) {
	f := &fakeHelperProcs{procs: []helperInstance{inst(100, "1", 30)}}
	mgr, _ := newSweepManager(t, f)
	state := newSessionState("1", mgr.baseDir)
	if n := mgr.reapDuplicateHelpersLocked(state); n != 0 || len(f.stopped) != 0 {
		t.Fatalf("single instance: reaped %d, stopped %v", n, f.stopped)
	}

	f.procs = append(f.procs, inst(200, "1", 20))
	f.listErr = errors.New("snapshot failed")
	if n := mgr.reapDuplicateHelpersLocked(state); n != 0 || len(f.stopped) != 0 {
		t.Fatalf("enumeration error: reaped %d, stopped %v", n, f.stopped)
	}
}

func TestHelperInstancesNeverMatchServicesSession(t *testing.T) {
	f := &fakeHelperProcs{procs: []helperInstance{inst(100, "0", 30), inst(200, "0", 20)}}
	mgr, _ := newSweepManager(t, f)
	for _, key := range []string{"0", ""} {
		if got := mgr.helperInstancesInSession(key); len(got) != 0 {
			t.Fatalf("session %q matched %v, want none", key, got)
		}
	}
}

// #6251: a helper launched through the user-role helper reports PID 0 and a
// fresh agent process tracks nothing, so the PID-only stop silently stopped
// nothing. Disabling Assist must stop every instance in the session.
func TestEnsureStoppedSessionStopsUntrackedInstances(t *testing.T) {
	f := &fakeHelperProcs{procs: []helperInstance{inst(100, "1", 30), inst(200, "1", 20), inst(900, "2", 5)}}
	mgr, _ := newSweepManager(t, f)
	state := newSessionState("1", mgr.baseDir) // spawnedPID 0, no status file

	if err := mgr.ensureStoppedSession(state); err != nil {
		t.Fatal(err)
	}
	if got, want := f.stoppedSorted(), []int{100, 200}; !equalInts(got, want) {
		t.Fatalf("stopped %v, want %v", got, want)
	}
	if !f.alive(900) {
		t.Fatal("helper in another session must not be stopped")
	}
}

func TestEnsureStoppedSessionDoesNotStopTrackedPIDTwice(t *testing.T) {
	f := &fakeHelperProcs{procs: []helperInstance{inst(100, "1", 30)}}
	mgr, _ := newSweepManager(t, f)
	calls := 0
	mgr.stopIfOursFunc = func(pid int, bin string) (bool, error) { calls++; return f.stop(pid, bin) }
	state := newSessionState("1", mgr.baseDir)
	state.spawnedPID = 100

	if err := mgr.ensureStoppedSession(state); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("stopIfOurs called %d times, want 1", calls)
	}
}

func TestEnsureStoppedSessionPropagatesStopError(t *testing.T) {
	f := &fakeHelperProcs{procs: []helperInstance{inst(100, "1", 30)}}
	mgr, _ := newSweepManager(t, f)
	mgr.stopIfOursFunc = func(int, string) (bool, error) { return false, errors.New("access denied") }
	if err := mgr.ensureStoppedSession(newSessionState("1", mgr.baseDir)); err == nil {
		t.Fatal("want the terminate error surfaced so update/restart callers do not proceed")
	}
}

func TestPickHelperKeeperOldestThenLowestPID(t *testing.T) {
	same := sweepEpoch
	got := pickHelperKeeper([]helperInstance{
		{PID: 50, SessionKey: "1", Created: same},
		{PID: 40, SessionKey: "1", Created: same},
		{PID: 10, SessionKey: "1", Created: same.Add(time.Minute)},
	}, 0, 0)
	if got.PID != 40 {
		t.Fatalf("keeper %d, want 40 (oldest, lowest pid on tie)", got.PID)
	}
}

func equalInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
