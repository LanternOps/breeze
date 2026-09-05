package executor

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/privilege"
	"github.com/breeze-rmm/agent/internal/procoutput"
)

var log = logging.L("executor")

const (
	// DefaultTimeout is the default execution timeout in seconds
	DefaultTimeout = 300 // 5 minutes

	// MaxTimeout is the maximum allowed execution timeout
	MaxTimeout = 3600 // 1 hour

	// MaxOutputSize is the maximum size of stdout/stderr to capture
	MaxOutputSize = 1024 * 1024 // 1MB

	// MaxGraceSeconds is the largest graceful-shutdown window a cancel request
	// may ask for (spec OD2-B). Every downstream deadline — notably the helper
	// IPC wait — must exceed it.
	MaxGraceSeconds = 30
)

// hardKillBackstop is how long Cancel keeps waiting past the requested grace
// before giving up and reporting kill_failed. It has to exceed cmd.WaitDelay
// (5s), which only starts once the cancel callback has already consumed the
// grace window. A var, not a const, purely so the give-up branch is testable
// without a ten-second test.
var hardKillBackstop = 10 * time.Second

// cancelRefusalTTL bounds how long a cancel for an execution we have never seen
// keeps its refusal on file. It has to outlast the longest a script command can
// sit in the worker-pool queue ahead of being dispatched — the pool floors at
// one worker and a script may run for MaxTimeout (1h) — while still guaranteeing
// the id is eventually forgotten, so a stale cancel cannot refuse an unrelated
// future command with the same id. A var only so the reap is testable.
var cancelRefusalTTL = 2 * time.Hour

// gradeCancelOutcome turns the observed post-termination state into the outcome
// the server grades on. Pulled out of Cancel so the fail-closed rule is
// asserted exhaustively on EVERY platform: the Unix path can prove it with a
// real process, but the Windows case it exists for — an RD Session Host denying
// the Job Object assignment — cannot be reproduced in a test at all.
func gradeCancelOutcome(started bool, killErr error, contained bool) CancelOutcome {
	if !started {
		// The process never made it past Start, so nothing is running.
		return CancelTerminated
	}
	if killErr != nil || !contained {
		// Containment was never established (e.g. an RDS session job denied the
		// Job Object assignment) or the kill itself failed: children may
		// survive. Never report `terminated`.
		return CancelKillFailed
	}
	return CancelTerminated
}

// CancelOutcome is what a cancel request actually achieved on the endpoint.
// The server turns this into `cancel_state`, and only CancelTerminated is
// allowed to terminalize an execution as `cancelled` (#3525 honesty contract).
type CancelOutcome string

const (
	// CancelTerminated means the process (and its tree) is provably gone.
	CancelTerminated CancelOutcome = "terminated"
	// CancelNotFound means this executor has no such execution. It is NOT
	// confirmation of a stop: the agent may have restarted, or the script may
	// have finished a moment ago with its result still in flight.
	CancelNotFound CancelOutcome = "not_found"
	// CancelKillFailed means we asked but cannot prove the tree is gone —
	// the kill errored, containment was never established, or termination was
	// not observed inside grace + hardKillBackstop.
	CancelKillFailed CancelOutcome = "kill_failed"
)

// clampGrace bounds a server-supplied graceSeconds to 0..MaxGraceSeconds.
func clampGrace(graceSeconds int) int {
	if graceSeconds < 0 {
		return 0
	}
	if graceSeconds > MaxGraceSeconds {
		return MaxGraceSeconds
	}
	return graceSeconds
}

// ScriptExecution represents a script to be executed
type ScriptExecution struct {
	ID         string            `json:"id"`
	ScriptID   string            `json:"scriptId"`
	ScriptType string            `json:"scriptType"`
	Script     string            `json:"script"`
	Parameters map[string]string `json:"parameters,omitempty"`
	Timeout    int               `json:"timeout"`
	RunAs      string            `json:"runAs,omitempty"`

	// #3409 PR4b — secret tenant variables, delivered as process environment
	// rather than substituted into the script text. `json:"-"` because this
	// struct must never carry a credential onto any wire or into any file;
	// SecretEnv's own String/Format/MarshalJSON redact as a second layer.
	// Populated only by heartbeat.handleScript, which validates it first.
	SecretEnv SecretEnv `json:"-"`
}

