package userhelper

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/tccdiag"
)

var restartNow = time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)

func ago(d time.Duration) time.Time { return restartNow.Add(-d) }

func history(recs ...tccRestartRecord) tccRestartHistory {
	return tccRestartHistory{Restarts: recs}
}

// #11292: the helper restarts itself only on the TCC database's own verdict
// that the grant is present and matches this code (unexplained), confirmed
// on two checks in a row, while nothing is on screen and the persisted
// history allows it. Everything else keeps today's behaviour.
func TestDecideTCCSelfRestart(t *testing.T) {
	const fp = "fp-a"
	cases := []struct {
		name        string
		state       tccRestartState
		wantRestart bool
		wantReason  string
	}{
		{
			name:        "unexplained, confirmed, idle, no history: restarts",
			state:       tccRestartState{Verdict: tccdiag.VerdictUnexplained, Fingerprint: fp, Confirmations: 2},
			wantRestart: true, wantReason: tccRestartReasonRestart,
		},
		{
			name:       "unexplained, first sighting: waits for a second check",
			state:      tccRestartState{Verdict: tccdiag.VerdictUnexplained, Fingerprint: fp, Confirmations: 1},
			wantReason: tccRestartReasonUnconfirmed,
		},
		// A bare denial is never a reason: on macOS 26 preflight reports denied
		// while the grant is present (#8390), and without the database the
		// helper cannot tell a missing grant from a stale one.
		{
			name:       "unobservable (no Full Disk Access): never restarts",
			state:      tccRestartState{Verdict: tccdiag.VerdictUnobservable, Fingerprint: fp, Confirmations: 5},
			wantReason: tccRestartReasonNotUnexplained,
		},
		{
			name:       "not granted: never restarts",
			state:      tccRestartState{Verdict: tccdiag.VerdictNotGranted, Fingerprint: fp, Confirmations: 5},
			wantReason: tccRestartReasonNotUnexplained,
		},
		{
			name:       "requirement mismatch (#5953): a restart cannot help",
			state:      tccRestartState{Verdict: tccdiag.VerdictRequirementMismatch, Fingerprint: fp, Confirmations: 5},
			wantReason: tccRestartReasonNotUnexplained,
		},
		{
			name:       "legacy row without csreq: a restart cannot help",
			state:      tccRestartState{Verdict: tccdiag.VerdictLegacyRowNoCsreq, Fingerprint: fp, Confirmations: 5},
			wantReason: tccRestartReasonNotUnexplained,
		},
		{
			name:       "no verdict (nothing denied): never restarts",
			state:      tccRestartState{Confirmations: 5},
			wantReason: tccRestartReasonNotUnexplained,
		},
		{
			name:       "unexplained without a fingerprint: cannot rate-limit, so no",
			state:      tccRestartState{Verdict: tccdiag.VerdictUnexplained, Confirmations: 2},
			wantReason: tccRestartReasonNoFingerprint,
		},
		{
			name: "remote desktop session active: never exits under a technician",
			state: tccRestartState{Verdict: tccdiag.VerdictUnexplained, Fingerprint: fp, Confirmations: 2,
				Busy: "remote desktop session active"},
			wantReason: tccRestartReasonBusy,
		},
		{
			name: "consent dialog open: never exits under the user",
			state: tccRestartState{Verdict: tccdiag.VerdictUnexplained, Fingerprint: fp, Confirmations: 2,
				Busy: "consent dialog open"},
			wantReason: tccRestartReasonBusy,
		},
		{
			name: "history unreadable: fails closed",
			state: tccRestartState{Verdict: tccdiag.VerdictUnexplained, Fingerprint: fp, Confirmations: 2,
				HistoryErr: errors.New("corrupt")},
			wantReason: tccRestartReasonHistoryUnreadable,
		},
		{
			name: "already restarted for this grant state today: no loop",
			state: tccRestartState{Verdict: tccdiag.VerdictUnexplained, Fingerprint: fp, Confirmations: 2,
				History: history(tccRestartRecord{At: ago(23 * time.Hour), Fingerprint: fp})},
			wantReason: tccRestartReasonAlreadyRestarted,
		},
		// A restart that did not cure this grant state will not cure it
		// tomorrow either: no daily repeat until the rows or the build change.
		{
			name: "same grant state, last restart days ago: still no repeat",
			state: tccRestartState{Verdict: tccdiag.VerdictUnexplained, Fingerprint: fp, Confirmations: 2,
				History: history(tccRestartRecord{At: ago(72 * time.Hour), Fingerprint: fp})},
			wantReason: tccRestartReasonAlreadyRestarted,
		},
		{
			name: "new grant state, but a restart moments ago: waits out the gap",
			state: tccRestartState{Verdict: tccdiag.VerdictUnexplained, Fingerprint: fp, Confirmations: 2,
				History: history(tccRestartRecord{At: ago(10 * time.Minute), Fingerprint: "fp-b"})},
			wantReason: tccRestartReasonTooSoon,
		},
		{
			name: "new grant state after the gap: restarts",
			state: tccRestartState{Verdict: tccdiag.VerdictUnexplained, Fingerprint: fp, Confirmations: 2,
				History: history(tccRestartRecord{At: ago(31 * time.Minute), Fingerprint: "fp-b"})},
			wantRestart: true, wantReason: tccRestartReasonRestart,
		},
		{
			name: "budget spent across grant states: no more today",
			state: tccRestartState{Verdict: tccdiag.VerdictUnexplained, Fingerprint: fp, Confirmations: 2,
				History: history(
					tccRestartRecord{At: ago(20 * time.Hour), Fingerprint: "fp-b"},
					tccRestartRecord{At: ago(10 * time.Hour), Fingerprint: "fp-c"},
					tccRestartRecord{At: ago(2 * time.Hour), Fingerprint: "fp-d"},
				)},
			wantReason: tccRestartReasonBudgetSpent,
		},
		{
			name: "old restarts outside the window do not count against the budget",
			state: tccRestartState{Verdict: tccdiag.VerdictUnexplained, Fingerprint: fp, Confirmations: 2,
				History: history(
					tccRestartRecord{At: ago(50 * time.Hour), Fingerprint: "fp-b"},
					tccRestartRecord{At: ago(40 * time.Hour), Fingerprint: "fp-c"},
					tccRestartRecord{At: ago(30 * time.Hour), Fingerprint: "fp-d"},
				)},
			wantRestart: true, wantReason: tccRestartReasonRestart,
		},
		// A clock set back must not open the gate: a record from the future
		// is treated as just now.
		{
			name: "record in the future (clock moved back): treated as recent",
			state: tccRestartState{Verdict: tccdiag.VerdictUnexplained, Fingerprint: fp, Confirmations: 2,
				History: history(tccRestartRecord{At: restartNow.Add(72 * time.Hour), Fingerprint: "fp-b"})},
			wantReason: tccRestartReasonTooSoon,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := tc.state
			s.Now = restartNow
			restart, reason := decideTCCSelfRestart(s)
			if restart != tc.wantRestart || reason != tc.wantReason {
				t.Fatalf("decideTCCSelfRestart = (%v, %q), want (%v, %q)", restart, reason, tc.wantRestart, tc.wantReason)
			}
		})
	}
}

