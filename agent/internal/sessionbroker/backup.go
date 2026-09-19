package sessionbroker

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/logging"
)

// backupHelperSpawnTimeout bounds how long spawnBackupHelper waits for a
// freshly started helper to connect back over IPC before killing it. Package
// var, not a const, so tests can shrink it; production leaves it at 15s.
var backupHelperSpawnTimeout = 15 * time.Second

// backupHelperStopGrace bounds how long StopBackupHelper waits for in-flight
// backup runs to drain before killing the helper anyway (D3). It is a
// package var, not a const, so tests can shrink it; production leaves it at
// its full 5s, comfortably inside the 20s whole-agent shutdown budget
// (agent/internal/agentapp/shutdown_budget.go).
var backupHelperStopGrace = 5 * time.Second

// backupHelperExitGrace bounds how long a helper whose IPC session dropped is
// given to finish exiting on its own before it is killed (see reapExiting).
// The helper closes its connection only after draining its log shipper, so in
// practice it has already exited; the grace exists for a hung helper. Package
// var so tests can shrink it.
var backupHelperExitGrace = 10 * time.Second

// backupHelperStopPollInterval is how often StopBackupHelper re-checks
// activeRuns while waiting out backupHelperStopGrace.
var backupHelperStopPollInterval = 100 * time.Millisecond

// Backup-role admission errors. The broker only ever grants the backup IPC
// scope to a process it spawned itself: an identity/root check alone is not
// enough, since an independently launched copy of the genuine,
// hash-allowlisted helper binary would also pass identity. Admission is
// bound to the exact kernel-verified peer PID captured when the agent's own
// spawnBackupHelper started the process (see backupSpawnReservation).
var (
	errBackupHelperNotReserved       = errors.New("backup helper was not spawned by the agent")
	errBackupHelperPeerMismatch      = errors.New("backup helper process does not match the agent reservation")
	errBackupHelperReservationUsed   = errors.New("backup helper process reservation was already used")
	errBackupHelperReservationFailed = errors.New("backup helper process reservation failed")
	errBackupHelperAlreadyConnected  = errors.New("backup helper already connected")
)

// backupHelperDiedError is the terminal error reported for a backup run whose
// helper process disappeared mid-run (#2998). It is a fixed string so support
// and the server can separate "the helper died" from a genuinely stalled
// upload — the stale-backup reaper's "no progress reported for 15 minutes"
// (apps/api/src/jobs/staleCommandReaper.ts) is what a run used to get instead,
// 15 minutes late and describing the wrong failure.
const backupHelperDiedError = "backup helper exited unexpectedly"

// backupRunCommandType is the wire value of the backup command that runs a
// backup, duplicated here as a literal because internal/remote/tools (which
// declares CmdBackupRun) imports this package — taking the constant from there
// would be an import cycle. It must stay in step with tools.CmdBackupRun and
// with the helper's own literal in cmd/breeze-backup/main.go.
const backupRunCommandType = "backup_run"

// backupLog carries component=backup rather than component=sessionbroker so
// helper-death warnings land in the same shipped bucket as the rest of the
// backup subsystem (default log_shipping_level is warn).
var backupLog = logging.L("backup")

// backupHelperScopes defines allowed IPC scopes for the backup helper.
var backupHelperScopes = []string{"backup"}

// backupBinaryName returns the on-disk filename of the breeze-backup helper as
// installed alongside the agent. Unlike the Windows-only breeze-user-helper,
// the backup helper is built for every supported OS (see agent/Makefile), so
// the executable suffix must be applied conditionally: breeze-backup.exe on
// Windows, breeze-backup elsewhere. Taking goos as a parameter keeps this
// testable on every platform the agent builds on.
func backupBinaryName(goos string) string {
	if goos == "windows" {
		return "breeze-backup.exe"
	}
	return "breeze-backup"
}

