package heartbeat

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/etwlua"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

func pamHoldTestHeartbeat(lc helperLifecycleController, manager *fakePamLifetimeManager) *Heartbeat {
	h := &Heartbeat{pamLifetimeManager: manager, helperLifecycle: lc}
	h.pamReconciled.Store(true)
	h.pamReceivedObservationReady.Store(true)
	h.pamVerificationAvailable.Store(true)
	return h
}

func lastHold(t *testing.T, calls []bool) bool {
	t.Helper()
	if len(calls) == 0 {
		t.Fatal("SetPAMHelperHold was never called")
	}
	return calls[len(calls)-1]
}

// #8996: the lifecycle's PAM hold tracks the effective interception state.
func TestUACInterceptionDrivesPAMHelperHold(t *testing.T) {
	lc := &fakeLifecycle{mode: "on-demand"}
	h := pamHoldTestHeartbeat(lc, &fakePamLifetimeManager{available: true})

	h.handleUACInterception(boolPtr(true))
	if !h.IsUACInterceptionEnabled() {
		t.Fatal("precondition: interception should be enabled")
	}
	if !lastHold(t, lc.pamHoldCalls()) {
		t.Fatalf("hold after enable = false, calls=%v", lc.pamHoldCalls())
	}

	h.handleUACInterception(boolPtr(false))
	if lastHold(t, lc.pamHoldCalls()) {
		t.Fatalf("hold after disable = true, calls=%v", lc.pamHoldCalls())
	}

	h.handleUACInterception(boolPtr(true))
	h.handleUACInterception(nil) // policy unassigned / old server
	if lastHold(t, lc.pamHoldCalls()) {
		t.Fatalf("hold after absent field = true, calls=%v", lc.pamHoldCalls())
	}
}

// A rejected enable leaves interception off, so the hold must stay off too —
// otherwise helpers would sit in every session for a feature that is not on.
func TestRejectedUACEnableDoesNotHoldHelpers(t *testing.T) {
	lc := &fakeLifecycle{mode: "on-demand"}
	h := pamHoldTestHeartbeat(lc, &fakePamLifetimeManager{available: true, setEnabledErr: errors.New("ledger unresolved")})

	h.handleUACInterception(boolPtr(true))

	if h.IsUACInterceptionEnabled() {
		t.Fatal("precondition: enable should have been rejected")
	}
	for _, held := range lc.pamHoldCalls() {
		if held {
			t.Fatalf("hold set although interception is off: %v", lc.pamHoldCalls())
		}
	}
}

// The lifecycle manager is installed in Start, which can run after the PAM
// policy was already applied; installing it must carry the current state over.
func TestSyncPAMHelperHoldAppliesCurrentStateToLateLifecycle(t *testing.T) {
	h := &Heartbeat{}
	h.uacInterceptionEnabled.Store(true)
	lc := &fakeLifecycle{mode: "on-demand"}
	h.helperLifecycle = lc

	h.syncPAMHelperHold()

	if !lastHold(t, lc.pamHoldCalls()) {
		t.Fatalf("late-installed lifecycle not held: %v", lc.pamHoldCalls())
	}
}

type pamSpawnFixture struct {
	mu         sync.Mutex
	finds      int
	readyAfter int      // find returns a session once finds > readyAfter
	targets    []string // the targetWinSession of every find, in order
	dismissed  []*sessionbroker.Session
	dialogs    int
	// reports records every "cannot act" report RunPamFlow sends (#9517).
	reports []pamUnableReport
}

type pamUnableReport struct {
	requestID string
	unable    pamUnable
}

func (f *pamSpawnFixture) reported() []pamUnableReport {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]pamUnableReport(nil), f.reports...)
}

// expectUnableReport asserts exactly one report for requestID with reason.
func (f *pamSpawnFixture) expectUnableReport(t *testing.T, requestID, reason string) {
	t.Helper()
	got := f.reported()
	if len(got) != 1 || got[0].requestID != requestID || got[0].unable.Reason != reason || got[0].unable.Detail == "" {
		t.Fatalf("unable reports = %+v, want one for %q with reason %q and a detail", got, requestID, reason)
	}
}

