package heartbeat

import (
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/updater"
	"github.com/breeze-rmm/agent/internal/watchdoginstall"
)

// Watchdog install retry (#7583 / #8619).
//
// The server already signals a never-installed watchdog through
// watchdogUpgradeTo (pin-aware). The legacy handler could only SWAP an
// existing watchdog binary and retried an install it could not complete every
// 30 minutes, forever, with in-memory state. ensureWatchdog is the correct,
// bounded path for a host whose watchdog is NOT REGISTERED: it downloads the
// server-supplied target through the authenticated, signature- and
// checksum-verified updater path into a private per-attempt directory, then
// executes that verified file's own `service install` (the single idempotent
// per-OS registration routine), with persisted, classified, bounded retries
// and an operator opt-out. A registered watchdog keeps the legacy swap path.

// watchdogInstallStartTimeout bounds how long a just-installed watchdog has to
// reach "running" before the attempt counts as failed.
const watchdogInstallStartTimeout = 30 * time.Second

// watchdogStageSweepAge: per-attempt dirs older than this are orphans of an
// attempt killed mid-download or mid-install.
const watchdogStageSweepAge = time.Hour

// WatchdogInstallReport is the bounded heartbeat field describing a watchdog
// that is not installed. Closed enums only — never error text or URLs. A
// healthy (registered) host omits the field entirely.
type WatchdogInstallReport struct {
	// State: retrying | gave_up | opted_out | unsupported | disabled_by_policy
	State string `json:"state"`
	// Attempts saturates at watchdoginstall.MaxRecordedAttempts.
	Attempts int `json:"attempts,omitempty"`
	// LastAttemptAt is RFC3339 UTC.
	LastAttemptAt string `json:"lastAttemptAt,omitempty"`
	// LastErrorClass is a watchdoginstall.ErrorClass value.
	LastErrorClass string `json:"lastErrorClass,omitempty"`
}

const (
	watchdogInstallRetrying         = "retrying"
	watchdogInstallGaveUp           = "gave_up"
	watchdogInstallOptedOut         = "opted_out"
	watchdogInstallUnsupported      = "unsupported"
	watchdogInstallDisabledByPolicy = "disabled_by_policy"
)

// watchdogEnsureState holds the Ensure seams and the report snapshot. nil on a
// Heartbeat means Ensure is not wired (tests of the legacy path, support
// sessions) and handleWatchdogUpgrade behaves exactly as before.
type watchdogEnsureState struct {
	store     watchdoginstall.Store
	plan      watchdoginstall.Plan
	stageRoot string

	detect    func() watchdoginstall.Status
	download  func(version, dir string) (string, error)
	verifySig func(path string) error
	register  func(path string) error
	// verifyStaged vets the staged file's folder ACL on Windows (nil = not
	// required on this OS). It must pass before register execs the file.
	verifyStaged func(path string) error
	waitRunning  func(timeout time.Duration) bool
	now          func() time.Time
	rnd          func() float64

	mu              sync.Mutex
	report          *WatchdogInstallReport
	corruptWarned   bool
	unknownWarned   bool
	optOutErrWarned bool
}

// optedOut reports the operator opt-out, failing closed. A marker that cannot
// be stat'ed reads as opted out (an ambiguous state must not trigger a
// privileged install), but the cause is logged once so an I/O or permission
// fault is not mistaken for operator intent.
func (e *watchdogEnsureState) optedOut() bool {
	optedOut, err := e.store.OptOutState()
	if err != nil {
		e.mu.Lock()
		warn := !e.optOutErrWarned
		e.optOutErrWarned = true
		e.mu.Unlock()
		if warn {
			log.Warn("watchdog opt-out marker could not be checked; treating the watchdog as opted out", "error", err.Error())
		}
	}
	return optedOut
}