// backupHelper tracks the backup helper process and session.
type backupHelper struct {
	mu      sync.Mutex
	session *Session
	process *os.Process
	// cmd is the exec.Cmd that started process, retained solely so the
	// helper can be reaped after a kill: os.Process alone exposes Wait, but
	// exec.Cmd.Wait additionally releases the Cmd's own resources. Nil for a
	// helper adopted from elsewhere (tests), in which case killAndReap falls
	// back to process.Wait.
	cmd *exec.Cmd
	// reapOnce makes the kill-and-reap of THIS child single-owner. Two kill
	// sites can legitimately reach the same process: spawnBackupHelper's
	// connect-timeout path holds its own cmd reference for the whole 15s
	// wait, during which an agent shutdown (StopBackupHelper) or a binary
	// swap (StopBackupHelperIfIdle) may kill and reap it and clear the
	// fields below. Without a shared once both paths would call Wait on the
	// same exec.Cmd concurrently, which is a data race inside os/exec, not
	// merely a redundant call. Created per spawned process; the spawning
	// goroutine keeps its own reference so it still reaps exactly once after
	// the fields have been cleared out from under it.
	reapOnce   *sync.Once
	binaryPath string

	// spawnDone is non-nil exactly while a spawn attempt for this helper is
	// in flight. The goroutine performing the spawn creates it and stores it
	// here under mu, then closes it under mu (after recording the outcome in
	// spawnErr) once the attempt returns, success or failure. A concurrent
	// caller that finds spawnDone already non-nil waits on it instead of
	// failing outright: a profile with `file` + `system_image` selections
	// dispatches one backup_run command per selection within milliseconds of
	// each other, and only one helper process must ever be spawned for that
	// burst. spawnErr is only meaningful once spawnDone is closed.
	spawnDone chan struct{}
	spawnErr  error

	// reservation binds backup-role admission to the exact process spawned by
	// the in-flight (or just-finished but not yet superseded) spawn attempt.
	// It is created alongside spawnDone and cleared in the same defer that
	// clears spawnDone/spawnErr, so reservation != nil implies a spawn
	// attempt owns this helper right now. See backupSpawnReservation and
	// claimBackupHelperAdmission.
	reservation *backupSpawnReservation

	// activeRuns holds every async backup_run this helper is executing, keyed
	// by command id. It is the gate on synthesizing a failure when the helper
	// dies (#2998), and it is a MAP rather than a single slot because
	// concurrent runs on one device are a normal shape, not a corner case: a
	// profile fan-out dispatches one job per selection and both `file` and
	// `system_image` resolve to commandType backup_run
	// (apps/api/src/jobs/backupWorker.ts), the agent dispatches commands from a
	// worker pool, and the helper runs each in its own goroutine
	// (cmd/breeze-backup/main.go). A single slot would let the second run
	// overwrite the first and leave the first stranded for the 15-minute
	// reaper — the very bug #2998 fixes.
	//
	// Only the async flow is tracked. On the legacy synchronous path the
	// forwarder is still blocked in Session.SendCommand, which errors out when
	// the session closes and reports the failure itself — tracking it here too
	// would double-report the same command.
	activeRuns map[string]backupRunState
}

// backupSpawnReservation binds backup-role admission to the exact process the
// agent started. Peer PID comes from the kernel-owned pipe/socket credentials,
// not from the helper's authentication payload. ready closes after cmd.Start
// publishes that PID, preventing a fast child from losing a startup race.
type backupSpawnReservation struct {
	ready     chan struct{}
	pid       uint32
	startErr  error
	claimed   bool
	committed bool
	published bool
}

// backupRunState distinguishes a run whose forwarder is still blocked waiting
// for the helper's ack from one the helper has confirmed it is executing.
//
// The distinction is what makes helper-death reporting exactly-once. A run
// still awaiting its ack must NOT be reported by the death path, because its
// forwarder is about to return an error (Session.SendCommand fails when the
// session closes) and the heartbeat reports that failure itself. Only a
// confirmed-running command has nobody else left to report it.
type backupRunState int

const (
	// backupRunPendingAck: recorded before the request was sent, ack not yet seen.
	backupRunPendingAck backupRunState = iota
	// backupRunExecuting: the helper acked; the terminal result is still owed.
	backupRunExecuting
	// backupRunDoomed: the helper died while this run was still pending-ack.
	// The death path leaves this tombstone instead of reporting, because the
	// forwarder is the one that must fail the command; the forwarder consumes
	// the tombstone when it resumes.
	//
	// The doom signal has to be per-command, not per-session: "my entry is
	// gone" is ambiguous on its own — it also happens when the genuine
	// terminal result was delivered and the helper then exited normally, and
	// failing the command in THAT case would contradict a success the server
	// already recorded.
	backupRunDoomed
)

// GetOrSpawnBackupHelper returns the existing backup helper session or spawns a new one.
func (b *Broker) GetOrSpawnBackupHelper(binaryPath string) (*Session, error) {
	b.mu.RLock()
	bh := b.backup
	b.mu.RUnlock()

	if bh != nil {
		bh.mu.Lock()
		s := bh.session
		bh.mu.Unlock()
		if s != nil {
			return s, nil
		}
	}

	return b.spawnBackupHelper(binaryPath)
}

