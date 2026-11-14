package userhelper

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/tccdiag"
)

// Self-restart after a stale TCC denial (#11292).
//
// macOS caches a process's Screen Recording (and, on some hosts,
// Accessibility) answer: after the user grants the permission in System
// Settings, the already-running desktop helper keeps reading "denied" until
// it relaunches. The helper's own diagnosis (#10300) sees exactly that case:
// the TCC database holds an allowed row whose stored requirement this code
// satisfies, yet the live check denies (tccdiag.VerdictUnexplained). Before
// this, recovery took a technician's `launchctl kickstart`.
//
// On that verdict, and only on it, the helper exits cleanly so its
// LaunchAgent (KeepAlive=true, agent/service/launchd/
// com.breeze.desktop-helper-user.plist) starts a fresh copy, which reads the
// grant. The guards, each load-bearing:
//
//   - Never on a bare denial. On macOS 26 preflight reports denied while the
//     grant is present (#8390), and without Full Disk Access the database is
//     unreadable (verdict unobservable): neither can tell a stale grant from
//     a missing one. requirement_mismatch and legacy_row_no_csreq (#5953,
//     #3380) are not stale caches; a restart cannot fix them.
//   - Confirmed on two consecutive checks with the same grant state, so a
//     grant landing between the live check and the database read does not
//     cost a restart the live process would not have needed.
//   - Never while a remote desktop session runs, a native prompt is on
//     screen, or a tracked handler (consent, PAM or notification dialog,
//     command, process launch, desktop start) is running; checked when
//     deciding and again just before exiting, after the helper has stopped
//     taking new messages (a hold that lifts after
//     selfRestartIntakeHoldLimit if the exit does not happen).
//   - Persistently rate-limited in the per-user state dir, because the new
//     process forgets everything: one restart per grant state (a restart
//     that did not cure a state will not cure it tomorrow; a re-grant or a
//     new build is a new state), remembered for the last
//     tccSelfRestartMaxStates states whatever their age; and, across all
//     states, at least tccSelfRestartMinGap apart and at most
//     tccSelfRestartMaxPerWindow per tccSelfRestartGrantWindow. The record
//     lives only in ~/Library/Application Support/Breeze: when that cannot
//     be used, or a restart cannot be recorded, the helper does not
//     restart.
//   - A helper that starts within tccSelfRestartQuietPeriod of a
//     self-restart raises neither the Screen Recording consent dialog nor the
//     Accessibility prompt for the rest of that process: the database already
//     holds the grant, and a helper start must not cost the user a dialog
//     (#4327, #4194).
const (
	tccSelfRestartConfirmations = 2
	tccSelfRestartGrantWindow   = 24 * time.Hour
	tccSelfRestartMinGap        = 30 * time.Minute
	tccSelfRestartMaxPerWindow  = 3
	tccSelfRestartQuietPeriod   = 15 * time.Minute
	// tccSelfRestartMaxStates bounds the restarted-states list; the oldest
	// state is evicted first.
	tccSelfRestartMaxStates = 32
	// tccSelfRestartBusyRecheck is how soon a restart held only by a session
	// or dialog is retried: sooner than the hourly check, without probing
	// every 2 minutes for a whole session.
	tccSelfRestartBusyRecheck = 5 * time.Minute
)

// tccSelfRestartRecordName is the record's file name in the helper's per-user
// state dir (~/Library/Application Support/Breeze, tccStateFileIn). Unlike
// the prompt markers it has no temp-dir fallback: a second location would
// start an empty history whenever the first one failed.
const tccSelfRestartRecordName = "tcc-self-restart"

// errTCCRestartHistoryCorrupt marks a record file that exists but does not
// parse: its content cannot be trusted either way, so the gate replaces it.
var errTCCRestartHistoryCorrupt = errors.New("TCC self-restart record is corrupt")

// tccRestartHistoryResetFingerprint stamps the record that replaces a corrupt
// one, so the min gap and the budget still count from the reset.
const tccRestartHistoryResetFingerprint = "history-reset"

