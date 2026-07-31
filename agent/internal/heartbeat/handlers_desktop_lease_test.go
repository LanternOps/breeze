package heartbeat

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// fakeLifecycle is the package-wide scripted helperLifecycleController used by
// the on-demand (RDS) tests. Later tasks that need a lifecycle controller in a
// heartbeat unit test should reuse this rather than declaring another one —
// everything here lives in one Go package, so a second declaration collides.
type fakeLifecycle struct {
	mu            sync.Mutex
	mode          string
	acquired      []sessionbroker.HelperKey
	released      []sessionbroker.HelperKey
	renewed       int
	waited        []sessionbroker.HelperKey
	waitResults   map[sessionbroker.HelperKey]sessionbroker.HelperWaitResult
	acquireErr    error
	renewErr      error
	modeOverrides []string
}

func (f *fakeLifecycle) Stop()                 {}
func (f *fakeLifecycle) Done() <-chan struct{} { return nil }
func (f *fakeLifecycle) Mode() string          { return f.mode }

func (f *fakeLifecycle) SetModeOverride(override string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.modeOverrides = append(f.modeOverrides, override)
}

func (f *fakeLifecycle) AcquireLease(id uint32, role ipc.HelperRole, opID string, ttl time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.acquireErr != nil {
		return f.acquireErr
	}
	f.acquired = append(f.acquired, sessionbroker.HelperKey{WindowsSessionID: id, Role: role})
	return nil
}

func (f *fakeLifecycle) RenewLease(id uint32, role ipc.HelperRole, opID string, ttl time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.renewed++
	return f.renewErr
}

func (f *fakeLifecycle) ReleaseLease(id uint32, role ipc.HelperRole, opID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.released = append(f.released, sessionbroker.HelperKey{WindowsSessionID: id, Role: role})
}

func (f *fakeLifecycle) WaitForHelperReady(ctx context.Context, key sessionbroker.HelperKey) sessionbroker.HelperWaitResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.waited = append(f.waited, key)
	if r, ok := f.waitResults[key]; ok {
		return r
	}
	return sessionbroker.HelperWaitResult{Status: sessionbroker.HelperWaitTimeout}
}

func (f *fakeLifecycle) snapshot() (acquired, released, waited []sessionbroker.HelperKey, renewed int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]sessionbroker.HelperKey(nil), f.acquired...),
		append([]sessionbroker.HelperKey(nil), f.released...),
		append([]sessionbroker.HelperKey(nil), f.waited...),
		f.renewed
}

func TestHelperWaitFailureMessage(t *testing.T) {
	tests := []struct {
		res  sessionbroker.HelperWaitResult
		want string
	}{
		{sessionbroker.HelperWaitResult{Status: sessionbroker.HelperWaitFatalCooldown, RetryAfter: 7 * time.Minute}, "helper is in crash cooldown; retry in 7m0s"},
		{sessionbroker.HelperWaitResult{Status: sessionbroker.HelperWaitSessionGone}, "target session has ended"},
		{sessionbroker.HelperWaitResult{Status: sessionbroker.HelperWaitRetriesExhausted}, "helper failed to start after repeated attempts"},
		{sessionbroker.HelperWaitResult{Status: sessionbroker.HelperWaitSpawnerUnavailable}, "helper spawning is unavailable on this host"},
		{sessionbroker.HelperWaitResult{Status: sessionbroker.HelperWaitTimeout}, "helper did not become ready in time"},
		{sessionbroker.HelperWaitResult{Status: sessionbroker.HelperWaitStatus("wat")}, "helper unavailable"},
	}
	for _, tt := range tests {
		if got := helperWaitFailureMessage(tt.res); got != tt.want {
			t.Errorf("status %s: got %q want %q", tt.res.Status, got, tt.want)
		}
	}
}