func (b *Broker) spawnBackupHelper(binaryPath string) (session *Session, err error) {
	b.mu.Lock()
	if b.backup == nil {
		b.backup = &backupHelper{binaryPath: binaryPath}
	}
	bh := b.backup
	b.mu.Unlock()

	bh.mu.Lock()
	if bh.session != nil {
		s := bh.session
		bh.mu.Unlock()
		return s, nil
	}
	if bh.spawnDone != nil {
		// A spawn for this helper is already in flight -- most commonly two
		// backup_run commands (one per profile selection) dispatched within
		// milliseconds of each other. Wait for that spawn to finish instead
		// of failing this caller outright; only one process is ever spawned
		// for the burst (see spawnDone doc comment on backupHelper).
		done := bh.spawnDone
		bh.mu.Unlock()
		return waitForBackupHelperSpawn(bh, done)
	}
	if bh.process != nil {
		// A predecessor child is still referenced but no session owns it:
		// it exited on its own (crash, panic, OOM-kill) or is alive but
		// disconnected. Publishing the new child below overwrites
		// process/cmd/reapOnce, after which nothing could ever reap the old
		// one, so kill it if it is still alive and reap it now (#5980).
		// killAndReapLocked does not block on the exit, and its reapOnce is
		// shared with any other site holding the same child.
		log.Warn("reaping stale backup helper before respawn", "pid", bh.process.Pid)
		bh.killAndReapLocked()
	}
	done := make(chan struct{})
	bh.spawnDone = done
	reservation := &backupSpawnReservation{ready: make(chan struct{})}
	bh.reservation = reservation
	bh.mu.Unlock()

	// Record this attempt's outcome (session, err -- the named returns) into
	// bh.spawnErr and signal every waiter by closing done, all under bh.mu so
	// a waiter that has just acquired bh.mu in waitForBackupHelperSpawn never
	// observes spawnErr before it is final. The admission reservation is
	// retired in the same critical section: if the process never reached the
	// point of publishing its PID (see below), publish the failure now so a
	// racing claimBackupHelperAdmission call unblocks immediately instead of
	// waiting out the full spawn timeout.
	defer func() {
		bh.mu.Lock()
		bh.spawnErr = err
		bh.spawnDone = nil
		close(done)
		if bh.reservation == reservation {
			if !reservation.published {
				reservation.startErr = err
				reservation.published = true
				close(reservation.ready)
			}
			bh.reservation = nil
		}
		bh.mu.Unlock()
	}()

	// Resolve binary path
	path := binaryPath
	if path == "" {
		self, resolveErr := os.Executable()
		if resolveErr != nil {
			return nil, fmt.Errorf("failed to find self path: %w", resolveErr)
		}
		dir := filepath.Dir(self)
		path = filepath.Join(dir, backupBinaryName(runtime.GOOS))
	}

	if _, statErr := os.Stat(path); statErr != nil {
		return nil, fmt.Errorf("backup binary not found at %s: %w", path, statErr)
	}

	log.Info("spawning backup helper", "path", path, "socket", b.socketPath)
	cmd := exec.Command(path, "--socket", b.socketPath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if startErr := cmd.Start(); startErr != nil {
		return nil, fmt.Errorf("failed to spawn backup helper: %w", startErr)
	}

	bh.mu.Lock()
	bh.process = cmd.Process
	bh.cmd = cmd
	reapOnce := &sync.Once{}
	bh.reapOnce = reapOnce
	reservation.pid = uint32(cmd.Process.Pid)
	reservation.published = true
	close(reservation.ready)
	bh.mu.Unlock()

	// Wait for the helper to connect via IPC
	deadline := time.Now().Add(backupHelperSpawnTimeout)
	for time.Now().Before(deadline) {
		bh.mu.Lock()
		s := bh.session
		bh.mu.Unlock()
		if s != nil {
			log.Info("backup helper connected", "pid", cmd.Process.Pid)
			return s, nil
		}
		time.Sleep(200 * time.Millisecond)
	}

	log.Warn("backup helper did not connect, killing it", "pid", cmd.Process.Pid, "timeout", backupHelperSpawnTimeout)
	bh.mu.Lock()
	if bh.process != cmd.Process {
		// A Stop path already cleared (and very likely already reaped) this
		// child while we were waiting. reapOnce is the one shared with that
		// path, so this call is a no-op rather than a second concurrent
		// Wait on the same exec.Cmd.
		bh.mu.Unlock()
		killAndReap(reapOnce, cmd, cmd.Process)
		return nil, fmt.Errorf("backup helper failed to connect within %v", backupHelperSpawnTimeout)
	}
	bh.killAndReapLocked()
	bh.mu.Unlock()
	return nil, fmt.Errorf("backup helper failed to connect within %v", backupHelperSpawnTimeout)
}

// waitForBackupHelperSpawn blocks until the in-flight spawn represented by
// done completes, bounded by backupHelperSpawnTimeout, then reports that
// spawn's outcome: the session it produced, or an error describing why it
// didn't. It must not hold bh.mu (or any mutex) while selecting on done --
// the spawning goroutine needs bh.mu to record its own outcome and close
// done.
func waitForBackupHelperSpawn(bh *backupHelper, done chan struct{}) (*Session, error) {
	select {
	case <-done:
		bh.mu.Lock()
		s := bh.session
		spawnErr := bh.spawnErr
		bh.mu.Unlock()
		if s != nil {
			return s, nil
		}
		if spawnErr != nil {
			return nil, fmt.Errorf("concurrent backup helper spawn failed: %w", spawnErr)
		}
		return nil, fmt.Errorf("concurrent backup helper spawn failed")
	case <-time.After(backupHelperSpawnTimeout):
		return nil, fmt.Errorf("timed out waiting for concurrent backup helper spawn")
	}
}

// claimBackupHelperAdmission consumes the single-use reservation for the exact
// kernel-verified peer PID. An independently launched copy of the genuine,
// hash-allowlisted helper has a different PID and cannot claim backup scope.
//
// reservation != nil is only meaningful while a spawn attempt for this helper
// is in flight (bh.spawnDone != nil) -- both are cleared together in
// spawnBackupHelper's defer -- so the two are checked together throughout.
func (b *Broker) claimBackupHelperAdmission(pid uint32) (*backupSpawnReservation, error) {
	b.mu.RLock()
	bh := b.backup
	b.mu.RUnlock()
	if bh == nil {
		return nil, errBackupHelperNotReserved
	}

	bh.mu.Lock()
	reservation := bh.reservation
	if reservation == nil || bh.spawnDone == nil {
		bh.mu.Unlock()
		return nil, errBackupHelperNotReserved
	}
	ready := reservation.ready
	bh.mu.Unlock()

	select {
	case <-ready:
	case <-time.After(backupHelperSpawnTimeout):
		return nil, errBackupHelperReservationFailed
	}

	bh.mu.Lock()
	defer bh.mu.Unlock()
	if bh.reservation != reservation || bh.spawnDone == nil {
		return nil, errBackupHelperNotReserved
	}
	if reservation.startErr != nil || reservation.pid == 0 || bh.process == nil {
		return nil, errBackupHelperReservationFailed
	}
	if reservation.pid != pid || uint32(bh.process.Pid) != pid {
		return nil, errBackupHelperPeerMismatch
	}
	if reservation.claimed {
		return nil, errBackupHelperReservationUsed
	}
	reservation.claimed = true
	return reservation, nil
}

// SetBackupSession is called by the broker's connection handler when a backup helper authenticates.
func (b *Broker) SetBackupSession(s *Session) {
	b.mu.Lock()
	if b.backup == nil {
		b.backup = &backupHelper{}
	}
	bh := b.backup
	b.mu.Unlock()

	bh.mu.Lock()
	bh.session = s
	bh.mu.Unlock()
}

// ClearBackupSession removes the backup session (called on disconnect), but
// only when session still owns the singleton -- reporting whether it did so.
// A delayed disconnect from a superseded helper must not clear a newer
// owner's session out from under it.
//
// When it does clear, it also reaps the helper process that session belonged
// to (see reapExiting: wait first, and kill only a helper still running after
// backupHelperExitGrace). A backup helper's connection drops when the helper
// exits -- on its own (idle timeout, crash, panic, OOM-kill) or after one of
// the agent's own kill sites -- and nothing else ever waits on a self-exited
// child, so without this it stays a zombie (#5980). The process is only touched when the
// session's kernel-verified peer PID matches the tracked child; admission
// binds the two (claimBackupHelperAdmission), so a mismatch means the
// process is not this session's and is left for the respawn-time reap.
func (b *Broker) ClearBackupSession(session *Session) bool {
	b.mu.RLock()
	bh := b.backup
	b.mu.RUnlock()
	if bh == nil {
		return false
	}

	bh.mu.Lock()
	defer bh.mu.Unlock()
	if bh.session != session {
		return false
	}
	bh.session = nil
	if bh.process != nil && session != nil && session.PID > 0 && bh.process.Pid == session.PID {
		log.Info("reaping disconnected backup helper", "pid", bh.process.Pid, "sessionId", session.SessionID)
		bh.reapDisconnectedLocked()
	} else if bh.process != nil && session != nil {
		// Admission binds the owning session to the tracked child, so this
		// should not happen. The process is left for the respawn-time or
		// shutdown reap; log it so an unreaped helper is traceable.
		log.Warn("backup helper session pid does not match tracked process, deferring reap",
			"trackedPid", bh.process.Pid, "sessionPid", session.PID, "sessionId", session.SessionID)
	}
	return true
}

// StopBackupHelper kills the backup helper process. It is the SCM/graceful-
// stop path (agent shutdown), distinct from StopBackupHelperIfIdle (binary
// swap, which defers instead of killing).
//
// If a backup run is still in flight it waits up to backupHelperStopGrace
// for activeRuns to drain -- most runs finish and report their own terminal
// result (noteBackupRunResult) well inside that window -- then kills the
// process anyway so agent shutdown still completes inside its own budget
// (agent/internal/agentapp/shutdown_budget.go). Before this, StopBackupHelper
// killed unconditionally: on a real Windows Server 2022 host mid-10k-file
// backup, that silently failed the job at 9,751/10,046 files with nothing
// warning that runs were still active (D3). A run still active when the
// grace expires is logged at WARN with its count.
func (b *Broker) StopBackupHelper() {
	b.mu.Lock()
	bh := b.backup
	b.mu.Unlock()
	if bh == nil {
		return
	}

	deadline := time.Now().Add(backupHelperStopGrace)
	for {
		bh.mu.Lock()
		active := len(bh.activeRuns)
		if active == 0 || !time.Now().Before(deadline) {
			if active > 0 {
				log.Warn("stopping backup helper with runs in flight", "count", active)
			}
			if bh.process != nil {
				log.Info("stopping backup helper", "pid", bh.process.Pid)
				bh.killAndReapLocked()
			}
			bh.session = nil
			bh.mu.Unlock()
			return
		}
		bh.mu.Unlock()
		time.Sleep(backupHelperStopPollInterval)
	}
}

// killAndReapLocked kills the resident backup helper process and reaps it,
// then clears the process/cmd/reapOnce fields. The caller must hold bh.mu.
func (bh *backupHelper) killAndReapLocked() {
	proc, cmd, once := bh.takeProcessLocked()
	killAndReap(once, cmd, proc)
}

// reapDisconnectedLocked reaps the resident backup helper process after its
// session disconnected, then clears the process/cmd/reapOnce fields. Unlike
// killAndReapLocked it waits before killing (see reapExiting). The caller
// must hold bh.mu.
func (bh *backupHelper) reapDisconnectedLocked() {
	proc, cmd, once := bh.takeProcessLocked()
	reapExiting(once, cmd, proc, backupHelperExitGrace)
}

// takeProcessLocked detaches the resident helper process from bh, returning
// what a reap needs. The caller must hold bh.mu.
func (bh *backupHelper) takeProcessLocked() (*os.Process, *exec.Cmd, *sync.Once) {
	proc, cmd, once := bh.process, bh.cmd, bh.reapOnce
	bh.process = nil
	bh.cmd = nil
	bh.reapOnce = nil
	if once == nil {
		// Helper adopted without going through spawnBackupHelper (tests):
		// nothing else can hold a reference to it, so a fresh once is
		// equivalent to the spawned case.
		once = &sync.Once{}
	}
	return proc, cmd, once
}

// killAndReap kills a backup helper child and waits on it in the background
// so the OS releases its process-table entry. Without the wait the killed
// child stays a zombie for the whole lifetime of the (long-running) agent on
// POSIX, and repeated spawn-timeout / binary-swap / shutdown cycles leak
// PID-table entries (#5420).
//
// once makes this single-owner: whichever kill site gets there first kills
// and reaps, and any other site holding the same child is a no-op (see
// backupHelper.reapOnce -- a second concurrent exec.Cmd.Wait is a data race,
// not just a redundant call). The wait itself runs in its own goroutine
// because Kill is asynchronous and callers hold bh.mu (StopBackupHelperIfIdle
// holds it for its whole body), so they must not block on the child's exit.
func killAndReap(once *sync.Once, cmd *exec.Cmd, proc *os.Process) {
	if once == nil || proc == nil {
		return
	}
	once.Do(func() {
		// A kill that fails for any reason other than "already exited" means
		// the helper may still be running and holding the backup IPC socket:
		// the wait below then blocks until it eventually exits, so this log
		// line is the only signal an operator gets.
		if err := proc.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
			log.Warn("failed to kill backup helper", "pid", proc.Pid, "error", err.Error())
		}
		go func() {
			reportReap(cmd, proc, waitBackupHelper(cmd, proc))
		}()
	})
}