func (f *pamSpawnFixture) expectNoUnableReport(t *testing.T) {
	t.Helper()
	if got := f.reported(); len(got) != 0 {
		t.Fatalf("unexpected unable reports: %+v", got)
	}
}

func (f *pamSpawnFixture) heartbeat(lc helperLifecycleController) *Heartbeat {
	helper := &sessionbroker.Session{SessionID: "spawned-pam-helper"}
	h := &Heartbeat{
		pamFindSession: func(capability, target string) *sessionbroker.Session {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.finds++
			f.targets = append(f.targets, target)
			if f.finds > f.readyAfter {
				return helper
			}
			return nil
		},
		pamRequestDialog: func(*sessionbroker.Session, string, ipc.PamRequestDialog, time.Duration) (ipc.PamDialogResult, error) {
			f.mu.Lock()
			f.dialogs++
			f.mu.Unlock()
			return ipc.PamDialogResult{}, nil
		},
		pamDismissConsent: func(s *sessionbroker.Session, _ string, _ time.Duration) (ipc.PamDismissConsentResult, error) {
			f.mu.Lock()
			f.dismissed = append(f.dismissed, s)
			f.mu.Unlock()
			return ipc.PamDismissConsentResult{Success: true, Reason: "dismissed"}, nil
		},
		pamReportUnable: func(requestID string, unable pamUnable) {
			f.mu.Lock()
			f.reports = append(f.reports, pamUnableReport{requestID: requestID, unable: unable})
			f.mu.Unlock()
		},
	}
	if lc != nil {
		h.helperLifecycle = lc
	}
	return h
}

// #8996 race half: the elevation arrives before any SYSTEM helper is up in the
// requester's session (PAM hold not yet reconciled, fresh logon). The flow
// must lease + spawn one for that session and carry on, not give up.
func TestRunPamFlowSpawnsSystemHelperOnDemand(t *testing.T) {
	key := sessionbroker.HelperKey{WindowsSessionID: 7, Role: ipc.HelperRoleSystem}
	lc := &fakeLifecycle{mode: "on-demand", waitResults: map[sessionbroker.HelperKey]sessionbroker.HelperWaitResult{
		key: {Status: sessionbroker.HelperWaitReady},
	}}
	f := &pamSpawnFixture{readyAfter: 1}
	h := f.heartbeat(lc)

	h.RunPamFlow(context.Background(), etwlua.Event{SubjectSessionID: 7},
		etwlua.ElevationOutcome{Status: etwlua.ElevationDenied, RequestID: "req-1"})

	acquired, released, waited, _ := lc.snapshot()
	if len(acquired) != 1 || acquired[0] != key {
		t.Fatalf("acquired = %v, want [%s]", acquired, key)
	}
	if len(waited) != 1 || waited[0] != key {
		t.Fatalf("waited = %v, want [%s]", waited, key)
	}
	if len(f.dismissed) != 1 || f.dismissed[0] == nil {
		t.Fatalf("deny was not enforced through the spawned helper: dismissed=%v", f.dismissed)
	}
	if len(released) != 1 || released[0] != key {
		t.Fatalf("released = %v, want the flow's lease released on return", released)
	}
	f.expectNoUnableReport(t)
}

// The lease must outlive the dialog round-trip: releasing it before the user
// answers would let the reconciler reap the helper showing the dialog.
func TestRunPamFlowHoldsOnDemandLeaseThroughDialog(t *testing.T) {
	key := sessionbroker.HelperKey{WindowsSessionID: 4, Role: ipc.HelperRoleSystem}
	lc := &fakeLifecycle{mode: "on-demand", waitResults: map[sessionbroker.HelperKey]sessionbroker.HelperWaitResult{
		key: {Status: sessionbroker.HelperWaitReady},
	}}
	f := &pamSpawnFixture{readyAfter: 1}
	h := f.heartbeat(lc)
	releasedDuringDialog := -1
	h.pamRequestDialog = func(*sessionbroker.Session, string, ipc.PamRequestDialog, time.Duration) (ipc.PamDialogResult, error) {
		_, released, _, _ := lc.snapshot()
		releasedDuringDialog = len(released)
		return ipc.PamDialogResult{Approved: false, DismissedByUser: true}, nil
	}

	h.RunPamFlow(context.Background(), etwlua.Event{SubjectSessionID: 4},
		etwlua.ElevationOutcome{Status: etwlua.ElevationPending, RequestID: "req-2"})

	if releasedDuringDialog != 0 {
		t.Fatalf("on-demand PAM lease released before the dialog returned (released during dialog = %d)", releasedDuringDialog)
	}
	if _, released, _, _ := lc.snapshot(); len(released) != 1 {
		t.Fatalf("released = %v, want 1 after the flow", released)
	}
}