// Reasons decideTCCSelfRestart gives; logged, and asserted by tests.
const (
	tccRestartReasonRestart           = "restart"
	tccRestartReasonNotUnexplained    = "verdict_not_unexplained"
	tccRestartReasonNoFingerprint     = "no_grant_fingerprint"
	tccRestartReasonUnconfirmed       = "awaiting_confirmation"
	tccRestartReasonBusy              = "busy"
	tccRestartReasonHistoryUnreadable = "history_unreadable"
	tccRestartReasonAlreadyRestarted  = "already_restarted_for_grant_state"
	tccRestartReasonTooSoon           = "restarted_recently"
	tccRestartReasonBudgetSpent       = "restart_budget_spent"
	// tccRestartReasonRecordUnwritable is the gate's, not the decision's:
	// the decision said yes but the record could not be written.
	tccRestartReasonRecordUnwritable = "record_unwritable"
)

// tccRestartRecord is one self-restart.
type tccRestartRecord struct {
	At          time.Time `json:"at"`
	Fingerprint string    `json:"fingerprint"`
}

// tccRestartHistory is the persisted record of self-restarts, in two parts
// so pruning one cannot forget the other.
type tccRestartHistory struct {
	// Restarts is the rate window: the self-restarts inside
	// tccSelfRestartGrantWindow, whatever their grant state.
	Restarts []tccRestartRecord `json:"restarts"`
	// RestartedStates is the grant states a restart was already spent on,
	// oldest first, at most tccSelfRestartMaxStates, whatever their age.
	RestartedStates []tccRestartRecord `json:"restartedStates,omitempty"`
}

// withRestart is h plus a restart for fingerprint at now: the rate window
// pruned to tccSelfRestartGrantWindow, and the fingerprint added to the
// restarted states (moved to the end if present, the oldest evicted past
// tccSelfRestartMaxStates). h is not modified.
func (h tccRestartHistory) withRestart(now time.Time, fingerprint string) tccRestartHistory {
	var next tccRestartHistory
	for _, r := range h.Restarts {
		if now.Sub(r.At) < tccSelfRestartGrantWindow {
			next.Restarts = append(next.Restarts, r)
		}
	}
	rec := tccRestartRecord{At: now.UTC(), Fingerprint: fingerprint}
	next.Restarts = append(next.Restarts, rec)
	for _, r := range h.RestartedStates {
		if r.Fingerprint != fingerprint {
			next.RestartedStates = append(next.RestartedStates, r)
		}
	}
	next.RestartedStates = append(next.RestartedStates, rec)
	if over := len(next.RestartedStates) - tccSelfRestartMaxStates; over > 0 {
		next.RestartedStates = next.RestartedStates[over:]
	}
	return next
}

// restartedFor reports whether a restart was already spent on fingerprint.
// The rate window is checked too: a record written before RestartedStates
// existed has its states only there.
func (h tccRestartHistory) restartedFor(fingerprint string) bool {
	for _, list := range [][]tccRestartRecord{h.RestartedStates, h.Restarts} {
		for _, r := range list {
			if r.Fingerprint == fingerprint {
				return true
			}
		}
	}
	return false
}

// tccRestartState is everything one restart decision reads.
type tccRestartState struct {
	Verdict     tccdiag.Verdict
	Fingerprint string
	// Confirmations is how many consecutive checks, this one included, saw
	// Verdict with this Fingerprint.
	Confirmations int
	// Busy names what is on screen or in progress ("" when idle).
	Busy       string
	History    tccRestartHistory
	HistoryErr error
	Now        time.Time
}