// reapExiting reaps a backup helper whose IPC session has already dropped. A
// disconnect almost always means the helper is exiting on its own -- its
// 30-minute idle timeout (cmd/breeze-backup/main.go commandLoop) or a crash
// -- so it waits first rather than killing: a kill would race the helper's
// own shutdown, and on Windows TerminateProcess on an already-exited child
// fails, which would log a spurious "failed to kill" warning on every idle
// cycle. Only a helper still running after grace (disconnected but hung) is
// killed; nothing else will ever do so once its fields have been cleared.
//
// once is shared with every other kill site for the same child, exactly as
// in killAndReap. Nothing here blocks the caller, which holds bh.mu.
func reapExiting(once *sync.Once, cmd *exec.Cmd, proc *os.Process, grace time.Duration) {
	if once == nil || proc == nil {
		return
	}
	once.Do(func() {
		go func() {
			waited := make(chan error, 1)
			go func() { waited <- waitBackupHelper(cmd, proc) }()
			var err error
			select {
			case err = <-waited:
			case <-time.After(grace):
				log.Warn("disconnected backup helper still running, killing it", "pid", proc.Pid, "grace", grace)
				// Killing while Wait is in flight is the pattern
				// exec.CommandContext itself uses; os.Process makes it safe.
				if killErr := proc.Kill(); killErr != nil && !errors.Is(killErr, os.ErrProcessDone) {
					log.Warn("failed to kill backup helper", "pid", proc.Pid, "error", killErr.Error())
				}
				err = <-waited
			}
			reportReap(cmd, proc, err)
		}()
	})
}