// ScriptResult represents the result of a script execution
type ScriptResult struct {
	ExecutionID     string   `json:"executionId"`
	ExitCode        int      `json:"exitCode"`
	Stdout          string   `json:"stdout"`
	Stderr          string   `json:"stderr"`
	Error           string   `json:"error,omitempty"`
	StartedAt       string   `json:"startedAt"`
	CompletedAt     string   `json:"completedAt"`
	TruncatedFields []string `json:"truncatedFields,omitempty"`

	// #3525. Set when this execution ended because a cancel request killed it.
	// Without the marker the server cannot tell "we killed it" from "it
	// finished on its own", and OD9-C requires it to preserve the natural
	// outcome whenever the original result wins the race.
	Cancelled bool `json:"cancelled,omitempty"`
	// CancelledByCommandID is the device_commands.id of the script_cancel
	// command that caused the kill, so the server can match the marker to the
	// cancel it issued rather than to an older one.
	CancelledByCommandID string `json:"cancelledByCommandId,omitempty"`
}

// Executor handles script execution with security controls
type Executor struct {
	config    *config.Config
	workDir   string
	validator *SecurityValidator
	running   map[string]*runningExecution
	mu        sync.Mutex
}

// runningExecution tracks a running script execution.
//
// It is created by reserve() BEFORE the script is validated or started, so a
// cancel racing Execute's setup cannot report not_found and then let the script
// start anyway. Everything mutable is guarded by mu; done is the termination
// signal Cancel blocks on.
type runningExecution struct {
	startedAt  time.Time
	scriptType string

	// done is closed exactly once, by release(), after cmd.Wait has returned
	// (or after the execution bailed out before starting). Cancel blocks on it
	// so its ack means "the process is gone", not "we asked".
	done     chan struct{}
	doneOnce sync.Once

	mu     sync.Mutex
	cmd    *exec.Cmd
	cancel context.CancelFunc

	// #3525. Captured once at Start: after SIGTERM the leader may already be
	// gone, so a kill-time syscall.Getpgid fails and the fallback kills a dead
	// leader while surviving children keep running. Unix only.
	pgid int
	// Windows containment handles; zero on Unix. If containment could NOT be
	// established (an enclosing RDS session job forbids breakaway —
	// sessionbroker/spawner_windows.go), contained stays false and a cancel can
	// never report `terminated`.
	job           jobHandle
	jobPrimitives windowsJobPrimitives
	contained     bool
	// containmentLost latches once a kill has run without containment, so a
	// later attachProcessGroup cannot upgrade this execution back to contained
	// and let the cancel that already happened claim `terminated`.
	containmentLost bool

	// owned marks that an Execute goroutine has taken responsibility for this
	// entry — it will eventually release() it and close done. An UNOWNED entry
	// is a cancel refusal record left by Cancel for an execution that has not
	// been dispatched yet; it is not running, and a second Execute for an
	// already-owned id must be refused rather than adopting it.
	owned bool
	// startAttempted flips the instant Execute commits to starting the process;
	// started flips only once Start actually succeeded.
	startAttempted bool
	started        bool

	graceSeconds    int
	cancelRequested bool
	cancelCommandID string
	// killErr is set by the cmd.Cancel callback so Cancel can distinguish a
	// failed kill from a successful one. The async callback error otherwise
	// surfaces only to cmd.Wait, never to the cancel caller.
	killErr error
}

func newRunningExecution(startedAt time.Time, scriptType string) *runningExecution {
	return &runningExecution{
		startedAt:  startedAt,
		scriptType: scriptType,
		done:       make(chan struct{}),
	}
}

func (r *runningExecution) closeDone() {
	r.doneOnce.Do(func() { close(r.done) })
}

// hasStarted reports whether the OS process was successfully created.
func (r *runningExecution) hasStarted() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.started
}