func unexplainedDiagnosis(lastModified int64) *tccdiag.Diagnosis {
	sat := true
	return &tccdiag.Diagnosis{
		Verdict:        tccdiag.VerdictUnexplained,
		ExecutablePath: "/usr/local/bin/breeze-desktop-helper",
		Signing:        tccdiag.Signing{Kind: tccdiag.SigningDeveloperID, CDHash: "abc123"},
		Services: []tccdiag.ServiceDiagnosis{
			{Service: tccdiag.ServiceScreenCapture, Observed: true, Database: "system", RowFound: true,
				Client: "/usr/local/bin/breeze-desktop-helper", AuthValue: 2, AuthReason: 4,
				LastModified: lastModified, RequirementSatisfied: &sat, Verdict: tccdiag.VerdictUnexplained},
			{Service: tccdiag.ServiceAccessibility, Observed: true, Database: "system", RowFound: true,
				Client: "/usr/local/bin/breeze-desktop-helper", AuthValue: 2, AuthReason: 4,
				LastModified: lastModified, RequirementSatisfied: &sat, Verdict: tccdiag.VerdictUnexplained},
		},
	}
}

// The grant state is the rows and the code they were checked against: a
// user re-granting (a new last_modified) or an upgraded helper (a new
// cdhash) is a new state; re-reading the same rows is not.
func TestTCCGrantFingerprint(t *testing.T) {
	base := tccGrantFingerprint(unexplainedDiagnosis(100))
	if base == "" {
		t.Fatal("fingerprint of a diagnosis with rows is empty")
	}
	if again := tccGrantFingerprint(unexplainedDiagnosis(100)); again != base {
		t.Fatalf("same rows gave a different fingerprint: %q vs %q", again, base)
	}

	reordered := unexplainedDiagnosis(100)
	reordered.Services[0], reordered.Services[1] = reordered.Services[1], reordered.Services[0]
	if got := tccGrantFingerprint(reordered); got != base {
		t.Fatalf("service order changed the fingerprint: %q vs %q", got, base)
	}

	if got := tccGrantFingerprint(unexplainedDiagnosis(200)); got == base {
		t.Fatal("a re-granted row (new last_modified) kept the same fingerprint")
	}

	upgraded := unexplainedDiagnosis(100)
	upgraded.Signing.CDHash = "def456"
	if got := tccGrantFingerprint(upgraded); got == base {
		t.Fatal("a different helper build (new cdhash) kept the same fingerprint")
	}

	oneService := unexplainedDiagnosis(100)
	oneService.Services = oneService.Services[:1]
	if got := tccGrantFingerprint(oneService); got == base {
		t.Fatal("a different set of denied services kept the same fingerprint")
	}

	if got := tccGrantFingerprint(nil); got != "" {
		t.Fatalf("nil diagnosis fingerprint = %q, want empty", got)
	}
	empty := unexplainedDiagnosis(100)
	empty.Services = nil
	if got := tccGrantFingerprint(empty); got != "" {
		t.Fatalf("diagnosis with no services fingerprint = %q, want empty", got)
	}
}