// decideTCCSelfRestart reports whether the helper should exit so launchd
// starts a fresh copy, and why (see the comment above the constants for the
// rules).
func decideTCCSelfRestart(s tccRestartState) (bool, string) {
	if s.Verdict != tccdiag.VerdictUnexplained {
		return false, tccRestartReasonNotUnexplained
	}
	if s.Fingerprint == "" {
		return false, tccRestartReasonNoFingerprint
	}
	if s.Confirmations < tccSelfRestartConfirmations {
		return false, tccRestartReasonUnconfirmed
	}
	if s.Busy != "" {
		return false, tccRestartReasonBusy
	}
	if s.HistoryErr != nil {
		return false, tccRestartReasonHistoryUnreadable
	}
	// Whatever its age: a state one restart did not cure stays blocked.
	if s.History.restartedFor(s.Fingerprint) {
		return false, tccRestartReasonAlreadyRestarted
	}
	inWindow := 0
	for _, r := range s.History.Restarts {
		// A record from the future (the clock moved back) counts as now, so
		// a clock change cannot open the gate.
		age := s.Now.Sub(r.At)
		if age < 0 {
			age = 0
		}
		if age >= tccSelfRestartGrantWindow {
			continue
		}
		inWindow++
		if age < tccSelfRestartMinGap {
			return false, tccRestartReasonTooSoon
		}
	}
	if inWindow >= tccSelfRestartMaxPerWindow {
		return false, tccRestartReasonBudgetSpent
	}
	return true, tccRestartReasonRestart
}

// tccGrantFingerprint identifies the grant state a diagnosis saw: the code
// checked (cdhash, path) and each denied service's row. A user re-granting
// writes a new last_modified and an upgrade brings a new cdhash, so either is
// a new state; re-reading the same rows is not. "" when there is nothing to
// identify.
func tccGrantFingerprint(d *tccdiag.Diagnosis) string {
	if d == nil || len(d.Services) == 0 {
		return ""
	}
	rows := make([]string, 0, len(d.Services))
	for _, s := range d.Services {
		rows = append(rows, fmt.Sprintf("%s|%s|%s|%d|%d|%d|%s",
			s.Service, s.Database, s.Client, s.AuthValue, s.AuthReason, s.LastModified, s.StoredRequirement))
	}
	sort.Strings(rows)
	sum := sha256.Sum256([]byte(d.Signing.CDHash + "\n" + d.ExecutablePath + "\n" + strings.Join(rows, "\n")))
	return hex.EncodeToString(sum[:8])
}

// selfRestartedWithin reports whether any recorded self-restart is less than
// d before now. A record from the future (the clock moved back) does not
// count: it would otherwise silence the prompts for the length of the skew.
func selfRestartedWithin(h tccRestartHistory, now time.Time, d time.Duration) bool {
	for _, r := range h.Restarts {
		if age := now.Sub(r.At); age >= 0 && age < d {
			return true
		}
	}
	return false
}

// applySelfRestartQuiet turns off the loop's two prompts (the Screen
// Recording consent dialog and the Accessibility prompt) when this helper
// restarted itself within tccSelfRestartQuietPeriod, and reports whether it
// did. An unreadable history changes nothing: both prompts keep their own
// limits (#4327).
func applySelfRestartQuiet(policy tccLoopPolicy, store tccRestartStore, now time.Time) (tccLoopPolicy, bool) {
	h, err := store.Load()
	if err != nil {
		log.Warn("could not read the TCC self-restart record; keeping the usual consent prompts", "error", err.Error())
		return policy, false
	}
	if !selfRestartedWithin(h, now, tccSelfRestartQuietPeriod) {
		return policy, false
	}
	policy.requestScreenRecording = false
	policy.promptAccessibility = false
	return policy, true
}

// setupTCCSelfRestart is the loop-start half of the self-restart: the gate
// for a helper allowed to restart itself (nil otherwise), and the policy with
// the prompts off when this start is one a self-restart asked for. It runs
// before the loop raises any prompt.
func setupTCCSelfRestart(policy tccLoopPolicy, desktopContext string, store tccRestartStore, guard selfRestartGuard, now func() time.Time) (tccLoopPolicy, *tccRestartGate, bool) {
	if !selfRestartAllowedFor(policy, desktopContext) {
		return policy, nil, false
	}
	policy, quiet := applySelfRestartQuiet(policy, store, now())
	return policy, &tccRestartGate{now: now, store: store, guard: guard, restart: requestHelperSelfRestart}, quiet
}

// nextTCCCheckInterval picks the loop's next interval: fast while
// permissions are missing inside the startup window, hourly otherwise, and
// sooner while the self-restart gate awaits a confirming check or waits out
// a session.
func nextTCCCheckInterval(allGranted bool, sinceStart time.Duration, gate *tccRestartGate) time.Duration {
	want := tccCheckInterval
	if !allGranted && sinceStart < tccFastCheckDuration {
		want = tccFastCheckInterval
	}
	if gate != nil {
		if d, ok := gate.recheckIn(); ok && d < want {
			want = d
		}
	}
	return want
}