// waitBackupHelper waits on a helper child so the OS releases its
// process-table entry, preferring exec.Cmd.Wait (which also releases the
// Cmd's own resources) when the Cmd is known.
func waitBackupHelper(cmd *exec.Cmd, proc *os.Process) error {
	if cmd != nil {
		return cmd.Wait()
	}
	_, err := proc.Wait()
	return err
}

// reportReap logs a failed reap and fires the test observation hook.
func reportReap(cmd *exec.Cmd, proc *os.Process, err error) {
	// A killed child always reports a non-zero exit (*exec.ExitError,
	// "signal: killed"), and a crashed one a non-zero status -- both are
	// expected. Anything else means the reap itself failed and the zombie
	// #5420 / #5980 are about may still be there, so it must not be
	// swallowed.
	var exitErr *exec.ExitError
	if err != nil && !errors.As(err, &exitErr) {
		log.Warn("failed to reap backup helper", "pid", proc.Pid, "error", err.Error())
	}
	if hook := backupHelperReapedHook.Load(); hook != nil {
		(*hook)(cmd, proc)
	}
}

// backupHelperReapedHook is a test-only observation point. It fires from the
// reaping goroutine once the killed helper has actually been waited on, which
// is what lets a test prove the child was reaped rather than left a zombie.
// Production never sets it.
var backupHelperReapedHook atomic.Pointer[func(*exec.Cmd, *os.Process)]