// EnableWatchdogEnsure wires the production Ensure seams. Called once from the
// agent's start path; a support session (whose config is not the machine
// config) never installs the machine's watchdog.
func (h *Heartbeat) EnableWatchdogEnsure() {
	if config.ConfigDir() != config.MachineConfigDir() {
		return
	}
	h.watchdogEnsure = &watchdogEnsureState{
		store:        watchdoginstall.Store{Dir: config.MachineConfigDir()},
		plan:         watchdoginstall.DefaultPlan,
		stageRoot:    filepath.Join(config.GetDataDir(), watchdoginstall.StageRootName),
		detect:       func() watchdoginstall.Status { return watchdoginstall.Detect(os.Stat) },
		download:     h.downloadWatchdogBinaryTo,
		verifySig:    updater.VerifyStagedBinarySignature,
		register:     registerVerifiedWatchdog,
		verifyStaged: verifyStagedWatchdog,
		waitRunning:  waitWatchdogRunning,
		now:          time.Now,
		rnd:          rand.Float64,
	}
	h.seedWatchdogInstallReport()
}

// seedWatchdogInstallReport sets the in-memory report from what is already on
// disk, so the first heartbeat after a restart carries the persisted state.
// Without it the report is nil until the server next signals
// watchdogUpgradeTo; the API reads an absent field as healthy, clears the
// devices.watchdog_install_* columns, and the next beat restarts `since`
// (#8672).
//
// It follows the read-only checks of ensureWatchdog / ensureMissingWatchdog,
// in the same order, and never downloads, takes a lock, or writes or resets
// the state file. Deliberate differences from the first evaluation:
//   - A registered watchdog always seeds nothing, even with an open record and
//     the service not running: right after a reboot that races the watchdog's
//     own startup, and the API signals watchdogUpgradeTo only for an older or
//     empty installed version, so nothing later would clear the banner. The
//     first evaluation still handles an interrupted install. This also keeps
//     process exec off the startup path.
//   - A missing, corrupt or unreadable record seeds nothing; the first
//     evaluation persists the corrupt record's fail-closed form and reports it.
//   - The record is reported as persisted even when its budget belongs to an
//     older agent version, which the first evaluation will re-arm: it is the
//     last known outcome until a new attempt replaces it.
func (h *Heartbeat) seedWatchdogInstallReport() {
	e := h.watchdogEnsure
	if e == nil {
		return
	}
	rec, corrupt, err := e.store.Load()
	if err != nil {
		log.Warn("watchdog install state unavailable; not seeding the startup report", "error", err.Error())
	}
	open := err == nil && !corrupt && rec.Attempts > 0
	switch e.detect() {
	case watchdoginstall.StatusMissing:
	case watchdoginstall.StatusRegistered:
		return
	case watchdoginstall.StatusUnsupported:
		e.setReport(&WatchdogInstallReport{State: watchdogInstallUnsupported})
		return
	default: // unknown
		return
	}
	if isDevAgentVersion(h.agentVersion) {
		e.setReport(&WatchdogInstallReport{State: watchdogInstallGaveUp, LastErrorClass: string(watchdoginstall.ClassDevBuild)})
		return
	}
	if e.optedOut() {
		e.setReport(&WatchdogInstallReport{State: watchdogInstallOptedOut})
		return
	}
	if !h.autoUpdate() {
		e.setReport(&WatchdogInstallReport{State: watchdogInstallDisabledByPolicy})
		return
	}
	if open {
		e.setReportFromRecord(rec)
	}
}