func TestAcquireDesktopLeasesRolesAndRelease(t *testing.T) {
	f := &fakeLifecycle{mode: "on-demand"}
	h := &Heartbeat{helperLifecycle: f}

	// prompt configured => system + user roles
	if res := h.acquireDesktopLeases("sess-1", 3, true); res != nil {
		t.Fatalf("acquire failed: %+v", res)
	}
	acquired, _, _, _ := f.snapshot()
	if len(acquired) != 2 {
		t.Fatalf("expected system+user leases, got %+v", acquired)
	}
	if acquired[0].Role != ipc.HelperRoleSystem || acquired[1].Role != ipc.HelperRoleUser {
		t.Fatalf("expected system then user, got %+v", acquired)
	}
	h.releaseDesktopLeases("sess-1")
	_, released, _, _ := f.snapshot()
	if len(released) != 2 {
		t.Fatalf("expected both roles released, got %+v", released)
	}

	// no prompt => system only
	f.mu.Lock()
	f.acquired = nil
	f.mu.Unlock()
	if res := h.acquireDesktopLeases("sess-2", 4, false); res != nil {
		t.Fatalf("acquire failed: %+v", res)
	}
	acquired, _, _, _ = f.snapshot()
	if len(acquired) != 1 || acquired[0].Role != ipc.HelperRoleSystem {
		t.Fatalf("expected system-only lease, got %+v", acquired)
	}
	h.releaseDesktopLeases("sess-2")
}

func TestAcquireDesktopLeasesSessionGone(t *testing.T) {
	f := &fakeLifecycle{mode: "on-demand", acquireErr: sessionbroker.ErrLeaseSessionNotFound}
	h := &Heartbeat{helperLifecycle: f}
	res := h.acquireDesktopLeases("sess-1", 3, false)
	if res == nil || res.Status != "failed" {
		t.Fatalf("expected failed result, got %+v", res)
	}
	if res.Error != "target session 3 no longer exists" {
		t.Fatalf("unexpected error text: %q", res.Error)
	}
}

// A partially-acquired set must be rolled back: if the user-role lease fails
// after the system-role lease was taken, the system lease is released so the
// on-demand reconciler doesn't keep a helper alive for a connect that never
// started.
func TestAcquireDesktopLeasesRollsBackOnPartialFailure(t *testing.T) {
	f := &failSecondAcquireLifecycle{fakeLifecycle: fakeLifecycle{mode: "on-demand"}}
	h := &Heartbeat{helperLifecycle: f}
	res := h.acquireDesktopLeases("sess-1", 5, true)
	if res == nil || res.Status != "failed" {
		t.Fatalf("expected failed result, got %+v", res)
	}
	_, released, _, _ := f.snapshot()
	if len(released) != 1 || released[0].Role != ipc.HelperRoleSystem {
		t.Fatalf("expected system lease rolled back, got %+v", released)
	}
	h.mu.Lock()
	hold := h.desktopLeases["sess-1"]
	h.mu.Unlock()
	if hold != nil {
		t.Fatalf("no hold should be recorded after a failed acquire, got %+v", hold)
	}
}

type failSecondAcquireLifecycle struct {
	fakeLifecycle
	calls int
}

func (f *failSecondAcquireLifecycle) AcquireLease(id uint32, role ipc.HelperRole, opID string, ttl time.Duration) error {
	f.mu.Lock()
	f.calls++
	n := f.calls
	f.mu.Unlock()
	if n >= 2 {
		return context.DeadlineExceeded
	}
	return f.fakeLifecycle.AcquireLease(id, role, opID, ttl)
}

func TestReleaseDesktopLeasesIsSafeWhenNothingHeld(t *testing.T) {
	h := &Heartbeat{helperLifecycle: &fakeLifecycle{mode: "on-demand"}}
	h.releaseDesktopLeases("never-acquired")
	h2 := &Heartbeat{}
	h2.releaseDesktopLeases("no-lifecycle")
}

func TestResolveDesktopTargetWinID(t *testing.T) {
	if id, err := resolveDesktopTargetWinID("7"); err != nil || id != 7 {
		t.Fatalf("got (%d, %v), want (7, nil)", id, err)
	}
	if _, err := resolveDesktopTargetWinID("console"); err == nil {
		t.Fatal("expected an error for a non-numeric target")
	}
	// Session 0 parses fine but can never host a helper — it must be rejected
	// here, not 95s later as a bogus readiness timeout.
	_, err := resolveDesktopTargetWinID("0")
	if err == nil {
		t.Fatal("expected session 0 to be rejected")
	}
	if err.Error() != "invalid targetSessionId 0: session 0 is never an interactive session" {
		t.Fatalf("unexpected message for session 0: %q", err.Error())
	}
}