// beginStart publishes the command and its context canceller, and reports
// whether Execute may proceed. It returns false when a cancel already landed
// during validation / file write / configureRunAs, which is the whole point of
// reserving the id up front.
func (r *runningExecution) beginStart(cmd *exec.Cmd, cancel context.CancelFunc) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cancelRequested {
		return false
	}
	r.cmd = cmd
	r.cancel = cancel
	r.startAttempted = true
	return true
}

func (r *runningExecution) markStarted() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.started = true
}

// markCancelRequested records the cancel and reports whether an Execute
// goroutine owns this entry, whether it has already committed to starting the
// process, and the context canceller to fire (nil when nothing is running yet).
//
// The command id is recorded in the SAME critical section as the request, so
// the ScriptResult can never carry a cancellation marker without knowing which
// script_cancel command earned it.
func (r *runningExecution) markCancelRequested(cancelCommandID string, grace int) (owned, startAttempted bool, cancel context.CancelFunc) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cancelRequested = true
	r.graceSeconds = grace
	if cancelCommandID != "" {
		r.cancelCommandID = cancelCommandID
	}
	return r.owned, r.startAttempted, r.cancel
}

// cancellation reports whether this execution was cancelled and by which
// script_cancel command id.
func (r *runningExecution) cancellation() (bool, string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.cancelRequested, r.cancelCommandID
}

func (r *runningExecution) grace() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.graceSeconds
}

func (r *runningExecution) setKillErr(err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.killErr = err
}

// killOutcome snapshots everything Cancel needs to grade the stop once done
// has closed.
func (r *runningExecution) killOutcome() (started bool, killErr error, contained bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.started, r.killErr, r.contained
}

// attachProcessGroup records the pgid captured at Start. A real process group
// IS the containment primitive on Unix, so a captured pgid marks the execution
// contained; failing to capture one leaves it uncontained and a later cancel
// can never report `terminated`.
//
// It refuses to (re-)establish containment once a kill has already run without
// a group: a cancel firing in the window between cmd.Start returning and this
// call kills the leader only, and upgrading contained afterwards would let that
// cancel report `terminated` while group members survived.
func (r *runningExecution) attachProcessGroup(pgid int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pgid = pgid
	if r.containmentLost {
		return
	}
	r.contained = pgid > 0
}

// markContainmentLost permanently downgrades this execution to uncontained. It
// is called when a kill runs before (or without) containment being established.
func (r *runningExecution) markContainmentLost() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.contained = false
	r.containmentLost = true
}

// attachJob records the Windows containment handles established (or not) by
// launchContained.
func (r *runningExecution) attachJob(p windowsJobPrimitives, job jobHandle, process suspendedProcess, contained bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.jobPrimitives = p
	r.job = job
	r.contained = contained
	if r.cmd == nil && process.cmd != nil {
		r.cmd = process.cmd
	}
}

// isContained reports whether a kill of this execution can be trusted to reach
// the whole process tree.
func (r *runningExecution) isContained() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.contained
}

// containment snapshots what terminateProcessTreeWindows needs.
func (r *runningExecution) containment() (windowsJobPrimitives, jobHandle, *exec.Cmd) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.jobPrimitives, r.job, r.cmd
}

func (r *runningExecution) processGroup() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.pgid
}

func (r *runningExecution) command() *exec.Cmd {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.cmd
}

// New creates a new Executor instance
func New(cfg *config.Config) *Executor {
	workDir := os.TempDir()
	if dir := config.GetDataDir(); dir != "" {
		scriptDir := dir + "/scripts"
		if err := os.MkdirAll(scriptDir, 0700); err == nil {
			workDir = scriptDir
		}
	}

	return &Executor{
		config:    cfg,
		workDir:   workDir,
		validator: NewSecurityValidator(SecurityLevelStrict),
		running:   make(map[string]*runningExecution),
	}
}

