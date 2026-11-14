package userhelper

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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
//   - Never while a remote desktop session runs or a consent or prompt
//     window is open.
//   - Persistently rate-limited in the per-user state dir, because the new
//     process forgets everything: one restart per grant state per
//     tccSelfRestartGrantWindow, at least tccSelfRestartMinGap apart, at most
//     tccSelfRestartMaxPerWindow in any window. A restart that cannot be
//     recorded does not happen.
//   - The respawned helper raises neither the Screen Recording consent
//     dialog nor the Accessibility prompt for tccSelfRestartQuietPeriod: the
//     database already holds the grant, and each helper start must not cost
//     the user a dialog (#4327, #4194).
const (
	tccSelfRestartConfirmations = 2
	tccSelfRestartGrantWindow   = 24 * time.Hour
	tccSelfRestartMinGap        = 30 * time.Minute
	tccSelfRestartMaxPerWindow  = 3
	tccSelfRestartQuietPeriod   = 15 * time.Minute
)

// tccSelfRestartRecordName is the record's file name in the helper's per-user
// state dir (~/Library/Application Support/Breeze).
const tccSelfRestartRecordName = "tcc-self-restart"

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
)

// tccRestartRecord is one self-restart.
type tccRestartRecord struct {
	At          time.Time `json:"at"`
	Fingerprint string    `json:"fingerprint"`
}

// tccRestartHistory is the persisted record of recent self-restarts.
type tccRestartHistory struct {
	Restarts []tccRestartRecord `json:"restarts"`
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
// starts a fresh copy, and why (see the package comment above for the rules).
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
		if r.Fingerprint == s.Fingerprint {
			return false, tccRestartReasonAlreadyRestarted
		}
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

// selfRestartedWithin reports whether the latest recorded self-restart is
// less than d before now.
func selfRestartedWithin(h tccRestartHistory, now time.Time, d time.Duration) bool {
	for _, r := range h.Restarts {
		if now.Sub(r.At) < d {
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
	if err != nil || !selfRestartedWithin(h, now, tccSelfRestartQuietPeriod) {
		return policy, false
	}
	policy.requestScreenRecording = false
	policy.promptAccessibility = false
	return policy, true
}

// selfRestartAllowedFor limits the self-restart to the console-user desktop
// helper: its LaunchAgent respawns it, and it is the process whose grant
// goes stale. The login-window helper runs as root under a different launchd
// job and TCC client, and the legacy user helper does not diagnose denials.
// The process must also have opted in (EnableSelfRestart).
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
		return tccRestartHistory{}, fmt.Errorf("parse %s: %w", s.path, err)
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
	busy    func() string
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
	if g.busy != nil {
		s.Busy = g.busy()
	}
	// Read the history only once it can matter.
	if s.Confirmations >= tccSelfRestartConfirmations && s.Busy == "" {
		s.History, s.HistoryErr = g.store.Load()
	}

	restart, reason := decideTCCSelfRestart(s)
	if !restart {
		g.logHold(reason, s)
		return false
	}

	// Record first: the record is what keeps the respawned helper from
	// doing this again, so a restart that cannot be recorded is skipped.
	next := tccRestartHistory{}
	for _, r := range s.History.Restarts {
		if s.Now.Sub(r.At) < tccSelfRestartGrantWindow {
			next.Restarts = append(next.Restarts, r)
		}
	}
	next.Restarts = append(next.Restarts, tccRestartRecord{At: s.Now.UTC(), Fingerprint: fp})
	if err := g.store.Save(next); err != nil {
		g.logHold("record_unwritable", s, "error", err.Error())
		return false
	}

	g.requested = true
	log.Info("TCC grant is in the database but this helper still reads denied; restarting the helper so macOS re-reads it",
		"tccVerdict", string(d.Verdict), "grantFingerprint", fp, "restartsInWindow", len(next.Restarts))
	g.restart()
	return true
}

// pending reports whether an unexplained verdict awaits confirmation or is
// held only by something transient, so the loop should re-check soon rather
// than on the slow interval.
func (g *tccRestartGate) pending() bool {
	return !g.requested && g.confirmations > 0 &&
		(g.lastReason == "" || g.lastReason == tccRestartReasonUnconfirmed || g.lastReason == tccRestartReasonBusy)
}

// logHold logs why the gate did not restart, once per reason, so the 2-minute
// loop does not repeat the line.
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
	log.Info("TCC grant is in the database but this helper still reads denied; not restarting the helper", attrs...)
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
// Only a process whose supervisor relaunches it after a clean exit may call
// it: the macOS desktop helper binary, run by a KeepAlive LaunchAgent. In any
// other process the TCC loop never records or requests a restart.
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