// A start_desktop pinned to session 0 (stale picker / older API / hand-built
// command) must fail fast with the typed reason before any lease is taken —
// otherwise the connect burns the 30s consent wait plus the 95s helper budget
// and reports "helper did not become ready in time".
func TestHandleStartDesktopOnDemandRejectsSessionZero(t *testing.T) {
	f := &fakeLifecycle{mode: "on-demand"}
	h := &Heartbeat{
		helperLifecycle: f,
		sessionBroker:   newTestBrokerWithSessions(t),
		desktopMgr:      desktop.NewSessionManager(),
	}

	cmd := startDesktopCmd("sess-zero", consentModePrompt("block", 10))
	cmd.Payload["targetSessionId"] = float64(0)

	done := make(chan tools.CommandResult, 1)
	go func() { done <- handleStartDesktop(h, cmd) }()
	var result tools.CommandResult
	select {
	case result = <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("start_desktop with target 0 did not fail fast")
	}

	if result.Status != "failed" {
		t.Fatalf("expected a failed result, got %+v", result)
	}
	if result.Error != "invalid targetSessionId 0: session 0 is never an interactive session" {
		t.Fatalf("unexpected error: %q", result.Error)
	}
	acquired, released, waited, _ := f.snapshot()
	if len(acquired) != 0 || len(released) != 0 || len(waited) != 0 {
		t.Fatalf("session 0 must be rejected before any lease/wait: acquired=%v released=%v waited=%v",
			acquired, released, waited)
	}
	h.mu.Lock()
	nLeases, nTargets := len(h.desktopLeases), len(h.desktopTargets)
	h.mu.Unlock()
	if nLeases != 0 || nTargets != 0 {
		t.Fatalf("leftover state: %d leases, %d targets", nLeases, nTargets)
	}
}

// The renewal goroutine keeps every held role alive while the helper session
// is present, and stops as soon as the leases are released.
func TestDesktopLeaseRenewalRenewsUntilReleased(t *testing.T) {
	restore := shrinkDesktopLeaseRenewEvery(t, 5*time.Millisecond)
	defer restore()

	f := &fakeLifecycle{mode: "on-demand"}
	h := &Heartbeat{
		helperLifecycle:      f,
		desktopHelperPresent: func(sessionbroker.HelperKey) bool { return true },
	}
	if res := h.acquireDesktopLeases("sess-renew", 3, true); res != nil {
		t.Fatalf("acquire failed: %+v", res)
	}
	h.startDesktopLeaseRenewal("sess-renew")

	waitFor(t, time.Second, func() bool {
		_, _, _, renewed := f.snapshot()
		return renewed >= 4 // at least two ticks x two roles
	}, "renewal never fired")

	h.releaseDesktopLeases("sess-renew")
	_, _, _, afterRelease := f.snapshot()
	time.Sleep(50 * time.Millisecond)
	_, _, _, later := f.snapshot()
	if later > afterRelease+2 {
		t.Fatalf("renewal kept running after release (%d -> %d)", afterRelease, later)
	}
}

// Stream death without a stop_desktop: the system-role helper session vanishes.
// The renewal goroutine self-stops after two consecutive gone ticks (one tick
// alone could be a reconnect blip) and stops renewing so the TTL + lease linger
// reap the helper.
func TestDesktopLeaseRenewalStopsAfterTwoGoneTicks(t *testing.T) {
	restore := shrinkDesktopLeaseRenewEvery(t, 5*time.Millisecond)
	defer restore()

	var mu sync.Mutex
	present := true
	f := &fakeLifecycle{mode: "on-demand"}
	h := &Heartbeat{
		helperLifecycle: f,
		desktopHelperPresent: func(sessionbroker.HelperKey) bool {
			mu.Lock()
			defer mu.Unlock()
			return present
		},
	}
	if res := h.acquireDesktopLeases("sess-gone", 3, false); res != nil {
		t.Fatalf("acquire failed: %+v", res)
	}
	h.startDesktopLeaseRenewal("sess-gone")
	waitFor(t, time.Second, func() bool {
		_, _, _, renewed := f.snapshot()
		return renewed >= 2
	}, "renewal never fired while helper present")

	mu.Lock()
	present = false
	mu.Unlock()

	time.Sleep(100 * time.Millisecond)
	_, _, _, stopped := f.snapshot()
	time.Sleep(100 * time.Millisecond)
	_, _, _, later := f.snapshot()
	if later != stopped {
		t.Fatalf("renewal did not self-stop after the helper session vanished (%d -> %d)", stopped, later)
	}
	// The goroutine self-stopping must not release the leases — only an
	// explicit stop/failure does that, so a brief blip cannot orphan the hold.
	_, released, _, _ := f.snapshot()
	if len(released) != 0 {
		t.Fatalf("self-stopping renewal released leases: %+v", released)
	}
	h.releaseDesktopLeases("sess-gone")
}