type memRestartStore struct {
	h       tccRestartHistory
	loadErr error
	saveErr error
	saves   int
}

func (m *memRestartStore) Load() (tccRestartHistory, error) { return m.h, m.loadErr }
func (m *memRestartStore) Save(h tccRestartHistory) error {
	if m.saveErr != nil {
		return m.saveErr
	}
	m.saves++
	m.h = h
	m.loadErr = nil // the file was rewritten
	return nil
}

type gateHarness struct {
	gate     *tccRestartGate
	store    tccRestartStore
	now      time.Time
	busy     string
	busyFn   func() string // overrides busy when set
	holds    int           // holdForSelfRestart calls
	restarts int
	// heldAtRestart records, per restart, whether intake was held then.
	heldAtRestart []bool
	held          bool
}

func (h *gateHarness) selfRestartBusy() string {
	if h.busyFn != nil {
		return h.busyFn()
	}
	return h.busy
}

// holdForSelfRestart behaves like the client's: hold, then report busy,
// releasing the hold when something is still running.
func (h *gateHarness) holdForSelfRestart() string {
	h.holds++
	h.held = true
	busy := h.selfRestartBusy()
	if busy != "" {
		h.held = false
	}
	return busy
}

func (h *gateHarness) mem() *memRestartStore { return h.store.(*memRestartStore) }

func newGateHarness(store tccRestartStore) *gateHarness {
	h := &gateHarness{store: store, now: restartNow}
	h.gate = &tccRestartGate{
		now:   func() time.Time { return h.now },
		store: store,
		guard: h,
		restart: func() {
			h.restarts++
			h.heldAtRestart = append(h.heldAtRestart, h.held)
		},
	}
	return h
}

// The loop-facing gate: one restart for a confirmed unexplained verdict,
// recorded before it exits, and none for the same grant state afterwards.
func TestTCCRestartGateRestartsOnceAfterConfirmation(t *testing.T) {
	h := newGateHarness(&memRestartStore{})

	if h.gate.observe(unexplainedDiagnosis(100)) {
		t.Fatal("restarted on the first unexplained check")
	}
	if !h.gate.pending() {
		t.Fatal("a first unexplained check should leave a confirmation pending")
	}
	h.now = h.now.Add(2 * time.Minute)
	if !h.gate.observe(unexplainedDiagnosis(100)) {
		t.Fatal("did not restart on the confirming unexplained check")
	}
	if h.restarts != 1 || h.mem().saves != 1 {
		t.Fatalf("restarts=%d saves=%d, want 1 and 1", h.restarts, h.mem().saves)
	}
	if got := h.mem().h.Restarts; len(got) != 1 || !got[0].At.Equal(h.now) || got[0].Fingerprint != tccGrantFingerprint(unexplainedDiagnosis(100)) {
		t.Fatalf("recorded history = %+v", got)
	}

	// The process exits now, so this gate is spent: no second request.
	h.now = h.now.Add(2 * time.Minute)
	if h.gate.observe(unexplainedDiagnosis(100)) || h.restarts != 1 {
		t.Fatalf("restart requested twice from one process (restarts=%d)", h.restarts)
	}

	// The respawned helper still sees the same grant state denied: it must
	// not restart again (this is the loop the history prevents).
	next := newGateHarness(h.store)
	next.now = h.now.Add(time.Minute)
	next.gate.observe(unexplainedDiagnosis(100))
	next.now = next.now.Add(2 * time.Minute)
	if next.gate.observe(unexplainedDiagnosis(100)) || next.restarts != 0 {
		t.Fatal("the respawned helper restarted again for the same grant state")
	}
}

func TestTCCRestartGateResetsOnAnotherVerdict(t *testing.T) {
	h := newGateHarness(&memRestartStore{})
	h.gate.observe(unexplainedDiagnosis(100))
	// A granted check (nil diagnosis) in between breaks the run.
	h.gate.observe(nil)
	if h.gate.pending() {
		t.Fatal("a granted check should clear the pending confirmation")
	}
	if h.gate.observe(unexplainedDiagnosis(100)) {
		t.Fatal("restarted without two consecutive unexplained checks")
	}
	unobservable := unexplainedDiagnosis(100)
	unobservable.Verdict = tccdiag.VerdictUnobservable
	h.gate.observe(unobservable)
	if h.gate.observe(unexplainedDiagnosis(100)) {
		t.Fatal("an unobservable check in between should have broken the run")
	}
	// A changed grant state between the two checks restarts the count too.
	if h.gate.observe(unexplainedDiagnosis(200)) {
		t.Fatal("restarted on the first check of a new grant state")
	}
	if !h.gate.observe(unexplainedDiagnosis(200)) {
		t.Fatal("did not restart once the new grant state was confirmed")
	}
}