func TestRunPamFlowStopsWhenOnDemandSpawnFails(t *testing.T) {
	key := sessionbroker.HelperKey{WindowsSessionID: 7, Role: ipc.HelperRoleSystem}
	cases := map[string]struct {
		lc     *fakeLifecycle
		reason string
	}{
		"helper never ready": {&fakeLifecycle{mode: "on-demand", waitResults: map[sessionbroker.HelperKey]sessionbroker.HelperWaitResult{
			key: {Status: sessionbroker.HelperWaitRetriesExhausted},
		}}, pamUnableHelperStartFailed},
		"helper in crash cooldown": {&fakeLifecycle{mode: "on-demand", waitResults: map[sessionbroker.HelperKey]sessionbroker.HelperWaitResult{
			key: {Status: sessionbroker.HelperWaitFatalCooldown, RetryAfter: time.Minute},
		}}, pamUnableHelperStartFailed},
		"helper wait timed out": {&fakeLifecycle{mode: "on-demand", waitResults: map[sessionbroker.HelperKey]sessionbroker.HelperWaitResult{
			key: {Status: sessionbroker.HelperWaitTimeout},
		}}, pamUnableHelperStartFailed},
		// The lease was dropped because the session left a ListSessions
		// snapshot, which a skipped or truncated listing can also cause: not
		// proof the session ended, so not reported.
		"session left the snapshot while waiting": {&fakeLifecycle{mode: "on-demand", waitResults: map[sessionbroker.HelperKey]sessionbroker.HelperWaitResult{
			key: {Status: sessionbroker.HelperWaitSessionGone},
		}}, ""},
		// A lease refusal can come from a transient re-enumeration: not reported.
		"lease refused": {&fakeLifecycle{mode: "on-demand", acquireErr: sessionbroker.ErrLeaseSessionNotFound}, ""},
	}
	for name, tc := range cases {
		lc := tc.lc
		t.Run(name, func(t *testing.T) {
			f := &pamSpawnFixture{readyAfter: 1}
			h := f.heartbeat(lc)

			h.RunPamFlow(context.Background(), etwlua.Event{SubjectSessionID: 7},
				etwlua.ElevationOutcome{Status: etwlua.ElevationPending, RequestID: "req-3"})

			if f.dialogs != 0 || len(f.dismissed) != 0 {
				t.Fatalf("flow continued without a helper: dialogs=%d dismissed=%d", f.dialogs, len(f.dismissed))
			}
			acquired, released, _, _ := lc.snapshot()
			if name != "lease refused" && len(acquired) != 1 {
				t.Fatalf("acquired = %v, want the flow to have tried a lease", acquired)
			}
			if len(released) != len(acquired) {
				t.Fatalf("lease leaked: acquired=%v released=%v", acquired, released)
			}
			if tc.reason == "" {
				f.expectNoUnableReport(t)
			} else {
				f.expectUnableReport(t, "req-3", tc.reason)
			}
		})
	}
}