// selfRestartAllowedFor limits the self-restart to the console-user desktop
// helper: its LaunchAgent respawns it, and it is the process whose grant
// goes stale. The process must have opted in (EnableSelfRestart, per binary);
// the context check is what keeps out the same binary's login-window helper,
// which runs as root under a different launchd job and TCC client; and the
// legacy user helper does not diagnose denials.
func selfRestartAllowedFor(policy tccLoopPolicy, desktopContext string) bool {
	return selfRestartIsEnabled() && policy.diagnoseDenial &&
		normalizedDesktopContext(desktopContext) == ipc.DesktopContextUserSession
}

// normalizedDesktopContext maps "" (and anything unrecognised) to the user
// session, the way the helper's --context flag defaults.
func normalizedDesktopContext(desktopContext string) string {
	if desktopContext == ipc.DesktopContextLoginWindow {
		return ipc.DesktopContextLoginWindow
	}
	return ipc.DesktopContextUserSession
}

// tccRestartStore persists the self-restart history across restarts.
type tccRestartStore interface {
	Load() (tccRestartHistory, error)
	Save(tccRestartHistory) error
}

// tccStateFileIn is name's path in the per-user state dir under homeDir
// (~/Library/Application Support/Breeze), creating the dir 0700 if needed.
// There is no fallback: the caller decides what an error means.
func tccStateFileIn(homeDir, name string) (string, error) {
	if homeDir == "" {
		return "", errors.New("no home directory")
	}
	dir := filepath.Join(homeDir, "Library", "Application Support", "Breeze")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return filepath.Join(dir, name), nil
}

// primaryDirTCCRestartStore is the record in the per-user state dir only,
// with the path resolved on every use. When the dir cannot be resolved both
// Load and Save fail, which the gate treats as "do not restart" and the
// quiet period as "an ordinary start": an unavailable dir never resets the
// limits.
type primaryDirTCCRestartStore struct {
	resolve func() (string, error)
}

func (s primaryDirTCCRestartStore) file() (fileTCCRestartStore, error) {
	path, err := s.resolve()
	if err != nil {
		return fileTCCRestartStore{}, fmt.Errorf("TCC self-restart state dir unavailable: %w", err)
	}
	return fileTCCRestartStore{path: path}, nil
}

func (s primaryDirTCCRestartStore) Load() (tccRestartHistory, error) {
	f, err := s.file()
	if err != nil {
		return tccRestartHistory{}, err
	}
	return f.Load()
}

func (s primaryDirTCCRestartStore) Save(h tccRestartHistory) error {
	f, err := s.file()
	if err != nil {
		return err
	}
	return f.Save(h)
}

// fileTCCRestartStore keeps the history as JSON in one 0600 file. A missing
// file is an empty history; anything else unreadable is an error, which the
// decision treats as "do not restart".
type fileTCCRestartStore struct{ path string }

func (s fileTCCRestartStore) Load() (tccRestartHistory, error) {
	var h tccRestartHistory
	data, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return h, nil
	}
	if err != nil {
		return h, err
	}
	if err := json.Unmarshal(data, &h); err != nil {
		return tccRestartHistory{}, fmt.Errorf("%w: %s: %v", errTCCRestartHistoryCorrupt, s.path, err)
	}
	return h, nil
}

// Save writes atomically (temp file + rename), so a crash mid-write cannot
// leave a record that reads as "no restarts yet".
func (s fileTCCRestartStore) Save(h tccRestartHistory) error {
	data, err := json.Marshal(h)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), "."+filepath.Base(s.path)+"-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer func() { _ = os.Remove(name) }() // no-op after a successful rename
	err = tmp.Chmod(0o600)
	if err == nil {
		_, err = tmp.Write(data)
	}
	if err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(name, s.path)
}