func TestTCCRestartGateWaitsWhileBusy(t *testing.T) {
	h := newGateHarness(&memRestartStore{})
	h.busy = "remote desktop session active"
	h.gate.observe(unexplainedDiagnosis(100))
	if h.gate.observe(unexplainedDiagnosis(100)) || h.restarts != 0 || h.mem().saves != 0 {
		t.Fatal("restarted (or spent the budget) during a remote desktop session")
	}
	if !h.gate.pending() {
		t.Fatal("a busy deferral should keep the fast re-check going")
	}
	h.busy = ""
	if !h.gate.observe(unexplainedDiagnosis(100)) || h.restarts != 1 {
		t.Fatal("did not restart once the session ended")
	}
}

// Work that arrives while the record is being written (a technician's
// session start, a consent request) still wins: the gate re-checks just
// before it exits, rolls the record back, and tries again later.
func TestTCCRestartGateRechecksBusyBeforeExit(t *testing.T) {
	h := newGateHarness(&memRestartStore{})
	h.gate.observe(unexplainedDiagnosis(100))
	calls := 0
	h.busyFn = func() string {
		calls++
		if calls == 1 {
			return "" // idle when the decision is made
		}
		return "dialog or command in progress" // busy by the time it would exit
	}
	if h.gate.observe(unexplainedDiagnosis(100)) || h.restarts != 0 {
		t.Fatal("exited although work arrived before the exit")
	}
	if got := h.mem().h.Restarts; len(got) != 0 {
		t.Fatalf("history not rolled back: %+v", got)
	}
	if d, ok := h.gate.recheckIn(); !ok || d != tccSelfRestartBusyRecheck {
		t.Fatalf("recheckIn = (%v, %v), want the busy re-check", d, ok)
	}
	h.busyFn = nil
	if !h.gate.observe(unexplainedDiagnosis(100)) || h.restarts != 1 {
		t.Fatal("did not restart once the work finished")
	}
}

// A corrupt record cannot be trusted either way: it is replaced by a fresh
// one stamped now, so the min gap and the budget still apply and the feature
// is not disabled for good.
func TestTCCRestartGateResetsCorruptHistory(t *testing.T) {
	store := &memRestartStore{loadErr: fmt.Errorf("%w: bad json", errTCCRestartHistoryCorrupt)}
	h := newGateHarness(store)
	h.gate.observe(unexplainedDiagnosis(100))
	if h.gate.observe(unexplainedDiagnosis(100)) || h.restarts != 0 {
		t.Fatal("restarted on a corrupt history")
	}
	if got := store.h.Restarts; len(got) != 1 || !got[0].At.Equal(restartNow) {
		t.Fatalf("corrupt history not reset to a now-stamped record: %+v", got)
	}

	next := newGateHarness(store)
	next.now = restartNow.Add(tccSelfRestartMinGap + time.Minute)
	next.gate.observe(unexplainedDiagnosis(100))
	if !next.gate.observe(unexplainedDiagnosis(100)) {
		t.Fatal("feature stayed disabled after the corrupt history was reset")
	}
}

// The record is what stops a loop, so a restart that cannot be recorded
// does not happen.
func TestTCCRestartGateFailsClosedOnStoreErrors(t *testing.T) {
	for _, store := range []*memRestartStore{
		{saveErr: errors.New("read-only")},
		{loadErr: errors.New("corrupt")},
	} {
		h := newGateHarness(store)
		h.gate.observe(unexplainedDiagnosis(100))
		if h.gate.observe(unexplainedDiagnosis(100)) || h.restarts != 0 {
			t.Fatalf("restarted with store load=%v save=%v", store.loadErr, store.saveErr)
		}
		// A store failure is not transient: back to the normal interval.
		if _, ok := h.gate.recheckIn(); ok {
			t.Fatalf("store failure kept the fast re-check (load=%v save=%v)", store.loadErr, store.saveErr)
		}
	}
}