// Execute runs a script and returns the result
func (e *Executor) Execute(script ScriptExecution) (*ScriptResult, error) {
	startTime := time.Now()
	result := &ScriptResult{
		ExecutionID: script.ID,
		StartedAt:   startTime.UTC().Format(time.RFC3339),
	}

	// #3525: reserve the id BEFORE validation, file write and configureRunAs. A
	// cancel racing that setup previously returned not_found and the script
	// started anyway — WebSocket commands are concurrent
	// (websocket/client.go dispatch).
	running, preCancelled, duplicate := e.reserve(script.ID, startTime, script.ScriptType)
	if duplicate {
		// Deliberately NOT released: we do not own this reservation, and closing
		// its done channel would unblock a Cancel waiting on the ORIGINAL
		// execution and let it report `terminated` while that process runs on.
		err := fmt.Errorf("execution %s is already running", script.ID)
		result.ExitCode = -1
		result.Error = err.Error()
		result.CompletedAt = time.Now().UTC().Format(time.RFC3339)
		log.Warn("refusing a duplicate execution for an id already running", "executionId", script.ID)
		return result, err
	}
	defer e.release(script.ID, running)
	if preCancelled {
		// A cancel landed while this script was still queued in the worker pool.
		// The marker is what closes the execution on the server: the cancel
		// itself could only answer not_found, because at that point nothing here
		// could tell a queued script from an id this device never had.
		_, byCmd := running.cancellation()
		result.ExitCode = -1
		result.Cancelled = true
		result.CancelledByCommandID = byCmd
		result.Error = "cancelled before execution started"
		result.CompletedAt = time.Now().UTC().Format(time.RFC3339)
		log.Info("refusing to start a script that was cancelled while queued",
			"executionId", script.ID, "cancelledBy", byCmd)
		return result, nil
	}

	log.Info("starting execution", "executionId", script.ID, "scriptId", script.ScriptID, "scriptType", script.ScriptType, "timeout", script.Timeout)

	// Validate script type
	if !IsSupportedScriptType(script.ScriptType) {
		err := fmt.Errorf("unsupported script type: %s", script.ScriptType)
		result.ExitCode = -1
		result.Error = err.Error()
		result.CompletedAt = time.Now().UTC().Format(time.RFC3339)
		return result, err
	}

	// Check platform compatibility
	if !IsScriptTypeAvailableOnPlatform(script.ScriptType) {
		err := fmt.Errorf("script type %s is not available on %s", script.ScriptType, runtime.GOOS)
		result.ExitCode = -1
		result.Error = err.Error()
		result.CompletedAt = time.Now().UTC().Format(time.RFC3339)
		return result, err
	}

	// Substitute parameters first, then validate
	scriptContent := SubstituteParameters(script.Script, script.Parameters)

	// Validate script content for security (after parameter substitution)
	if err := e.validateScript(scriptContent); err != nil {
		log.Warn("script validation failed", "executionId", script.ID, "error", err)
		result.ExitCode = -1
		result.Error = fmt.Sprintf("script validation failed: %v", err)
		result.CompletedAt = time.Now().UTC().Format(time.RFC3339)
		return result, err
	}

	// Write script to temp file
	scriptPath, err := WriteScriptFile(scriptContent, script.ScriptType)
	if err != nil {
		log.Error("failed to write script file", "executionId", script.ID, "error", err)
		result.ExitCode = -1
		result.Error = fmt.Sprintf("failed to write script: %v", err)
		result.CompletedAt = time.Now().UTC().Format(time.RFC3339)
		return result, err
	}
	defer CleanupScript(scriptPath)

	// Determine timeout
	timeout := script.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	if timeout > MaxTimeout {
		timeout = MaxTimeout
	}

	// Create context with timeout
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeout)*time.Second)
	defer cancel()

	// Build command
	shellCmd, shellArgs := GetShellCommand(script.ScriptType)
	if shellCmd == "" {
		err := fmt.Errorf("no shell available for script type: %s", script.ScriptType)
		result.ExitCode = -1
		result.Error = err.Error()
		result.CompletedAt = time.Now().UTC().Format(time.RFC3339)
		return result, err
	}

	var args []string
	if runtime.GOOS == "windows" {
		shellCmd, args = procoutput.WindowsScriptCommand(shellCmd, shellArgs, scriptPath)
	} else {
		args = append(shellArgs, scriptPath)
	}
	cmd := exec.CommandContext(ctx, shellCmd, args...)

	// Set working directory
	cmd.Dir = e.workDir

	// Set up output capture with size limits
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &limitedWriter{buf: &stdout, limit: MaxOutputSize}
	cmd.Stderr = &limitedWriter{buf: &stderr, limit: MaxOutputSize}

	// Configure environment
	cmd.Env = procoutput.ApplyEnv(e.buildEnvironment(script))

	// Set process group so children are killed on timeout
	setProcessGroup(cmd)

	// Suppress console window allocation on Windows (no-op elsewhere). The
	// user-helper is built -H windowsgui, so a console-subsystem child like
	// powershell.exe would otherwise pop a visible "black box" on the
	// interactive user desktop every script run.
	hideWindow(cmd)

	// When the context is cancelled (timeout OR an explicit cancel), terminate
	// the entire process tree rather than only the shell leader. Otherwise
	// long-running children like `sleep` keep the stdout/stderr pipes open and
	// Wait() blocks forever. The escalation happens INSIDE the callback because
	// os/exec synchronises this callback against Start/Wait, which is what makes
	// it safe to touch cmd.Process from in here (the uncontained fallback kills
	// do). Reaching for cmd.Process from Executor.Cancel's own goroutine would
	// NOT be safe, which is why Cancel only cancels the context.
	//
	// graceSeconds is 0 for a timeout (today's straight-to-SIGKILL behaviour)
	// and whatever the cancel request asked for otherwise.
	cmd.Cancel = func() error {
		killErr := terminateProcessTree(running, running.grace())
		running.setKillErr(killErr)
		return killErr
	}
	// Safety net: if killing the tree doesn't cause Wait to return within this
	// window (e.g. child is in uninterruptible I/O), give up and close the
	// pipes ourselves. It stays at 5s deliberately: WaitDelay only starts AFTER
	// the callback returns, and the callback has already consumed the grace, so
	// grace+5s would double-count. It is an independent post-callback backstop,
	// not proof of termination.
	cmd.WaitDelay = 5 * time.Second

	// Handle runAs for elevated execution
	if script.RunAs != "" {
		if err := e.configureRunAs(cmd, script.RunAs); err != nil {
			log.Error("failed to configure runAs", "executionId", script.ID, "user", script.RunAs, "error", err)
			result.ExitCode = -1
			result.Error = fmt.Sprintf("failed to configure runAs: %v", err)
			result.CompletedAt = time.Now().UTC().Format(time.RFC3339)
			return result, err
		}
	}

	// Publish the command on the reservation made at the top of Execute. If a
	// cancel landed while we were validating / writing the script file /
	// configuring runAs, bail out now instead of starting the process.
	if !running.beginStart(cmd, cancel) {
		_, byCmd := running.cancellation()
		result.ExitCode = -1
		result.Cancelled = true
		result.CancelledByCommandID = byCmd
		result.Error = "cancelled before execution started"
		result.CompletedAt = time.Now().UTC().Format(time.RFC3339)
		log.Info("execution cancelled during setup", "executionId", script.ID)
		return result, nil
	}

	// Start and wait separately (rather than cmd.Run): the pgid has to be
	// captured the instant the process exists, and Windows containment must
	// assign the Job Object between CreateProcess and ResumeThread.
	if startErr := startContained(running, cmd); startErr != nil {
		err = startErr
		// The process may EXIST even though the start failed — a Windows
		// ResumeThread failure leaves it created, contained and suspended, and
		// cmd.Wait is never reached. Releasing containment there would clear
		// KILL_ON_JOB_CLOSE and drop the only handle that could ever kill it.
		abortContainment(running)
	} else {
		running.markStarted()
		err = cmd.Wait()
		releaseContainment(running)
	}

	// Process results
	result.Stdout = procoutput.BytesToUTF8(stdout.Bytes())
	result.Stderr = procoutput.BytesToUTF8(stderr.Bytes())
	result.CompletedAt = time.Now().UTC().Format(time.RFC3339)

	// Record truncation in both a structured field and human-readable notice
	stdoutWriter := cmd.Stdout.(*limitedWriter)
	stderrWriter := cmd.Stderr.(*limitedWriter)
	if stdoutWriter.truncated {
		result.TruncatedFields = append(result.TruncatedFields, "stdout")
		result.Stderr += "\n[breeze: stdout truncated at 1MB]"
	}
	if stderrWriter.truncated {
		result.TruncatedFields = append(result.TruncatedFields, "stderr")
		result.Stderr += "\n[breeze: stderr truncated at 1MB]"
	}

	// #3525: stamp the cancellation marker regardless of how the process ended.
	// A script that exits 0 in the same instant it is cancelled still carries
	// the marker, and the server applies OD9-C to preserve the real outcome.
	cancelled, cancelledBy := running.cancellation()
	if cancelled {
		result.Cancelled = true
		result.CancelledByCommandID = cancelledBy
	}

	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			// Process group was already killed by cmd.Cancel when the context
			// deadline expired; nothing more to do here besides record the
			// timeout result.
			log.Warn("execution timed out", "executionId", script.ID, "timeoutSeconds", timeout)
			result.ExitCode = -1
			result.Error = fmt.Sprintf("execution timed out after %d seconds", timeout)
		} else if cancelled {
			// Checked before the ExitError branch on purpose: a killed shell
			// reports "signal: killed", which would otherwise be recorded as a
			// normal non-zero exit.
			log.Info("execution cancelled", "executionId", script.ID, "cancelledBy", cancelledBy)
			result.ExitCode = -1
			result.Error = "execution cancelled"
		} else if exitErr, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
			log.Info("execution completed", "executionId", script.ID, "exitCode", result.ExitCode)
		} else {
			result.ExitCode = -1
			result.Error = err.Error()
			log.Error("execution failed", "executionId", script.ID, "error", err)
		}
	} else {
		result.ExitCode = 0
		log.Info("execution completed successfully", "executionId", script.ID, "duration", time.Since(startTime))
	}

	return result, nil
}