// watchdogInstallReport returns a copy of the current report, or nil when there
// is nothing to report (not evaluated yet, or the watchdog is registered).
func (h *Heartbeat) watchdogInstallReport() *WatchdogInstallReport {
	e := h.watchdogEnsure
	if e == nil {
		return nil
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.report == nil {
		return nil
	}
	r := *e.report
	return &r
}

func (e *watchdogEnsureState) setReport(r *WatchdogInstallReport) {
	e.mu.Lock()
	e.report = r
	e.mu.Unlock()
}

func (e *watchdogEnsureState) setReportFromRecord(rec watchdoginstall.Record) {
	r := &WatchdogInstallReport{State: watchdogInstallRetrying, Attempts: rec.Attempts}
	if rec.Terminal {
		r.State = watchdogInstallGaveUp
	}
	if r.Attempts > watchdoginstall.MaxRecordedAttempts {
		r.Attempts = watchdoginstall.MaxRecordedAttempts
	}
	if !rec.LastAttemptAt.IsZero() {
		r.LastAttemptAt = rec.LastAttemptAt.UTC().Format(time.RFC3339)
	}
	if rec.LastClass.Valid() {
		r.LastErrorClass = string(rec.LastClass)
	}
	e.setReport(r)
}

// isDevAgentVersion mirrors agentapp.isDevBuildVersion: a local build with no
// published watchdog to fetch.
func isDevAgentVersion(v string) bool {
	return v == "" || v == "dev" || strings.HasPrefix(v, "dev-")
}

// watchdogEnsureEnrolled: an agent without an identity or token cannot make an
// authenticated download; it waits without burning budget.
func (h *Heartbeat) watchdogEnsureEnrolled() bool {
	h.mu.Lock()
	agentID := h.config.AgentID
	h.mu.Unlock()
	return agentID != "" && h.secureToken != nil && !h.secureToken.IsZeroed()
}

// ensureWatchdog handles a server-signalled watchdog target for a host whose
// watchdog may not be registered. It returns true when it handled the signal
// (installed, deferred, refused, opted out, ...) and handleWatchdogUpgrade
// must return; false only when the watchdog is registered and the legacy
// version-swap path owns the signal.
func (h *Heartbeat) ensureWatchdog(version string) bool {
	e := h.watchdogEnsure
	switch e.detect() {
	case watchdoginstall.StatusRegistered:
		if !h.watchdogInterruptedInstall(e) {
			e.setReport(nil)
			return false // registered: the legacy version-swap path owns it
		}
		// An earlier attempt of ours left the watchdog registered but not
		// running: complete it as Missing rather than erase the record.
	case watchdoginstall.StatusUnsupported:
		e.setReport(&WatchdogInstallReport{State: watchdogInstallUnsupported})
		return true
	case watchdoginstall.StatusUnknown:
		e.mu.Lock()
		warn := !e.unknownWarned
		e.unknownWarned = true
		e.mu.Unlock()
		if warn {
			log.Warn("could not determine whether the watchdog service is registered; not installing it")
		}
		return true
	}
	h.ensureMissingWatchdog(e, version)
	return true
}

// watchdogInterruptedInstall reports whether a REGISTERED watchdog is the
// leftover of an interrupted install of ours: our retry record is open and the
// service is not running (every installer writes the definition before it
// starts the service). Otherwise any record of ours is stale and is cleared —
// liveness of a watchdog we did not just install is the service manager's job.
func (h *Heartbeat) watchdogInterruptedInstall(e *watchdogEnsureState) bool {
	rec, corrupt, err := e.store.Load()
	if err != nil || (!corrupt && rec.Attempts == 0) {
		return false
	}
	if !corrupt && !e.waitRunning(0) {
		return true
	}
	if rerr := e.store.Reset(); rerr != nil {
		log.Warn("could not clear watchdog install retry state", "error", rerr.Error())
	}
	return false
}

// ensureMissingWatchdog runs one gated attempt to install a missing watchdog
// at the server-supplied target version.
func (h *Heartbeat) ensureMissingWatchdog(e *watchdogEnsureState, version string) {
	// Dev builds: terminal, zero network (a lab agent must never pull a
	// release watchdog next to a dev build).
	if isDevAgentVersion(h.agentVersion) {
		e.setReport(&WatchdogInstallReport{State: watchdogInstallGaveUp, LastErrorClass: string(watchdoginstall.ClassDevBuild)})
		return
	}
	if e.optedOut() {
		e.setReport(&WatchdogInstallReport{State: watchdogInstallOptedOut})
		return
	}
	if !h.autoUpdate() {
		e.setReport(&WatchdogInstallReport{State: watchdogInstallDisabledByPolicy})
		return
	}
	// SECURITY: same floor as the legacy swap path — never install a target
	// older than the running agent (replayed/compromised control plane).
	if decision := watchdogUpgradeDecision(version, h.agentVersion); !decision.Allowed {
		log.Error("SECURITY: refusing server-directed watchdog install",
			"agentVersion", h.agentVersion, "targetVersion", version, "reason", decision.Reason)
		return
	}
	if !h.watchdogEnsureEnrolled() {
		return
	}

	now := e.now()
	_, ok := e.loadDue(now, h.agentVersion, true)
	if !ok {
		return
	}

	// Exclusion, cheapest first: the shared in-process flag (legacy path +
	// concurrent heartbeats), the process-wide mutation lease (self-update,
	// helper updaters), then the cross-process file lock (an old agent still
	// alive during self-update, `service install --watchdog`). Any held ⇒
	// defer without counting an attempt.
	if !h.watchdogUpgradeInProgress.CompareAndSwap(false, true) {
		return
	}
	defer h.watchdogUpgradeInProgress.Store(false)
	lease, acquired := updater.TryBeginProcessMutation("watchdog-update")
	if !acquired {
		log.Debug("watchdog install deferred, another component mutation is active")
		return
	}
	defer lease.Release()
	lock, err := watchdoginstall.AcquireLock(e.store.Dir)
	if err != nil {
		if !errors.Is(err, watchdoginstall.ErrLockHeld) {
			log.Warn("watchdog install lock unavailable; deferring", "error", err.Error())
		}
		return
	}
	defer lock.Release()

	// Re-check under the locks (TOCTOU): another actor may have installed it,
	// or another process may have spent the attempt.
	if s := e.detect(); s != watchdoginstall.StatusMissing {
		if s == watchdoginstall.StatusRegistered && e.waitRunning(0) {
			if rerr := e.store.Reset(); rerr != nil {
				log.Warn("could not clear watchdog install retry state", "error", rerr.Error())
			}
			e.setReport(nil)
			return
		}
		if s != watchdoginstall.StatusRegistered {
			return
		}
	}
	// An operator may have run `service install --no-watchdog` since the first
	// check; honour it before reserving anything.
	if e.optedOut() {
		e.setReport(&WatchdogInstallReport{State: watchdogInstallOptedOut})
		return
	}
	now = e.now()
	rec, ok := e.loadDue(now, h.agentVersion, false)
	if !ok {
		return
	}

	// Reserve the attempt BEFORE any side effect, so a kill mid-download or
	// mid-install still spends it. A reservation that cannot be persisted
	// aborts: never do unbounded work we cannot account for.
	rec = e.plan.Reserve(rec, h.agentVersion, now)
	if err := e.store.Save(rec); err != nil {
		log.Error("could not persist watchdog install attempt; not attempting", "error", err.Error())
		return
	}
	e.setReportFromRecord(rec)

	log.Info("watchdog not registered; installing it", "targetVersion", version, "attempt", rec.Attempts)
	attemptErr := e.attempt(version)
	if attemptErr == nil {
		if err := e.store.Reset(); err != nil {
			log.Warn("could not clear watchdog install retry state", "error", err.Error())
		}
		e.setReport(nil)
		h.watchdogUpgradeMu.Lock()
		// The server-supplied target, never the agent's own version.
		h.watchdogInstalledVersion = version
		h.watchdogVersionRead = false
		h.watchdogUpgradeMu.Unlock()
		log.Info("watchdog installed and running", "targetVersion", version)
		return
	}

	class, permanent := watchdoginstall.Classify(attemptErr)
	rec = e.plan.Failed(rec, e.now(), class, e.rnd)
	if err := e.store.Save(rec); err != nil {
		log.Error("could not persist watchdog install failure", "error", err.Error())
	}
	e.setReportFromRecord(rec)
	// Never err.Error() for a download failure: *url.Error repeats the
	// request URL, capability query string included.
	key, value := updater.SafeDownloadErrorFields(attemptErr)
	log.Error("watchdog install attempt failed",
		"targetVersion", version, "errorClass", string(class), "permanent", permanent,
		"attempts", rec.Attempts, "terminal", rec.Terminal,
		"nextAttemptAt", rec.NextAttemptAt.UTC().Format(time.RFC3339), key, value)
}

// loadDue loads (and normalizes) the record and reports whether an attempt is
// due. A corrupt record is persisted in its fail-closed (deferred) form so a
// restart cannot escape the deferral.
func (e *watchdogEnsureState) loadDue(now time.Time, agentVersion string, report bool) (watchdoginstall.Record, bool) {
	rec, corrupt, err := e.store.Load()
	if err != nil {
		log.Error("watchdog install state unavailable; not attempting", "error", err.Error())
		return rec, false
	}
	changed := corrupt
	if corrupt {
		e.mu.Lock()
		warn := !e.corruptWarned
		e.corruptWarned = true
		e.mu.Unlock()
		if warn {
			log.Warn("watchdog install state was unreadable; deferring the next attempt by the slow cadence")
		}
	}
	var normalized bool
	rec, normalized = e.plan.Normalize(rec, now)
	if changed || normalized {
		if err := e.store.Save(rec); err != nil {
			log.Warn("could not persist watchdog install state", "error", err.Error())
		}
	}
	if !e.plan.Due(rec, agentVersion, now) {
		if report && (rec.Attempts > 0 || corrupt) {
			e.setReportFromRecord(rec)
		}
		return rec, false
	}
	return rec, true
}

// attempt downloads the verified watchdog into a fresh private directory and
// runs its own `service install`, then requires it to be registered AND
// running. Every failure is returned for classification.
func (e *watchdogEnsureState) attempt(version string) error {
	// Attempts are rare (bounded schedule), so sweep orphans before each one.
	if n := watchdoginstall.SweepStageDirs(e.stageRoot, watchdogStageSweepAge, e.now()); n > 0 {
		log.Info("removed stale watchdog install staging directories", "count", n)
	}
	dir, err := watchdoginstall.NewAttemptDir(e.stageRoot)
	if err != nil {
		return fmt.Errorf("%w: %v", watchdoginstall.ErrInstallCommand, err)
	}
	defer func() {
		if rerr := os.RemoveAll(dir); rerr != nil {
			log.Warn("could not remove watchdog install staging directory; the next attempt's sweep retries", "dir", dir, "error", rerr.Error())
		}
	}()

	downloaded, err := e.download(version, dir)
	if err != nil {
		return err
	}
	// Give the verified file the watchdog's own name (Windows will only
	// execute an .exe) and make it executable by root only.
	staged := filepath.Join(dir, watchdogExecutableName())
	if err := os.Rename(downloaded, staged); err != nil {
		return fmt.Errorf("%w: stage verified watchdog: %v", watchdoginstall.ErrInstallCommand, err)
	}
	if err := os.Chmod(staged, 0o700); err != nil {
		return fmt.Errorf("%w: chmod verified watchdog: %v", watchdoginstall.ErrInstallCommand, err)
	}
	// macOS: the same code-signature gate the updater applies before
	// installing a binary — DownloadBinary alone does not run it.
	if err := e.verifySig(staged); err != nil {
		return err
	}
	// Windows: the verified file now sits under the agent's data dir and is
	// about to run as LocalSystem. Refuse unless every folder up to it is
	// writable only by SYSTEM/Administrators, or a local user could swap the
	// file between the checksum and the exec.
	if e.verifyStaged != nil {
		if err := e.verifyStaged(staged); err != nil {
			return fmt.Errorf("%w: staging folder is not trusted: %v", watchdoginstall.ErrInstallCommand, err)
		}
	}
	if err := e.register(staged); err != nil {
		if errors.Is(err, watchdoginstall.ErrUnsupportedOS) {
			return err
		}
		return fmt.Errorf("%w: %v", watchdoginstall.ErrInstallCommand, err)
	}
	// Exit codes alone are not trusted: the definition must exist and the
	// service must actually be running.
	if e.detect() != watchdoginstall.StatusRegistered {
		return fmt.Errorf("%w: watchdog still not registered after install", watchdoginstall.ErrInstallCommand)
	}
	if !e.waitRunning(watchdogInstallStartTimeout) {
		return fmt.Errorf("%w: watchdog did not reach running within %s", watchdoginstall.ErrInstallCommand, watchdogInstallStartTimeout)
	}
	return nil
}

// pollWatchdogRunning polls probe once a second until it reports running or
// timeout elapses (timeout 0 = a single probe).
func pollWatchdogRunning(timeout time.Duration, probe func() bool) bool {
	deadline := time.Now().Add(timeout)
	for {
		if probe() {
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(time.Second)
	}
}

// downloadWatchdogBinaryTo is downloadWatchdogBinary with the artifact written
// into dir (a private per-attempt directory) instead of the OS temp dir.
func (h *Heartbeat) downloadWatchdogBinaryTo(targetVersion, dir string) (string, error) {
	return h.newWatchdogUpdater(dir).DownloadBinary(targetVersion)
}