func TestNextTCCCheckInterval(t *testing.T) {
	unconfirmed := newGateHarness(&memRestartStore{})
	unconfirmed.gate.observe(unexplainedDiagnosis(100))
	busy := newGateHarness(&memRestartStore{})
	busy.busy = "remote desktop session active"
	busy.gate.observe(unexplainedDiagnosis(100))
	busy.gate.observe(unexplainedDiagnosis(100))
	idle := newGateHarness(&memRestartStore{})

	cases := []struct {
		name       string
		allGranted bool
		sinceStart time.Duration
		gate       *tccRestartGate
		want       time.Duration
	}{
		{"granted, no gate", true, time.Minute, nil, tccCheckInterval},
		{"missing, inside the fast window", false, time.Minute, nil, tccFastCheckInterval},
		{"missing, past the fast window", false, time.Hour, nil, tccCheckInterval},
		{"past the fast window, confirmation pending", false, time.Hour, unconfirmed.gate, tccFastCheckInterval},
		{"past the fast window, held by a session", false, time.Hour, busy.gate, tccSelfRestartBusyRecheck},
		{"inside the fast window, held by a session: fast wins", false, time.Minute, busy.gate, tccFastCheckInterval},
		{"idle gate changes nothing", false, time.Hour, idle.gate, tccCheckInterval},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := nextTCCCheckInterval(tc.allGranted, tc.sinceStart, tc.gate); got != tc.want {
				t.Fatalf("nextTCCCheckInterval = %v, want %v", got, tc.want)
			}
		})
	}
}

// The loop-start half: a gate only for an opted-in user-session desktop
// helper, and the quiet policy when it just restarted itself.
func TestSetupTCCSelfRestart(t *testing.T) {
	restore := resetSelfRestartSignalForTest()
	t.Cleanup(restore)
	desktop := tccLoopPolicyFor(ipc.HelperBinaryDesktopHelper, false)
	recent := &memRestartStore{h: history(tccRestartRecord{At: ago(time.Minute)})}
	now := func() time.Time { return restartNow }

	if _, gate, _ := setupTCCSelfRestart(desktop, ipc.DesktopContextUserSession, recent, nil, now); gate != nil {
		t.Fatal("gate created without the opt-in")
	}
	EnableSelfRestart()
	if _, gate, _ := setupTCCSelfRestart(desktop, ipc.DesktopContextLoginWindow, recent, nil, now); gate != nil {
		t.Fatal("gate created for the login-window helper")
	}
	other := tccLoopPolicyFor(ipc.HelperBinaryUserHelper, false)
	if _, gate, _ := setupTCCSelfRestart(other, ipc.DesktopContextUserSession, recent, nil, now); gate != nil {
		t.Fatal("gate created for the legacy user helper")
	}

	policy, gate, quiet := setupTCCSelfRestart(desktop, ipc.DesktopContextUserSession, recent, nil, now)
	if gate == nil || !quiet || policy.requestScreenRecording || policy.promptAccessibility {
		t.Fatalf("just-restarted helper: gate=%v quiet=%v policy=%+v, want a gate and both prompts off", gate != nil, quiet, policy)
	}
	policy, gate, quiet = setupTCCSelfRestart(desktop, ipc.DesktopContextUserSession, &memRestartStore{}, nil, now)
	if gate == nil || quiet || !policy.requestScreenRecording || !policy.promptAccessibility {
		t.Fatalf("ordinary start: gate=%v quiet=%v policy=%+v, want a gate and the prompts kept", gate != nil, quiet, policy)
	}
}

func TestTCCRestartGateRecordPrunesOutsideWindow(t *testing.T) {
	store := &memRestartStore{h: history(
		tccRestartRecord{At: ago(72 * time.Hour), Fingerprint: "old"},
		tccRestartRecord{At: ago(2 * time.Hour), Fingerprint: "recent"},
	)}
	h := newGateHarness(store)
	h.gate.observe(unexplainedDiagnosis(100))
	if !h.gate.observe(unexplainedDiagnosis(100)) {
		t.Fatal("did not restart")
	}
	if got := store.h.Restarts; len(got) != 2 || got[0].Fingerprint != "recent" {
		t.Fatalf("history after save = %+v, want the recent record plus the new one", got)
	}
}

func TestFileTCCRestartStoreRoundTrip(t *testing.T) {
	dir := t.TempDir()
	store := fileTCCRestartStore{path: filepath.Join(dir, "tcc-self-restart")}

	h, err := store.Load()
	if err != nil || len(h.Restarts) != 0 {
		t.Fatalf("missing file: Load = %+v, %v; want empty history, nil", h, err)
	}

	want := history(tccRestartRecord{At: restartNow, Fingerprint: "fp-a"})
	if err := store.Save(want); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, err := store.Load()
	if err != nil || len(got.Restarts) != 1 || !got.Restarts[0].At.Equal(restartNow) || got.Restarts[0].Fingerprint != "fp-a" {
		t.Fatalf("Load after Save = %+v, %v", got, err)
	}
	info, err := os.Stat(store.path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("record file mode = %o, want 600", perm)
	}

	if err := os.WriteFile(store.path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load(); err == nil {
		t.Fatal("corrupt record loaded without an error")
	}
}

// A helper that just restarted itself raises no consent dialog or
// Accessibility prompt on its way back up (#4327): the database already holds
// the grant, so a prompt could only repeat what the user did.
func TestSelfRestartedWithin(t *testing.T) {
	cases := []struct {
		name string
		h    tccRestartHistory
		want bool
	}{
		{"no history", history(), false},
		{"restart a minute ago", history(tccRestartRecord{At: ago(time.Minute)}), true},
		{"restart long ago", history(tccRestartRecord{At: ago(time.Hour)}), false},
		{"latest of several is recent", history(tccRestartRecord{At: ago(3 * time.Hour)}, tccRestartRecord{At: ago(2 * time.Minute)}), true},
		// A clock set back must not silence the prompts for the length of
		// the skew; the prompts keep their own limits.
		{"record from the future", history(tccRestartRecord{At: restartNow.Add(48 * time.Hour)}), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := selfRestartedWithin(tc.h, restartNow, tccSelfRestartQuietPeriod); got != tc.want {
				t.Fatalf("selfRestartedWithin = %v, want %v", got, tc.want)
			}
		})
	}
}