// reserve claims executionID before the script is validated or started, so a
// cancel racing that setup finds an entry instead of reporting not_found.
//
// A second Execute for an id that is already reserved is a DUPLICATE and must
// be refused, never adopted: the second caller's release would close the shared
// done channel when IT finished, unblocking a Cancel that is waiting on the
// FIRST process and letting it report `terminated` while that process is still
// running. The server can genuinely redeliver a command id — the agent's dedup
// window is 2 minutes while a script may run for an hour.
func (e *Executor) reserve(executionID string, startedAt time.Time, scriptType string) (running *runningExecution, preCancelled, duplicate bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if existing, ok := e.running[executionID]; ok {
		existing.mu.Lock()
		defer existing.mu.Unlock()
		if existing.owned {
			return existing, false, true
		}
		// An unowned entry is a cancel refusal record: a cancel arrived while
		// this script was still queued in the worker pool. Adopt it and let
		// Execute bail out instead of running the script the operator stopped.
		existing.owned = true
		return existing, existing.cancelRequested, false
	}
	r := newRunningExecution(startedAt, scriptType)
	r.owned = true
	e.running[executionID] = r
	return r, false, false
}

// recordCancelRefusal remembers that executionID was cancelled before this
// executor ever saw it, so the Execute that eventually dequeues it refuses to
// start. Returns the entry, or the pre-existing one if a concurrent caller won.
//
// The record is reaped after cancelRefusalTTL if no Execute ever claims it —
// the command may have been cancelled server-side and never delivered at all,
// and an id must not be blocked forever.
func (e *Executor) recordCancelRefusal(executionID, cancelCommandID string, grace int) *runningExecution {
	e.mu.Lock()
	if existing, ok := e.running[executionID]; ok {
		e.mu.Unlock()
		return existing
	}
	r := newRunningExecution(time.Now(), "")
	r.cancelRequested = true
	r.cancelCommandID = cancelCommandID
	r.graceSeconds = grace
	e.running[executionID] = r
	e.mu.Unlock()

	time.AfterFunc(cancelRefusalTTL, func() {
		e.mu.Lock()
		defer e.mu.Unlock()
		current, ok := e.running[executionID]
		if !ok || current != r {
			return
		}
		current.mu.Lock()
		owned := current.owned
		current.mu.Unlock()
		if owned {
			return
		}
		delete(e.running, executionID)
		r.closeDone()
	})
	return r
}