// ActiveBackupRunCount returns the number of backup_run commands the backup
// helper is currently tracking (see activeRuns on backupHelper) -- pending-
// ack, executing, and doomed entries all count, since the caller only needs
// "is something in flight for this helper right now". It is nil-safe: a
// broker that has never spawned a backup helper returns 0, so
// sendWatchdogStateSync (heartbeat) can call it unconditionally on every
// tick without a nil check of its own.
func (b *Broker) ActiveBackupRunCount() int {
	b.mu.RLock()
	bh := b.backup
	b.mu.RUnlock()
	if bh == nil {
		return 0
	}
	bh.mu.Lock()
	defer bh.mu.Unlock()
	return len(bh.activeRuns)
}

// StopBackupHelperIfIdle stops any resident backup helper process IF no
// backup run is currently in flight, reporting whether it did so (true) or
// deferred because a run is active (false). Used by the agent's backup-binary
// delivery paths (upgrade swap, reconcile) before replacing the on-disk
// breeze-backup binary: swapping the file out from under a job that's
// mid-upload would corrupt or kill it. The check-and-stop happens atomically
// under bh.mu, so a run cannot start in the gap between "no active runs" and
// "kill the process".
//
// A nil/never-spawned helper (nothing to stop) also returns true — there is
// nothing in the way of the swap.
func (b *Broker) StopBackupHelperIfIdle() bool {
	b.mu.Lock()
	bh := b.backup
	b.mu.Unlock()
	if bh == nil {
		return true
	}

	bh.mu.Lock()
	defer bh.mu.Unlock()
	if len(bh.activeRuns) > 0 {
		return false
	}
	if bh.process != nil {
		log.Info("stopping idle backup helper for binary swap", "pid", bh.process.Pid)
		bh.killAndReapLocked()
	}
	bh.session = nil
	return true
}

// ForwardBackupCommand sends a command to the backup helper and waits for the
// result. async, when true, tells the helper this is a backup_run request
// that should be acked immediately ({"started":true}) with the real result
// following later as an unsolicited backup_result envelope — callers must
// only set it when the connected server has advertised the backup_run_async
// capability (see websocket.Client.HasServerCapability), since an old server
// would otherwise parse the ack as a malformed terminal result.
func (b *Broker) ForwardBackupCommand(commandID, commandType string, payload []byte, timeout time.Duration, async bool, queueAsync ...bool) (*ipc.Envelope, error) {
	b.mu.RLock()
	bh := b.backup
	b.mu.RUnlock()

	var session *Session
	if bh != nil {
		bh.mu.Lock()
		session = bh.session
		bh.mu.Unlock()
	}

	if session == nil {
		return nil, fmt.Errorf("backup helper not connected")
	}

	req := backupipc.BackupCommandRequest{
		CommandID:   commandID,
		CommandType: commandType,
		Payload:     payload,
		TimeoutMs:   timeout.Milliseconds(),
		Async:       async,
		QueueAsync:  len(queueAsync) > 0 && queueAsync[0],
	}

	tracked := async && (commandType == backupRunCommandType || req.QueueAsync) && bh != nil
	if !tracked {
		if isCancelableBackupVerification(commandType) {
			return forwardCancelableBackupVerification(session, req, timeout)
		}
		return session.SendCommand(commandID, backupipc.TypeBackupCommand, req, timeout)
	}

	// Record BEFORE sending, not after. The helper's terminal result is
	// delivered by the RecvLoop goroutine and can land before this goroutine
	// resumes from SendCommand — recording afterwards would re-add a command
	// that already finished, and the next disconnect would then fail an
	// already-completed job (#2998 review). Recording first means every
	// dispatch of this command id is ordered after the entry exists.
	bh.mu.Lock()
	if bh.activeRuns == nil {
		bh.activeRuns = make(map[string]backupRunState)
	}
	bh.activeRuns[commandID] = backupRunPendingAck
	bh.mu.Unlock()

	env, err := session.SendCommand(commandID, backupipc.TypeBackupCommand, req, timeout)

	// Nothing started: drop the entry. The forwarder's own error/failed-ack
	// return is what reports this command's failure, so the death path must
	// not report it a second time.
	if err != nil || !ackStartedRun(env) {
		bh.mu.Lock()
		delete(bh.activeRuns, commandID)
		bh.mu.Unlock()
		return env, err
	}

	// The helper confirmed the run. What happened to the entry in the meantime
	// decides who owns this command's outcome:
	//
	//   - gone: the terminal result already arrived (a run that finished or
	//     failed in microseconds) and the server has been told. Re-adding the
	//     id would strand a false failure for the next disconnect, and
	//     returning an error here would contradict a result already recorded.
	//     Stay silent.
	//   - doomed: the helper died while this run was still pending-ack. The
	//     death path deliberately did not report it, so this call must fail it.
	//   - otherwise: promote to executing; the death path owns it from here.
	//
	// Those three answers are what make helper-death reporting exactly-once in
	// every interleaving of this goroutine and the RecvLoop goroutine.
	bh.mu.Lock()
	state, stillTracked := bh.activeRuns[commandID]
	switch {
	case !stillTracked:
		bh.mu.Unlock()
		return env, nil
	case state == backupRunDoomed:
		delete(bh.activeRuns, commandID)
		bh.mu.Unlock()
		return env, fmt.Errorf("%s", backupHelperDiedError)
	default:
		bh.activeRuns[commandID] = backupRunExecuting
		bh.mu.Unlock()
		return env, nil
	}
}