// End-to-end through handleStartDesktop: an on-demand host with no explicit
// target defaults to the console session, writes it back into the payload for
// startDesktopViaHelper, takes system+user leases (a consent prompt is
// configured), and releases everything when consent is denied.
func TestHandleStartDesktopOnDemandDefaultsTargetAndReleasesOnConsentDenied(t *testing.T) {
	f := &fakeLifecycle{mode: "on-demand"}
	h := &Heartbeat{
		helperLifecycle: f,
		sessionBroker:   newTestBrokerWithSessions(t),
		desktopMgr:      desktop.NewSessionManager(),
	}
	consoleID := h.sessionBroker.ConsoleSessionID()
	wantWinID, err := sessionbroker.ParseWindowsSessionIDForHeartbeat(consoleID)
	if err != nil {
		t.Skipf("console session id %q is not numeric on this platform", consoleID)
	}

	cmd := startDesktopCmd("sess-ondemand", consentModePrompt("block", 10))
	result := handleStartDesktop(h, cmd)
	assertConsentDenied(t, result, "helper_absent")

	acquired, released, waited, _ := f.snapshot()
	if len(acquired) != 2 {
		t.Fatalf("expected system+user leases, got %+v", acquired)
	}
	for _, k := range acquired {
		if k.WindowsSessionID != wantWinID {
			t.Fatalf("lease taken on session %d, want console %d", k.WindowsSessionID, wantWinID)
		}
	}
	if len(released) != 2 {
		t.Fatalf("consent denial must release both leases, got %+v", released)
	}
	if len(waited) != 1 || waited[0].Role != ipc.HelperRoleUser {
		t.Fatalf("expected a single wait on the user-role helper, got %+v", waited)
	}
	if got, ok := cmd.Payload["targetSessionId"].(float64); !ok || int(got) != int(wantWinID) {
		t.Fatalf("console default was not written back into the payload: %#v", cmd.Payload["targetSessionId"])
	}
	// Nothing may be left holding a lease.
	h.mu.Lock()
	nLeases, nTargets := len(h.desktopLeases), len(h.desktopTargets)
	h.mu.Unlock()
	if nLeases != 0 || nTargets != 0 {
		t.Fatalf("leftover state: %d leases, %d targets", nLeases, nTargets)
	}
}

// #434 strict-by-mode: the on-demand path never substitutes another session.
// A vanished target surfaces the typed reason and releases the leases.
func TestStartDesktopViaHelperOnDemandStrictSessionGone(t *testing.T) {
	f := &fakeLifecycle{
		mode: "on-demand",
		waitResults: map[sessionbroker.HelperKey]sessionbroker.HelperWaitResult{
			{WindowsSessionID: 3, Role: ipc.HelperRoleSystem}: {Status: sessionbroker.HelperWaitSessionGone},
		},
	}
	h := &Heartbeat{
		helperLifecycle: f,
		helperFinder: func(string) *sessionbroker.Session {
			t.Fatal("on-demand path must never consult the legacy find-or-spawn fallback")
			return nil
		},
	}
	h.setDesktopTarget("sess-strict", "3")
	if res := h.acquireDesktopLeases("sess-strict", 3, false); res != nil {
		t.Fatalf("acquire failed: %+v", res)
	}

	payload := map[string]any{"targetSessionId": float64(3)}
	result := h.startDesktopViaHelper("sess-strict", "offer", nil, 0, desktop.DefaultSessionPolicy(), payload)
	if result.Status != "failed" || result.Error != "target session has ended" {
		t.Fatalf("got %+v, want failed/%q", result, "target session has ended")
	}
	_, released, _, _ := f.snapshot()
	if len(released) != 1 {
		t.Fatalf("failed start must release the leases, got %+v", released)
	}
	if got := h.takeDesktopTarget("sess-strict"); got != "" {
		t.Fatalf("failed start must clear the desktop target, got %q", got)
	}
}