// Only the console-user desktop helper restarts itself: it is the process
// whose grant goes stale (#11292), and its LaunchAgent respawns it.
func TestSelfRestartAllowedFor(t *testing.T) {
	restore := resetSelfRestartSignalForTest()
	t.Cleanup(restore)
	desktop := tccLoopPolicyFor(ipc.HelperBinaryDesktopHelper, false)

	// A process that did not opt in (nothing relaunches it) never restarts.
	if selfRestartAllowedFor(desktop, ipc.DesktopContextUserSession) {
		t.Fatal("self-restart allowed before the process opted in")
	}
	EnableSelfRestart()

	other := tccLoopPolicyFor(ipc.HelperBinaryUserHelper, false)
	cases := []struct {
		name    string
		policy  tccLoopPolicy
		context string
		want    bool
	}{
		{"desktop helper, user session", desktop, ipc.DesktopContextUserSession, true},
		{"desktop helper, empty context (defaults to user session)", desktop, "", true},
		{"desktop helper, login window", desktop, ipc.DesktopContextLoginWindow, false},
		{"legacy user helper", other, ipc.DesktopContextUserSession, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := selfRestartAllowedFor(tc.policy, tc.context); got != tc.want {
				t.Fatalf("selfRestartAllowedFor = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestRequestHelperSelfRestartClosesOnce(t *testing.T) {
	restore := resetSelfRestartSignalForTest()
	t.Cleanup(restore)

	ch := EnableSelfRestart()
	select {
	case <-ch:
		t.Fatal("restart signalled before anyone asked")
	default:
	}
	requestHelperSelfRestart()
	requestHelperSelfRestart() // must not panic on a second close
	select {
	case <-ch:
	default:
		t.Fatal("restart not signalled")
	}
}

// A helper that restarted itself moments ago comes back up without either
// prompt; any other start keeps the policy it had.
func TestApplySelfRestartQuiet(t *testing.T) {
	desktop := tccLoopPolicyFor(ipc.HelperBinaryDesktopHelper, false)
	cases := []struct {
		name      string
		store     *memRestartStore
		wantQuiet bool
	}{
		{"no history", &memRestartStore{}, false},
		{"self-restart a minute ago", &memRestartStore{h: history(tccRestartRecord{At: ago(time.Minute)})}, true},
		{"self-restart an hour ago", &memRestartStore{h: history(tccRestartRecord{At: ago(time.Hour)})}, false},
		// Unreadable history: we cannot tell, so keep today's behaviour; the
		// prompts are separately rate-limited (#4327).
		{"history unreadable", &memRestartStore{loadErr: errors.New("corrupt")}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, quiet := applySelfRestartQuiet(desktop, tc.store, restartNow)
			if quiet != tc.wantQuiet {
				t.Fatalf("quiet = %v, want %v", quiet, tc.wantQuiet)
			}
			wantPrompts := !tc.wantQuiet
			if got.requestScreenRecording != wantPrompts || got.promptAccessibility != wantPrompts {
				t.Fatalf("policy prompts = (sr %v, ax %v), want both %v", got.requestScreenRecording, got.promptAccessibility, wantPrompts)
			}
			if !got.diagnoseDenial || !got.reportRemoteDesktop {
				t.Fatalf("quiet period changed more than the prompts: %+v", got)
			}
		})
	}
}

// #11292: the helper never restarts itself under a remote desktop session, an
// open prompt, or a dialog or command handler still running.
func TestClientSelfRestartBusy(t *testing.T) {
	c := NewWithOptions("/nonexistent.sock", ipc.HelperRoleUser, ipc.HelperBinaryDesktopHelper, ipc.DesktopContextUserSession)
	if got := c.selfRestartBusy(); got != "" {
		t.Fatalf("idle client busy = %q, want empty", got)
	}

	c.prompts.mu.Lock()
	c.prompts.active["p1"] = &nativeActive{}
	c.prompts.mu.Unlock()
	if got := c.selfRestartBusy(); got == "" {
		t.Fatal("an open native prompt did not count as busy")
	}
	c.prompts.mu.Lock()
	delete(c.prompts.active, "p1")
	c.prompts.mu.Unlock()

	c.desktopMgr.mgr.SetSessionActiveForTest("s1", true)
	if got := c.selfRestartBusy(); got == "" {
		t.Fatal("an active remote desktop session did not count as busy")
	}
	c.desktopMgr.mgr.SetSessionActiveForTest("s1", false)
	if got := c.selfRestartBusy(); got != "" {
		t.Fatalf("busy = %q after the session ended, want empty", got)
	}

	release := make(chan struct{})
	c.goTracked("consent_request", func() { <-release })
	waitFor(t, func() bool { return c.selfRestartBusy() != "" })
	close(release)
	waitFor(t, func() bool { return c.selfRestartBusy() == "" })

	// A panicking handler must not leave the helper "busy" forever.
	c.goTracked("panics", func() { panic("boom") })
	waitFor(t, func() bool { return c.selfRestartBusy() == "" })
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not reached")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// "One restart per grant state, ever" must survive the 24 h rate window:
// state A restarts, state B restarts 25 h later, and A seen again must not
// restart a second time (#11292 review). Saving B's restart used to prune
// every record older than the window, A's fingerprint with it.
func TestTCCRestartGateRestartedStateOutlivesTheRateWindow(t *testing.T) {
	store := &memRestartStore{}
	restartFor := func(at time.Time, lastModified int64) bool {
		h := newGateHarness(store)
		h.now = at
		h.gate.observe(unexplainedDiagnosis(lastModified))
		h.now = at.Add(2 * time.Minute)
		return h.gate.observe(unexplainedDiagnosis(lastModified))
	}
	if !restartFor(restartNow, 100) {
		t.Fatal("state A did not restart the first time")
	}
	if !restartFor(restartNow.Add(25*time.Hour), 200) {
		t.Fatal("state B did not restart 25 h later")
	}
	if restartFor(restartNow.Add(50*time.Hour), 100) {
		t.Fatal("state A restarted a second time once its record left the 24 h window")
	}
}

// The restarted-states list is bounded: the oldest state is evicted once it
// is full, a repeated state is not stored twice, and the rate window still
// keeps only the restarts inside it.
func TestTCCRestartHistoryWithRestart(t *testing.T) {
	var h tccRestartHistory
	for i := 0; i < tccSelfRestartMaxStates; i++ {
		h.RestartedStates = append(h.RestartedStates, tccRestartRecord{At: ago(time.Duration(100-i) * time.Hour), Fingerprint: fmt.Sprintf("fp-%d", i)})
	}
	h.Restarts = []tccRestartRecord{
		{At: ago(48 * time.Hour), Fingerprint: "fp-0"},
		{At: ago(time.Hour), Fingerprint: fmt.Sprintf("fp-%d", tccSelfRestartMaxStates-1)},
	}

	next := h.withRestart(restartNow, "fp-new")
	if got := len(next.RestartedStates); got != tccSelfRestartMaxStates {
		t.Fatalf("restarted states = %d, want the cap %d", got, tccSelfRestartMaxStates)
	}
	if next.RestartedStates[0].Fingerprint != "fp-1" {
		t.Fatalf("oldest kept state = %q, want fp-0 evicted", next.RestartedStates[0].Fingerprint)
	}
	if last := next.RestartedStates[len(next.RestartedStates)-1]; last.Fingerprint != "fp-new" || !last.At.Equal(restartNow) {
		t.Fatalf("newest state = %+v, want fp-new at now", last)
	}
	if len(next.Restarts) != 2 || next.Restarts[1].Fingerprint != "fp-new" {
		t.Fatalf("rate window = %+v, want the in-window restart plus the new one", next.Restarts)
	}
	if len(h.RestartedStates) != tccSelfRestartMaxStates || h.RestartedStates[0].Fingerprint != "fp-0" {
		t.Fatal("withRestart modified the history it was called on")
	}

	again := next.withRestart(restartNow.Add(time.Hour), "fp-5")
	seen := 0
	for _, r := range again.RestartedStates {
		if r.Fingerprint == "fp-5" {
			seen++
		}
	}
	if seen != 1 {
		t.Fatalf("fp-5 stored %d times, want once", seen)
	}

	// An evicted state is no longer blocked: the cap bounds the file, and
	// the rate window still bounds how often any restart happens.
	if ok, reason := decideTCCSelfRestart(tccRestartState{
		Verdict: tccdiag.VerdictUnexplained, Fingerprint: "fp-0", Confirmations: 2,
		History: next, Now: restartNow.Add(time.Hour),
	}); !ok {
		t.Fatalf("evicted state refused: %s", reason)
	}
	if ok, reason := decideTCCSelfRestart(tccRestartState{
		Verdict: tccdiag.VerdictUnexplained, Fingerprint: "fp-1", Confirmations: 2,
		History: next, Now: restartNow.Add(time.Hour),
	}); ok || reason != tccRestartReasonAlreadyRestarted {
		t.Fatalf("kept state = (%v, %s), want already restarted", ok, reason)
	}
}

// The record lives only in the per-user state dir. When that dir cannot be
// made, there is no second location: a fallback would start an empty
// history and reset the limits (#11292 review).
func TestTCCStateFileIn(t *testing.T) {
	home := t.TempDir()
	path, err := tccStateFileIn(home, tccSelfRestartRecordName)
	if err != nil {
		t.Fatalf("tccStateFileIn: %v", err)
	}
	wantDir := filepath.Join(home, "Library", "Application Support", "Breeze")
	if path != filepath.Join(wantDir, tccSelfRestartRecordName) {
		t.Fatalf("path = %q, want it in %q", path, wantDir)
	}
	if info, err := os.Stat(wantDir); err != nil || !info.IsDir() || info.Mode().Perm() != 0o700 {
		t.Fatalf("state dir = %v, %v; want a 0700 dir", info, err)
	}

	blocked := t.TempDir()
	if err := os.WriteFile(filepath.Join(blocked, "Library"), []byte("not a dir"), 0o600); err != nil {
		t.Fatal(err)
	}
	if path, err := tccStateFileIn(blocked, tccSelfRestartRecordName); err == nil {
		t.Fatalf("state dir uncreatable, got path %q and no error", path)
	}
	if path, err := tccStateFileIn("", tccSelfRestartRecordName); err == nil {
		t.Fatalf("no home dir, got path %q and no error", path)
	}
}

// With the state dir unavailable the helper does not restart (and does not
// write a record anywhere), and a start is never treated as quiet.
func TestPrimaryDirTCCRestartStoreFailsClosed(t *testing.T) {
	resolves := 0
	store := primaryDirTCCRestartStore{resolve: func() (string, error) {
		resolves++
		return "", errors.New("mkdir: permission denied")
	}}
	if _, err := store.Load(); err == nil {
		t.Fatal("Load succeeded without a state dir")
	}
	if err := store.Save(history(tccRestartRecord{At: restartNow, Fingerprint: "fp"})); err == nil {
		t.Fatal("Save succeeded without a state dir")
	}

	h := newGateHarness(store)
	h.gate.observe(unexplainedDiagnosis(100))
	if h.gate.observe(unexplainedDiagnosis(100)) || h.restarts != 0 {
		t.Fatal("restarted although the state dir is unavailable")
	}
	if h.gate.lastReason != tccRestartReasonHistoryUnreadable {
		t.Fatalf("hold reason = %q, want %q", h.gate.lastReason, tccRestartReasonHistoryUnreadable)
	}
	if _, quiet := applySelfRestartQuiet(tccLoopPolicyFor(ipc.HelperBinaryDesktopHelper, false), store, restartNow); quiet {
		t.Fatal("a start with no readable record was treated as a self-restart")
	}

	// The path is resolved on each use, so a dir that comes back is used.
	dir := t.TempDir()
	recovered := primaryDirTCCRestartStore{resolve: func() (string, error) { return filepath.Join(dir, tccSelfRestartRecordName), nil }}
	want := history(tccRestartRecord{At: restartNow, Fingerprint: "fp"})
	if err := recovered.Save(want); err != nil {
		t.Fatalf("Save with the dir back: %v", err)
	}
	if got, err := recovered.Load(); err != nil || len(got.Restarts) != 1 {
		t.Fatalf("Load with the dir back = %+v, %v", got, err)
	}
	if resolves < 3 {
		t.Fatalf("resolve called %d times, want once per use", resolves)
	}
}

// The final check before exiting first stops the helper taking new work, so
// nothing can start between that check and the shutdown; a decision that
// says no never holds intake.
func TestTCCRestartGateHoldsIntakeBeforeExit(t *testing.T) {
	h := newGateHarness(&memRestartStore{})
	h.gate.observe(unexplainedDiagnosis(100))
	if h.holds != 0 {
		t.Fatal("held intake on an unconfirmed check")
	}
	h.busy = "remote desktop session active"
	h.gate.observe(unexplainedDiagnosis(100))
	if h.holds != 0 {
		t.Fatal("held intake although the decision already said busy")
	}
	h.busy = ""
	if !h.gate.observe(unexplainedDiagnosis(100)) {
		t.Fatal("did not restart")
	}
	if h.holds != 1 || len(h.heldAtRestart) != 1 || !h.heldAtRestart[0] {
		t.Fatalf("holds=%d heldAtRestart=%v, want one hold in place when the restart was asked for", h.holds, h.heldAtRestart)
	}
}