// isCancelableBackupVerification limits timeout-driven helper cancellation
// to the long-running verification commands from #5860. Other synchronous
// backup commands retain their existing forwarding behaviour.
func isCancelableBackupVerification(commandType string) bool {
	switch commandType {
	case "backup_verify", "backup_test_restore":
		return true
	default:
		return false
	}
}

// forwardCancelableBackupVerification keeps the original request registered
// after a timeout so its eventual reply is consumed as a correlated response,
// not forwarded to the server as an unsolicited second terminal result.
func forwardCancelableBackupVerification(session *Session, req backupipc.BackupCommandRequest, timeout time.Duration) (*ipc.Envelope, error) {
	env, _, err := session.sendCommandWithQuiescence(
		req.CommandID,
		backupipc.TypeBackupCommand,
		req,
		timeout,
	)
	if errors.Is(err, ErrCommandTimeout) {
		// Return the timeout to the command path immediately. Cancellation runs
		// independently so it cannot extend the server-visible command budget.
		go cancelTimedOutBackupVerification(session, req.CommandID)
	}
	return env, err
}

// cancelTimedOutBackupVerification asks the helper to cancel exactly the
// verification command that exceeded the agent-side budget. The helper's
// targeted backup_stop path waits for that command to unwind before replying.
func cancelTimedOutBackupVerification(session *Session, commandID string) {
	payload, err := json.Marshal(struct {
		JobID string `json:"jobId"`
	}{JobID: commandID})
	if err != nil {
		backupLog.Warn("failed to marshal timed-out backup cancellation",
			"commandId", commandID, "error", err.Error())
		return
	}

	stopID := fmt.Sprintf("%s-timeout-cancel-%d", commandID, time.Now().UnixNano())
	req := backupipc.BackupCommandRequest{
		CommandID:   stopID,
		CommandType: "backup_stop",
		Payload:     payload,
		TimeoutMs:   backupipc.BackupStopForwardTimeout.Milliseconds(),
	}

	env, err := session.SendCommand(
		stopID,
		backupipc.TypeBackupCommand,
		req,
		backupipc.BackupStopForwardTimeout,
	)
	if err != nil {
		backupLog.Warn("timed-out backup verification cancellation failed",
			"commandId", commandID, "error", err.Error())
		return
	}

	var result backupipc.BackupCommandResult
	if err := json.Unmarshal(env.Payload, &result); err != nil {
		backupLog.Warn("invalid timed-out backup cancellation result",
			"commandId", commandID, "error", err.Error())
		return
	}
	if !result.Success {
		backupLog.Warn("timed-out backup verification cancellation was rejected",
			"commandId", commandID, "error", result.Stderr)
		return
	}

	var state struct {
		Stopped bool `json:"stopped"`
		Drained bool `json:"drained"`
	}
	if err := json.Unmarshal([]byte(result.Stdout), &state); err != nil {
		backupLog.Warn("invalid timed-out backup cancellation state",
			"commandId", commandID, "error", err.Error())
		return
	}

	if state.Stopped && !state.Drained {
		backupLog.Warn("timed-out backup verification still unwinding after cancellation",
			"commandId", commandID)
	}
}

// ackStartedRun reports whether an async backup_run ack means the run is now
// executing in the helper. It mirrors what the heartbeat forwarder does with
// the same envelope (forwardToBackupHelper): an ack it cannot parse, or one
// carrying Success=false, becomes the command's failure result there.
func ackStartedRun(env *ipc.Envelope) bool {
	if env == nil {
		return false
	}
	var ack backupipc.BackupCommandResult
	if err := json.Unmarshal(env.Payload, &ack); err != nil {
		return false
	}
	if !ack.Success {
		return false
	}
	var admission struct {
		Started bool `json:"started"`
		Queued  bool `json:"queued"`
	}
	// Older helpers may ignore Async/QueueAsync and return the synchronous
	// terminal result here. Only explicit admission has an unsolicited finish.
	return json.Unmarshal([]byte(ack.Stdout), &admission) == nil && (admission.Started || admission.Queued)
}