// #9517: agent shutdown cancelling the flow mid-wait is not the device's
// verdict on the request, so nothing is reported.
func TestRunPamFlowCancelledWhileWaitingDoesNotReportUnable(t *testing.T) {
	key := sessionbroker.HelperKey{WindowsSessionID: 7, Role: ipc.HelperRoleSystem}
	lc := &fakeLifecycle{mode: "on-demand", blockWait: true}
	f := &pamSpawnFixture{readyAfter: 1}
	h := f.heartbeat(lc)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// Cancel only once the flow is inside WaitForHelperReady.
	go func() {
		for {
			if _, _, waited, _ := lc.snapshot(); len(waited) > 0 {
				cancel()
				return
			}
			time.Sleep(time.Millisecond)
		}
	}()

	h.RunPamFlow(ctx, etwlua.Event{SubjectSessionID: 7},
		etwlua.ElevationOutcome{Status: etwlua.ElevationPending, RequestID: "req-cancel"})

	if _, _, waited, _ := lc.snapshot(); len(waited) != 1 || waited[0] != key {
		t.Fatalf("waited = %v, want the flow to have been waiting on [%s]", waited, key)
	}

	if f.dialogs != 0 || len(f.dismissed) != 0 {
		t.Fatalf("flow continued after cancellation: dialogs=%d dismissed=%d", f.dialogs, len(f.dismissed))
	}
	f.expectNoUnableReport(t)
}

// #9517: no session broker (interactive agent, or an event that beat broker
// setup) is not reported: early in startup it is not proof.
func TestRunPamFlowWithoutSessionBrokerDoesNotReportUnable(t *testing.T) {
	f := &pamSpawnFixture{}
	h := &Heartbeat{pamReportUnable: func(requestID string, unable pamUnable) {
		f.mu.Lock()
		f.reports = append(f.reports, pamUnableReport{requestID: requestID, unable: unable})
		f.mu.Unlock()
	}}

	h.RunPamFlow(context.Background(), etwlua.Event{SubjectSessionID: 7},
		etwlua.ElevationOutcome{Status: etwlua.ElevationPending, RequestID: "req-nobroker"})

	f.expectNoUnableReport(t)
}

// A status RunPamFlow has no local flow for is not an inability to act.
func TestRunPamFlowUnsupportedStatusDoesNotReportUnable(t *testing.T) {
	f := &pamSpawnFixture{readyAfter: 100}
	h := f.heartbeat(nil)

	h.RunPamFlow(context.Background(), etwlua.Event{SubjectSessionID: 7},
		etwlua.ElevationOutcome{Status: etwlua.ElevationStatus("ignored"), RequestID: "req-ignored"})

	f.expectNoUnableReport(t)
}

// An unresolved requester session falls back to the console session, the same
// target FindCapableSession uses.
func TestRunPamFlowOnDemandSpawnUsesConsoleForUnresolvedRequester(t *testing.T) {
	key := sessionbroker.HelperKey{WindowsSessionID: 1, Role: ipc.HelperRoleSystem}
	lc := &fakeLifecycle{mode: "on-demand", waitResults: map[sessionbroker.HelperKey]sessionbroker.HelperWaitResult{
		key: {Status: sessionbroker.HelperWaitReady},
	}}
	f := &pamSpawnFixture{readyAfter: 1}
	h := f.heartbeat(lc)
	h.pamConsoleSessionID = func() string { return "1" }

	h.RunPamFlow(context.Background(), etwlua.Event{SubjectSessionID: 0},
		etwlua.ElevationOutcome{Status: etwlua.ElevationDenied, RequestID: "req-4"})

	if acquired, _, _, _ := lc.snapshot(); len(acquired) != 1 || acquired[0] != key {
		t.Fatalf("acquired = %v, want console [%s]", acquired, key)
	}
}

// With no lifecycle manager (non-Windows, non-service) there is nothing to
// spawn with; the flow keeps its old behavior and stops.
func TestRunPamFlowNoLifecycleKeepsOldBehavior(t *testing.T) {
	f := &pamSpawnFixture{readyAfter: 1}
	h := f.heartbeat(nil)

	h.RunPamFlow(context.Background(), etwlua.Event{SubjectSessionID: 7},
		etwlua.ElevationOutcome{Status: etwlua.ElevationDenied, RequestID: "req-5"})

	if f.finds != 1 || len(f.dismissed) != 0 {
		t.Fatalf("finds=%d dismissed=%d, want 1 and 0", f.finds, len(f.dismissed))
	}
	// No lifecycle manager is not proof (startup race): not reported.
	f.expectNoUnableReport(t)
}