// tccRestartGate is the TCC loop's side of the self-restart: it counts
// consecutive unexplained checks, applies decideTCCSelfRestart, records the
// restart, and asks for it. One gate lives for one loop (one connection).
type tccRestartGate struct {
	now     func() time.Time
	store   tccRestartStore
	guard   selfRestartGuard // nil: nothing to wait for
	restart func()

	fingerprint   string
	confirmations int
	lastReason    string
	requested     bool
}

// observe feeds one check's diagnosis (nil when nothing was denied) to the
// gate and reports whether it asked for a restart.
func (g *tccRestartGate) observe(d *tccdiag.Diagnosis) bool {
	if g.requested {
		return false
	}
	if d == nil || d.Verdict != tccdiag.VerdictUnexplained {
		g.fingerprint, g.confirmations, g.lastReason = "", 0, ""
		return false
	}
	fp := tccGrantFingerprint(d)
	if fp != g.fingerprint {
		g.fingerprint, g.confirmations = fp, 0
	}
	g.confirmations++

	s := tccRestartState{
		Verdict:       d.Verdict,
		Fingerprint:   fp,
		Confirmations: g.confirmations,
		Now:           g.now(),
	}
	s.Busy = g.busyNow()
	// Read the history only once it can matter.
	if s.Confirmations >= tccSelfRestartConfirmations && s.Busy == "" {
		s.History, s.HistoryErr = g.store.Load()
		if errors.Is(s.HistoryErr, errTCCRestartHistoryCorrupt) {
			g.resetCorruptHistory(s)
		}
	}

	restart, reason := decideTCCSelfRestart(s)
	if !restart {
		g.logHold(reason, s)
		return false
	}

	// Record first: the record is what keeps the respawned helper from
	// doing this again, so a restart that cannot be recorded is skipped.
	next := s.History.withRestart(s.Now, fp)
	if err := g.store.Save(next); err != nil {
		g.logHold(tccRestartReasonRecordUnwritable, s, "error", err.Error())
		return false
	}

	// Stop taking new messages, then look once more: work that arrived
	// while the record was written (a session start, a consent request)
	// still wins, and the attempt is given back and retried later. With
	// intake held nothing new can start between this check and the exit.
	if busy := g.holdNow(); busy != "" {
		if err := g.store.Save(s.History); err != nil {
			log.Warn("could not roll back the TCC self-restart record; this grant state will not be retried",
				"grantFingerprint", fp, "error", err.Error())
		}
		s.Busy = busy
		g.logHold(tccRestartReasonBusy, s)
		return false
	}

	g.requested = true
	log.Info("TCC grant is in the database but this helper still reads denied; restarting the helper so macOS re-reads it",
		"tccVerdict", string(d.Verdict), "grantFingerprint", fp, "restartsInWindow", len(next.Restarts),
		"restartedStates", len(next.RestartedStates))
	g.restart()
	return true
}

func (g *tccRestartGate) busyNow() string {
	if g.guard == nil {
		return ""
	}
	return g.guard.selfRestartBusy()
}

func (g *tccRestartGate) holdNow() string {
	if g.guard == nil {
		return ""
	}
	return g.guard.holdForSelfRestart()
}

// selfRestartGuard is the helper's side of the self-restart: what is in
// progress, and the hold on new work just before exiting. *Client
// implements it.
type selfRestartGuard interface {
	// selfRestartBusy names what a restart would interrupt now ("" when
	// nothing).
	selfRestartBusy() string
	// holdForSelfRestart stops the helper taking new messages, then reports
	// what is still in progress. On "" the hold stays in place (the process
	// is about to exit; it lifts after selfRestartIntakeHoldLimit if not);
	// otherwise it has already been lifted.
	holdForSelfRestart() string
}

// resetCorruptHistory replaces a record that does not parse with one stamped
// now. Keeping it would disable the self-restart for good; dropping it would
// forget restarts that did happen. The fresh stamp keeps the min gap and the
// budget counting from here. The decision still refuses this time.
func (g *tccRestartGate) resetCorruptHistory(s tccRestartState) {
	fresh := tccRestartHistory{Restarts: []tccRestartRecord{{At: s.Now.UTC(), Fingerprint: tccRestartHistoryResetFingerprint}}}
	if err := g.store.Save(fresh); err != nil {
		log.Warn("TCC self-restart record is corrupt and could not be replaced", "error", s.HistoryErr.Error(), "saveError", err.Error())
		return
	}
	log.Warn("TCC self-restart record was corrupt; replaced it with a fresh one", "error", s.HistoryErr.Error())
}