// release drops the reservation and closes the done channel a blocked Cancel
// is waiting on. Safe to call more than once.
func (e *Executor) release(executionID string, r *runningExecution) {
	e.mu.Lock()
	if current, ok := e.running[executionID]; ok && current == r {
		delete(e.running, executionID)
	}
	e.mu.Unlock()
	r.closeDone()
}

// Cancel terminates a running script execution and BLOCKS until the outcome is
// known. The returned CancelOutcome is what the server builds `cancel_state`
// from, so returning before the process is gone would be a lie: the old
// implementation acked the instant it asked, and its "cancelled: true" proved
// neither termination nor even a successful kill attempt.
//
// cancelCommandID names the script_cancel command responsible; it is stamped
// onto the eventual ScriptResult so the server can tell which cancel earned the
// kill, and a stale or retried cancel is never credited with one it did not do.
//
// graceSeconds is clamped to 0..MaxGraceSeconds. The error return is reserved
// for future failures that are not about the process itself; today it is
// always nil, and callers must grade on the outcome.
func (e *Executor) Cancel(executionID, cancelCommandID string, graceSeconds int) (CancelOutcome, error) {
	grace := clampGrace(graceSeconds)

	e.mu.Lock()
	running, exists := e.running[executionID]
	e.mu.Unlock()
	if !exists {
		// The script may simply not have been DISPATCHED yet: the bypass lane
		// gets the cancel past the worker pool, but its target can still be
		// sitting in that queue behind another script (the pool floors at one
		// worker), in which case Execute has not run and there is nothing here
		// to find. Record the refusal so the Execute that eventually dequeues it
		// bails out instead of running the script the operator stopped.
		//
		// The ANSWER stays not_found, and that is deliberate: nothing here can
		// tell a queued script from an id this device never had, and claiming
		// `terminated` for a typo'd or stale id would forge a confirmed kill.
		// If the script really was queued, its refusal result carries the
		// cancellation marker, which closes the execution honestly.
		log.Info("cancel found no such execution; recording a refusal in case it is still queued",
			"executionId", executionID)
		e.recordCancelRefusal(executionID, cancelCommandID, grace)
		return CancelNotFound, nil
	}

	log.Info("cancelling execution", "executionId", executionID, "graceSeconds", grace)

	owned, startAttempted, cancelCtx := running.markCancelRequested(cancelCommandID, grace)
	if !owned {
		// An earlier cancel already left a refusal record and no Execute has
		// claimed it. Same reasoning as above: nothing is running here.
		return CancelNotFound, nil
	}
	if !startAttempted {
		// Execute owns this id and is still in setup. beginStart is
		// contractually required to bail out, so no process will ever exist —
		// that is a proven stop, not a guess.
		return CancelTerminated, nil
	}
	if cancelCtx != nil {
		// Cancel the context; this fires cmd.Cancel (set in Execute), which
		// escalates against the whole process tree. os/exec synchronizes the
		// callback with cmd.Start/Wait internally, so we don't race with
		// Process field writes in the execution goroutine.
		cancelCtx()
	}

	select {
	case <-running.done:
	case <-time.After(time.Duration(grace)*time.Second + hardKillBackstop):
		log.Warn("cancel gave up waiting for termination",
			"executionId", executionID, "graceSeconds", grace)
		return CancelKillFailed, nil
	}

	started, killErr, contained := running.killOutcome()
	outcome := gradeCancelOutcome(started, killErr, contained)
	if outcome == CancelKillFailed {
		log.Warn("cancel could not prove the process tree is gone",
			"executionId", executionID, "contained", contained, "killError", killErr)
	}
	return outcome, nil
}