// A session that cannot host a SYSTEM helper (disconnected, gone) must fail
// fast: RunPamFlow runs on the etwlua loop, and waiting 30 s for a helper the
// reconciler will never spawn stalls every queued elevation (#6812 shape).
func TestRunPamFlowOnDemandSpawnFailsFastWhenSessionCannotHostHelper(t *testing.T) {
	key := sessionbroker.HelperKey{WindowsSessionID: 7, Role: ipc.HelperRoleSystem}
	cases := map[string]struct {
		lc *fakeLifecycle
		// reported: a definite "cannot host" closes the request; a failed
		// check is not known to be permanent, so the request stays pending.
		reported bool
	}{
		"session cannot host": {&fakeLifecycle{mode: "on-demand", unavailable: map[sessionbroker.HelperKey]bool{key: true}}, true},
		// Absent from the snapshot: the detector can skip unreadable rows or
		// truncate, so absence is not proof. Not reported.
		"session not found": {&fakeLifecycle{mode: "on-demand", availableErr: sessionbroker.ErrLeaseSessionNotFound}, false},
		// The check itself failed: not known to be permanent.
		"availability check fails": {&fakeLifecycle{mode: "on-demand", availableErr: errors.New("WTSEnumerateSessions failed")}, false},
	}
	for name, tc := range cases {
		lc := tc.lc
		t.Run(name, func(t *testing.T) {
			f := &pamSpawnFixture{readyAfter: 1}
			h := f.heartbeat(lc)

			h.RunPamFlow(context.Background(), etwlua.Event{SubjectSessionID: 7},
				etwlua.ElevationOutcome{Status: etwlua.ElevationPending, RequestID: "req-6"})

			acquired, _, waited, _ := lc.snapshot()
			if len(acquired) != 0 || len(waited) != 0 {
				t.Fatalf("leased/waited for a session that cannot host a helper: acquired=%v waited=%v", acquired, waited)
			}
			if f.dialogs != 0 || len(f.dismissed) != 0 {
				t.Fatalf("flow continued without a helper: dialogs=%d dismissed=%d", f.dialogs, len(f.dismissed))
			}
			if tc.reported {
				f.expectUnableReport(t, "req-6", pamUnableSessionUnavailable)
			} else {
				f.expectNoUnableReport(t)
			}
		})
	}
}

// Ready helper without the PAM scope: the flow must stop (never dialog or
// actuate through it) and release its lease.
func TestRunPamFlowOnDemandSpawnedHelperWithoutPamScopeStops(t *testing.T) {
	key := sessionbroker.HelperKey{WindowsSessionID: 7, Role: ipc.HelperRoleSystem}
	lc := &fakeLifecycle{mode: "on-demand", waitResults: map[sessionbroker.HelperKey]sessionbroker.HelperWaitResult{
		key: {Status: sessionbroker.HelperWaitReady, Session: &sessionbroker.Session{
			SessionID: "unscoped", HelperRole: ipc.HelperRoleSystem, AllowedScopes: []string{"desktop"},
		}},
	}}
	f := &pamSpawnFixture{readyAfter: 100} // find never returns a PAM-capable session
	h := f.heartbeat(lc)

	h.RunPamFlow(context.Background(), etwlua.Event{SubjectSessionID: 7},
		etwlua.ElevationOutcome{Status: etwlua.ElevationPending, RequestID: "req-7"})

	if f.dialogs != 0 || len(f.dismissed) != 0 {
		t.Fatalf("flow continued without a PAM-scoped helper: dialogs=%d dismissed=%d", f.dialogs, len(f.dismissed))
	}
	if f.finds != 2 {
		t.Fatalf("finds = %d, want the initial lookup plus one re-find after ready", f.finds)
	}
	if acquired, released, _, _ := lc.snapshot(); len(acquired) != 1 || len(released) != 1 {
		t.Fatalf("acquired=%v released=%v, want one lease taken and released", acquired, released)
	}
	f.expectUnableReport(t, "req-7", pamUnableHelperUnavailable)
}

// Start installs the lifecycle manager after the PAM policy may already have
// been applied; the install path itself must carry the hold over.
func TestInstallHelperLifecycleSyncsPAMHold(t *testing.T) {
	h := &Heartbeat{}
	h.uacInterceptionEnabled.Store(true)
	lc := &fakeLifecycle{mode: "on-demand"}

	h.installHelperLifecycle(lc, func() {})

	if h.lifecycleController() != lc {
		t.Fatal("lifecycle not installed")
	}
	if !lastHold(t, lc.pamHoldCalls()) {
		t.Fatalf("install did not carry the enabled PAM hold over: %v", lc.pamHoldCalls())
	}
}