// recheckIn reports how soon the loop should check again for the gate's
// sake: tccFastCheckInterval while an unexplained verdict awaits its
// confirming check, tccSelfRestartBusyRecheck while a session or dialog holds
// it. ok is false when the gate needs nothing sooner than usual.
func (g *tccRestartGate) recheckIn() (time.Duration, bool) {
	if g.requested || g.confirmations == 0 {
		return 0, false
	}
	switch g.lastReason {
	case "", tccRestartReasonUnconfirmed:
		return tccFastCheckInterval, true
	case tccRestartReasonBusy:
		return tccSelfRestartBusyRecheck, true
	}
	return 0, false
}

// pending reports whether the gate wants an earlier check than usual.
func (g *tccRestartGate) pending() bool {
	_, ok := g.recheckIn()
	return ok
}

// logHold logs why the gate did not restart, once per reason, so the loop
// does not repeat the line. A store problem is a Warn: it is the one hold
// that needs someone to look.
func (g *tccRestartGate) logHold(reason string, s tccRestartState, extra ...any) {
	if reason == g.lastReason {
		return
	}
	g.lastReason = reason
	if reason == tccRestartReasonUnconfirmed {
		return // the normal first sighting; the denial diagnosis line already says it
	}
	attrs := append([]any{"reason", reason, "grantFingerprint", s.Fingerprint, "busy", s.Busy}, extra...)
	if s.HistoryErr != nil {
		attrs = append(attrs, "historyError", s.HistoryErr.Error())
	}
	const msg = "TCC grant is in the database but this helper still reads denied; not restarting the helper"
	if reason == tccRestartReasonHistoryUnreadable || reason == tccRestartReasonRecordUnwritable {
		log.Warn(msg, attrs...)
		return
	}
	log.Info(msg, attrs...)
}

// Process-wide self-restart signal. The TCC loop raises it; the desktop
// helper's main closes its shutdown channel on it and exits 0, and launchd
// starts a fresh copy.
var (
	selfRestartMu      sync.Mutex
	selfRestartCh      = make(chan struct{})
	selfRestartOnce    = new(sync.Once)
	selfRestartEnabled bool
)

// EnableSelfRestart opts this process in to the stale-TCC self-restart
// (#11292) and returns the channel closed when the TCC loop asks for one.
// Only a binary whose supervisor relaunches it after a clean exit may call
// it: breeze-desktop-helper, whose console-user LaunchAgent has an
// unconditional KeepAlive. The opt-in is per binary; selfRestartAllowedFor
// still limits the restart to the user-session context. In a process that
// never opts in, the TCC loop never records or requests a restart.
func EnableSelfRestart() <-chan struct{} {
	selfRestartMu.Lock()
	defer selfRestartMu.Unlock()
	selfRestartEnabled = true
	return selfRestartCh
}

func selfRestartIsEnabled() bool {
	selfRestartMu.Lock()
	defer selfRestartMu.Unlock()
	return selfRestartEnabled
}

func requestHelperSelfRestart() {
	selfRestartMu.Lock()
	ch, once := selfRestartCh, selfRestartOnce
	selfRestartMu.Unlock()
	once.Do(func() { close(ch) })
}

// resetSelfRestartSignalForTest gives a test a fresh, disabled signal and
// returns the function that restores the previous one.
func resetSelfRestartSignalForTest() func() {
	selfRestartMu.Lock()
	prevCh, prevOnce, prevEnabled := selfRestartCh, selfRestartOnce, selfRestartEnabled
	selfRestartCh, selfRestartOnce, selfRestartEnabled = make(chan struct{}), new(sync.Once), false
	selfRestartMu.Unlock()
	return func() {
		selfRestartMu.Lock()
		selfRestartCh, selfRestartOnce, selfRestartEnabled = prevCh, prevOnce, prevEnabled
		selfRestartMu.Unlock()
	}
}