// Always-on hosts keep today's behavior bit-identical: no leases, no wait, the
// legacy find-or-spawn path runs.
func TestStartDesktopViaHelperAlwaysOnKeepsLegacyPath(t *testing.T) {
	f := &fakeLifecycle{mode: "always-on"}
	called := false
	h := &Heartbeat{
		helperLifecycle: f,
		helperFinder: func(target string) *sessionbroker.Session {
			called = true
			return nil
		},
	}
	result := h.startDesktopViaHelper("sess-legacy", "offer", nil, 0, desktop.DefaultSessionPolicy(),
		map[string]any{"targetSessionId": float64(3)})
	if !called {
		t.Fatal("always-on must still use the legacy helper finder")
	}
	if result.Status != "failed" || result.Error != "no capable helper available after spawn attempt" {
		t.Fatalf("legacy failure message changed: %+v", result)
	}
	acquired, released, waited, _ := f.snapshot()
	if len(acquired) != 0 || len(released) != 0 || len(waited) != 0 {
		t.Fatalf("always-on must not touch leases: acquired=%v released=%v waited=%v", acquired, released, waited)
	}
}

func TestHandleStopDesktopReleasesLeases(t *testing.T) {
	f := &fakeLifecycle{mode: "on-demand"}
	h := &Heartbeat{helperLifecycle: f, desktopMgr: desktop.NewSessionManager()}
	if res := h.acquireDesktopLeases("sess-stop", 3, true); res != nil {
		t.Fatalf("acquire failed: %+v", res)
	}
	result := handleStopDesktop(h, Command{
		ID:      "cmd-stop",
		Type:    tools.CmdStopDesktop,
		Payload: map[string]any{"sessionId": "sess-stop"},
	})
	if result.Status != "completed" {
		t.Fatalf("stop failed: %+v", result)
	}
	_, released, _, _ := f.snapshot()
	if len(released) != 2 {
		t.Fatalf("stop_desktop must release every held role, got %+v", released)
	}
}

// A peer disconnect (no stop_desktop) must also drop the leases — the helper
// process outlives the WebRTC peer, so the renewal goroutine's "helper
// vanished" self-stop would never fire and the helper would be pinned forever.
func TestDesktopDisconnectNotificationReleasesLeases(t *testing.T) {
	f := &fakeLifecycle{mode: "on-demand"}
	h := &Heartbeat{helperLifecycle: f}
	if res := h.acquireDesktopLeases("sess-drop", 3, true); res != nil {
		t.Fatalf("acquire failed: %+v", res)
	}
	h.sendDesktopDisconnectNotification("sess-drop")
	_, released, _, _ := f.snapshot()
	if len(released) != 2 {
		t.Fatalf("peer disconnect must release every held role, got %+v", released)
	}
}

func TestLifecycleModeEmptyWithoutManager(t *testing.T) {
	h := &Heartbeat{}
	if got := h.lifecycleMode(); got != "" {
		t.Fatalf("lifecycleMode without a manager = %q, want \"\"", got)
	}
	h.helperLifecycle = &fakeLifecycle{mode: "on-demand"}
	if got := h.lifecycleMode(); got != "on-demand" {
		t.Fatalf("lifecycleMode = %q, want on-demand", got)
	}
}

func shrinkDesktopLeaseRenewEvery(t *testing.T, d time.Duration) func() {
	t.Helper()
	prev := desktopLeaseRenewEvery
	desktopLeaseRenewEvery = d
	return func() { desktopLeaseRenewEvery = prev }
}

func waitFor(t *testing.T, budget time.Duration, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(budget)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal(msg)
}