// noteBackupRunResult clears the in-flight run once its terminal result has
// been forwarded to the server, so a subsequent helper disconnect stays a
// no-op instead of reporting a second, contradictory result (#2998).
//
// Only the unsolicited terminal result reaches this: the async ack is a reply
// to the request envelope and is consumed by Session.HandleResponse, never
// reaching dispatchHelperMessage.
func (b *Broker) noteBackupRunResult(env *ipc.Envelope) {
	b.mu.RLock()
	bh := b.backup
	b.mu.RUnlock()
	if bh == nil || env == nil {
		return
	}

	var result backupipc.BackupCommandResult
	if err := json.Unmarshal(env.Payload, &result); err != nil {
		// Unparseable here means unparseable in the heartbeat handler too, so
		// the server learns nothing from it — keep the run tracked so the
		// disconnect still reports a terminal failure.
		backupLog.Warn("unparseable terminal backup result, keeping run tracked",
			"error", err.Error())
		return
	}
	if result.CommandID == "" {
		return
	}

	bh.mu.Lock()
	delete(bh.activeRuns, result.CommandID)
	bh.mu.Unlock()
}

// reportBackupHelperDeath synthesizes a terminal backup_result when the backup
// helper disconnects with a run still in flight (#2998).
//
// Before this, the disconnect only cleared local state: the server never
// learned the run had ended, so the job sat "running" until the 15-minute
// stale-backup reaper failed it with "no progress reported for 15 minutes" —
// a misleading cause for a process that died in ~2 seconds.
//
// The synthetic result is pushed through the same onMessage sink a genuine
// unsolicited result uses, so it inherits the heartbeat's delivery path
// including the outbox that survives a WS gap.
func (b *Broker) reportBackupHelperDeath(session *Session) {
	if session == nil {
		return
	}

	// b.mu only protects the b.backup pointer itself; bh.session and
	// bh.activeRuns are protected by bh.mu (SetBackupSession,
	// ClearBackupSession, registerNonLifecycleSession, spawnBackupHelper all
	// write/read them under bh.mu). This value decides whether a customer's
	// run gets failed, and an unsynchronized read of it would be a genuine
	// data race, so fetch bh under b.mu, release b.mu, then do everything
	// else under bh.mu alone — the pointer in b.backup is never reset once
	// created, so releasing b.mu here is safe.
	b.mu.RLock()
	bh := b.backup
	b.mu.RUnlock()
	if bh == nil {
		return
	}
	bh.mu.Lock()
	// A different live session means the runs belong to the helper that
	// replaced this one; failing them here would kill backups that are still
	// executing. A nil current session is this session's own teardown (the
	// shutdown path clears it before the disconnect lands), and the runs are
	// dead either way, so that case still reports.
	//
	// The map is deliberately left untouched on the superseded branch. Any
	// residue from the superseded session is then attributed to the next
	// session's death — accepted, because reaching this branch at all requires
	// a replacement helper to register in the window between RecvLoop
	// returning and this report, and mis-attributing is strictly better than
	// failing the live helper's runs.
	superseded := bh.session != nil && bh.session != session
	var commandIDs []string
	stillTracked := len(bh.activeRuns)
	if !superseded {
		// Report only the runs the helper confirmed it was executing. A run
		// still awaiting its ack is the forwarder's to fail — it is either
		// blocked in SendCommand (which errors when the session closes) or
		// about to resume and find the tombstone left here. Reporting those
		// too would double-fail the command.
		for id, state := range bh.activeRuns {
			if state == backupRunExecuting {
				commandIDs = append(commandIDs, id)
				delete(bh.activeRuns, id)
				continue
			}
			bh.activeRuns[id] = backupRunDoomed
		}
	}
	bh.mu.Unlock()

	if superseded {
		if stillTracked > 0 {
			backupLog.Warn("backup helper session disconnected while another session owns the in-flight runs",
				"sessionId", session.SessionID, "runs", stillTracked)
		}
		return
	}
	if len(commandIDs) == 0 {
		return
	}
	// Deterministic order so a multi-run fan-out reports predictably.
	sort.Strings(commandIDs)

	if b.onMessage == nil {
		backupLog.Error("no message handler wired, cannot report backup helper death",
			"sessionId", session.SessionID, "commandIds", strings.Join(commandIDs, ","))
		return
	}

	for _, commandID := range commandIDs {
		backupLog.Warn("backup helper exited with a run in flight, failing the job",
			"sessionId", session.SessionID,
			"commandId", commandID,
			"error", backupHelperDiedError,
		)

		payload, err := json.Marshal(backupipc.BackupCommandResult{
			CommandID: commandID,
			Success:   false,
			Stderr:    backupHelperDiedError,
		})
		if err != nil {
			backupLog.Error("failed to encode backup helper death result",
				"commandId", commandID, "error", err.Error())
			continue
		}

		b.onMessage(session, &ipc.Envelope{
			ID:      commandID + "-helper-death",
			Type:    backupipc.TypeBackupResult,
			Payload: payload,
		})
	}
}