// ListRunning returns a list of execution IDs whose process is actually
// running.
//
// e.running now also holds entries with no process behind them — a reservation
// made by Execute before it has started anything, and a cancel refusal record
// for a script that has not been dispatched (and may never be). Reporting those
// would have script_list_running invent phantom executions, so "started" is the
// bar rather than mere presence in the map.
func (e *Executor) ListRunning() []string {
	e.mu.Lock()
	defer e.mu.Unlock()

	ids := make([]string, 0, len(e.running))
	for id, r := range e.running {
		if !r.hasStarted() {
			continue
		}
		ids = append(ids, id)
	}
	return ids
}

// GetRunningCount returns how many executions have a process running, on the
// same basis as ListRunning.
func (e *Executor) GetRunningCount() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	count := 0
	for _, r := range e.running {
		if r.hasStarted() {
			count++
		}
	}
	return count
}

// validateScript performs security validation on script content
func (e *Executor) validateScript(content string) error {
	if content == "" {
		return fmt.Errorf("script content is empty")
	}

	// Check for maximum script size (1MB)
	if len(content) > MaxScriptSize {
		return fmt.Errorf("script content exceeds maximum size of %d bytes", MaxScriptSize)
	}

	// Use the SecurityValidator for comprehensive pattern checking
	return e.validator.Validate(content)
}