// #9517: a ready helper the PAM lookup then misses is only reported when the
// wait's own helper lacks the PAM scope; otherwise it is a race with the
// session list and the request stays pending.
func TestRunPamFlowReadyHelperMissedByLookupDoesNotReportUnable(t *testing.T) {
	key := sessionbroker.HelperKey{WindowsSessionID: 7, Role: ipc.HelperRoleSystem}
	cases := map[string]*sessionbroker.Session{
		"wait names no helper": nil,
		"wait's helper holds the PAM scope": {
			SessionID: "scoped", HelperRole: ipc.HelperRoleSystem, AllowedScopes: []string{ipc.ScopePam},
		},
	}
	for name, ready := range cases {
		ready := ready
		t.Run(name, func(t *testing.T) {
			lc := &fakeLifecycle{mode: "on-demand", waitResults: map[sessionbroker.HelperKey]sessionbroker.HelperWaitResult{
				key: {Status: sessionbroker.HelperWaitReady, Session: ready},
			}}
			f := &pamSpawnFixture{readyAfter: 100}
			h := f.heartbeat(lc)

			h.RunPamFlow(context.Background(), etwlua.Event{SubjectSessionID: 7},
				etwlua.ElevationOutcome{Status: etwlua.ElevationPending, RequestID: "req-race"})

			if f.dialogs != 0 || len(f.dismissed) != 0 {
				t.Fatalf("flow continued without a found helper: dialogs=%d dismissed=%d", f.dialogs, len(f.dismissed))
			}
			f.expectNoUnableReport(t)
		})
	}
}

// #9517: GetConsoleSessionID answers "0" when the console lookup fails; that
// is not proof the requester has no session, so nothing is leased or reported.
func TestRunPamFlowUnresolvedConsoleDoesNotReportUnable(t *testing.T) {
	lc := &fakeLifecycle{mode: "on-demand"}
	f := &pamSpawnFixture{readyAfter: 100}
	h := f.heartbeat(lc)
	h.pamConsoleSessionID = func() string { return "0" }

	h.RunPamFlow(context.Background(), etwlua.Event{SubjectSessionID: 0},
		etwlua.ElevationOutcome{Status: etwlua.ElevationPending, RequestID: "req-noconsole"})

	if acquired, _, waited, _ := lc.snapshot(); len(acquired) != 0 || len(waited) != 0 {
		t.Fatalf("leased/waited without a resolved session: acquired=%v waited=%v", acquired, waited)
	}
	f.expectNoUnableReport(t)
}

// #9517: after the spawn, the PAM lookup targets the session the helper was
// leased in, not the console again: the console can move in between.
func TestRunPamFlowReFindsTheLeasedSessionNotTheConsole(t *testing.T) {
	key := sessionbroker.HelperKey{WindowsSessionID: 1, Role: ipc.HelperRoleSystem}
	lc := &fakeLifecycle{mode: "on-demand", waitResults: map[sessionbroker.HelperKey]sessionbroker.HelperWaitResult{
		key: {Status: sessionbroker.HelperWaitReady},
	}}
	f := &pamSpawnFixture{readyAfter: 1}
	h := f.heartbeat(lc)
	consoles := []string{"1", "8"}
	h.pamConsoleSessionID = func() string {
		c := consoles[0]
		if len(consoles) > 1 {
			consoles = consoles[1:]
		}
		return c
	}

	h.RunPamFlow(context.Background(), etwlua.Event{SubjectSessionID: 0},
		etwlua.ElevationOutcome{Status: etwlua.ElevationPending, RequestID: "req-console-moved"})

	f.mu.Lock()
	targets := append([]string(nil), f.targets...)
	f.mu.Unlock()
	if len(targets) < 2 || targets[0] != "" || targets[1] != "1" {
		t.Fatalf("find targets = %q, want the unresolved lookup then the leased session \"1\"", targets)
	}
	f.expectNoUnableReport(t)
}