// buildEnvironment creates the environment variables for script execution
func (e *Executor) buildEnvironment(script ScriptExecution) []string {
	env := os.Environ()

	// Add Breeze-specific environment variables
	env = append(env,
		"BREEZE_EXECUTION_ID="+script.ID,
		"BREEZE_SCRIPT_ID="+script.ScriptID,
	)

	// Add parameters as environment variables (prefixed)
	for key, value := range script.Parameters {
		envKey := "BREEZE_PARAM_" + strings.ToUpper(strings.ReplaceAll(key, "-", "_"))
		env = append(env, envKey+"="+value)
	}

	// #3409 PR4b: secrets ride the environment, never the script text — the
	// substituted script is written to a temp file on the customer's disk.
	// Appended after os.Environ() on purpose: os/exec dedupes Cmd.Env keeping
	// the LAST occurrence, so a pre-existing BREEZE_VAR_* in the machine
	// environment cannot shadow a delivered secret.
	//
	// Keys were validated against the tenant-variable grammar by
	// ParseSecretEnv, so no character mapping is needed here (unlike the
	// parameter loop above, which has to fold "-" to "_").
	for key, value := range script.SecretEnv {
		env = append(env, script.SecretEnv.EnvKey(key)+"="+value)
	}

	return env
}

// configureRunAs configures the command to run as a different user
func (e *Executor) configureRunAs(cmd *exec.Cmd, runAs string) error {
	target := strings.TrimSpace(runAs)
	if target == "" || strings.EqualFold(target, "system") {
		return nil
	}

	if strings.EqualFold(target, "user") {
		return fmt.Errorf("runAs=user requires a connected user helper session")
	}

	if strings.EqualFold(target, "elevated") {
		// If we're already elevated (root/admin), nothing else to do.
		if privilege.IsRunningAsRoot() {
			return nil
		}
		if runtime.GOOS == "windows" {
			return fmt.Errorf("runAs=elevated requires the agent service to run with administrator privileges")
		}
		target = "root"
	}

	switch runtime.GOOS {
	case "windows":
		return fmt.Errorf("runAs on Windows is not yet implemented for %q", target)

	case "linux", "darwin":
		// On Unix systems, we can use sudo
		originalArgs := cmd.Args
		cmd.Path = "/usr/bin/sudo"
		if strings.EqualFold(target, "root") {
			cmd.Args = append([]string{"sudo", "-n"}, originalArgs...)
		} else {
			cmd.Args = append([]string{"sudo", "-n", "-u", target}, originalArgs...)
		}
		return nil

	default:
		return fmt.Errorf("runAs not supported on %s", runtime.GOOS)
	}
}

// limitedWriter wraps a buffer with a size limit and tracks truncation.
type limitedWriter struct {
	buf       *bytes.Buffer
	limit     int
	written   int
	truncated bool
}

func (w *limitedWriter) Write(p []byte) (n int, err error) {
	if w.written >= w.limit {
		// Discard additional data but don't error
		w.truncated = true
		return len(p), nil
	}

	remaining := w.limit - w.written
	if len(p) > remaining {
		p = p[:remaining]
		w.truncated = true
	}

	n, err = w.buf.Write(p)
	w.written += n
	return len(p), err // Return original length to avoid short write errors
}
