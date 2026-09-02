package pamlifetime

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/elevaccount"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/google/uuid"
)

var log = logging.L("pamlifetime")

const (
	createSuspended                 uint32 = 0x00000004
	createBreakawayFromJob          uint32 = 0x01000000
	jobObjectLimitBreakawayOK       uint32 = 0x00000800
	jobObjectLimitSilentBreakawayOK uint32 = 0x00001000
	jobObjectLimitKillOnJobClose    uint32 = 0x00002000
)

// ErrJobObjectAbsent is returned (wrapped) by the Windows primitives when the
// durable Job Object name cannot be opened because no such object exists any
// more. Only OpenJobObjectW -> ERROR_FILE_NOT_FOUND maps to it; access denied,
// truncated lists and terminate failures never do. cleanupLocked uses it to
// tell "the job is gone" apart from "the job could not be terminated/verified".
var ErrJobObjectAbsent = errors.New("PAM Job Object does not exist")

type lifetimeStore interface {
	PrepareApply(ApplyCommand) (Decision, error)
	PrepareCleanup(CleanupCommand) (Decision, error)
	BindProcess(string, uint64, ProcessIdentity) error
	ClearProcessIdentity(string, uint64) error
	Entry(string) (LedgerEntry, bool)
	Entries() []LedgerEntry
	// LoadError reports a ledger that could not be read. Entries() returns an
	// empty slice in that case, so emptiness alone never means "no actuation".
	LoadError() error
}

type suspendedLaunchSpec struct {
	actuationID     string
	username        string
	password        string
	targetPath      string
	subjectUsername string
	creationFlags   uint32
}

type suspendedProcessOwnership struct {
	Identity      ProcessIdentity
	processHandle uintptr
	threadHandle  uintptr
	native        any //nolint:unused // Accessed by Windows-only lifecycle primitives.
}

type jobOwnership struct {
	name        string
	handle      uintptr
	inheritable bool
	limitFlags  uint32
	native      any //nolint:unused // Accessed by Windows-only lifecycle primitives.
}

type windowsPrimitives interface {
	CurrentBootID(context.Context) (string, error)
	PinTarget(context.Context, string, *string) (string, string, func(), error)
	CreateSuspended(context.Context, suspendedLaunchSpec) (suspendedProcessOwnership, error)
	CreateJob(context.Context, string) (jobOwnership, error)
	SetJobLimits(context.Context, jobOwnership, uint32) error
	AssignProcess(context.Context, jobOwnership, suspendedProcessOwnership) error
	Resume(context.Context, suspendedProcessOwnership) error
	VerifyActive(context.Context, suspendedProcessOwnership, jobOwnership) (int, error)
	ReopenAndVerifyActive(context.Context, string, ProcessIdentity) (jobOwnership, int, error)
	TerminateAndVerifyEmpty(context.Context, string, jobOwnership, ProcessIdentity) (int, error)
	// VerifyProcessIdentityGone reports whether the durable PID/creation-time
	// identity is positively gone: no such PID, PID reused by a process with a
	// different creation time, or same identity but no longer STILL_ACTIVE.
	// A live exact match returns false; anything unverifiable returns an error.
	VerifyProcessIdentityGone(context.Context, ProcessIdentity) (bool, error)
	VerifyNoPrivilegedToken(context.Context, string) (bool, error)
	CloseProcess(suspendedProcessOwnership)
	ClosePrimaryThread(suspendedProcessOwnership)
	CloseJob(jobOwnership)
}

type accountLifecycle interface {
	Promote(context.Context) (elevaccount.Credential, error)
	Deprovision(context.Context) (elevaccount.AccountEvidence, error)
	VerifyClean(context.Context) (elevaccount.AccountEvidence, error)
}

type lifecycleManager struct {
	store         lifetimeStore
	windows       windowsPrimitives
	account       accountLifecycle
	observe       func(Result)
	operationGate chan struct{}
	mu            sync.Mutex
	jobs          map[string]jobOwnership
	processes     map[string]suspendedProcessOwnership
	enabled       bool
	admissionOpen bool
	available     bool
	unresolved    map[string]uint64
}

func newLifecycleManager(store lifetimeStore, windows windowsPrimitives, account accountLifecycle, observe func(Result)) *lifecycleManager {
	gate := make(chan struct{}, 1)
	gate <- struct{}{}
	return &lifecycleManager{store: store, windows: windows, account: account, observe: observe,
		operationGate: gate, jobs: make(map[string]jobOwnership), processes: make(map[string]suspendedProcessOwnership),
		enabled: true, admissionOpen: true, available: true, unresolved: make(map[string]uint64)}
}

func (m *lifecycleManager) ProtocolVersion() int { return 2 }

func (m *lifecycleManager) Available() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.available
}

func (m *lifecycleManager) Apply(ctx context.Context, cmd ApplyCommand) Result {
	return m.apply(ctx, cmd, nil)
}

func (m *lifecycleManager) ApplyWithReceivedObservation(
	ctx context.Context,
	cmd ApplyCommand,
	handoff func(Result) error,
) Result {
	return m.apply(ctx, cmd, handoff)
}

func (m *lifecycleManager) apply(ctx context.Context, cmd ApplyCommand, handoff func(Result) error) Result {
	if err := m.acquireOperation(ctx); err != nil {
		return m.failed(cmd.ActuationID, cmd.Generation, "windows-boot-unavailable", "operation_timeout")
	}
	defer m.releaseOperation()
	bootID, err := m.currentBootID(ctx)
	if err != nil {
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, "boot_id_unavailable")
	}
	m.mu.Lock()
	admissionOpen := m.admissionOpen
	available := m.available
	m.mu.Unlock()
	if !available {
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, "pam_unavailable")
	}
	if !admissionOpen {
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, "pam_disabled")
	}
	if err := validateApply(cmd); err != nil {
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, "invalid_command")
	}
	canonicalPath, targetHash, releaseTarget, err := m.windows.PinTarget(ctx, cmd.TargetPath, cmd.TargetHash)
	if err != nil || releaseTarget == nil {
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, "target_verification_failed")
	}
	defer releaseTarget()
	decision, err := m.store.PrepareApply(cmd)
	if err != nil {
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, storeFailureCode(err))
	}
	if decision == DecisionDuplicate {
		entry, _ := m.store.Entry(cmd.ActuationID)
		if entry.BootID == "" {
			entry.BootID = bootID
		}
		return m.result(cmd.ActuationID, cmd.Generation, ResultReceived, evidenceFromEntry(entry))
	}

	credential, err := m.account.Promote(ctx)
	if err != nil {
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, "account_promotion_failed")
	}
	deprovisionOnFailure := true
	defer func() {
		zeroString(&credential.Password)
		if deprovisionOnFailure {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_, _ = m.account.Deprovision(cleanupCtx)
		}
	}()

	process, err := m.windows.CreateSuspended(ctx, suspendedLaunchSpec{
		actuationID: cmd.ActuationID, username: credential.Username, password: credential.Password,
		targetPath: canonicalPath, subjectUsername: cmd.SubjectUsername,
		creationFlags: createSuspended,
	})
	if err != nil {
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, "create_process_failed")
	}
	process.Identity.TargetHash = targetHash
	process.Identity.BootID = bootID
	jobName := JobName(cmd.ActuationID, cmd.Generation)
	job, err := m.windows.CreateJob(ctx, jobName)
	if err != nil {
		m.windows.CloseProcess(process)
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, "create_job_failed")
	}
	closeOwnership := true
	defer func() {
		if closeOwnership {
			m.windows.CloseJob(job)
			m.windows.CloseProcess(process)
		}
	}()
	if job.inheritable {
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, "inheritable_job_handle")
	}
	if err := m.windows.SetJobLimits(ctx, job, jobObjectLimitKillOnJobClose); err != nil {
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, "configure_job_failed")
	}
	job.limitFlags = jobObjectLimitKillOnJobClose
	if err := m.windows.AssignProcess(ctx, job, process); err != nil {
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, "assign_job_failed")
	}
	process.Identity.JobName = jobName
	if err := m.store.BindProcess(cmd.ActuationID, cmd.Generation, process.Identity); err != nil {
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, "persist_process_failed")
	}
	// The `received` observation is anchored while the target is still
	// suspended. BindProcess has already bound every field the observation
	// carries (PID, creation time, job name), so nothing here needs the process
	// to be running; and a handoff the server refuses is then contained by never
	// resuming at all, instead of by terminating a process that has already
	// exercised privilege. See docs/superpowers/specs/2026-08-28-s0-track-e-pam-rc3-design.md.
	received := m.result(cmd.ActuationID, cmd.Generation, ResultReceived, evidenceFromProcess(process.Identity, nil))
	if handoff != nil {
		if err := handoff(received); err != nil {
			m.markUnresolved(cmd.ActuationID, cmd.Generation)
			return m.failed(cmd.ActuationID, cmd.Generation, bootID, receivedHandoffFailureCode(err))
		}
	} else {
		m.emit(received)
	}
	if err := m.windows.Resume(ctx, process); err != nil {
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, "resume_failed")
	}
	m.windows.ClosePrimaryThread(process)
	members, err := m.windows.VerifyActive(ctx, process, job)
	if err != nil || members < 1 {
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, "active_verification_failed")
	}
	evidence := evidenceFromProcess(process.Identity, &members)
	verified := m.result(cmd.ActuationID, cmd.Generation, ResultVerifiedActive, evidence)
	m.emit(verified)
	m.mu.Lock()
	m.jobs[cmd.ActuationID] = job
	m.processes[cmd.ActuationID] = process
	m.mu.Unlock()
	closeOwnership = false
	deprovisionOnFailure = false
	return verified
}

func (m *lifecycleManager) Cleanup(ctx context.Context, cmd CleanupCommand) Result {
	if err := m.acquireOperation(ctx); err != nil {
		result := m.failed(cmd.ActuationID, cmd.Generation, "windows-boot-unavailable", "operation_timeout")
		m.recordCleanupOutcome(cmd.ActuationID, result)
		return result
	}
	defer m.releaseOperation()
	result := m.cleanupLocked(ctx, cmd)
	m.recordCleanupOutcome(cmd.ActuationID, result)
	return result
}

func (m *lifecycleManager) cleanupLocked(ctx context.Context, cmd CleanupCommand) Result {
	bootID, bootErr := m.currentBootID(ctx)
	if bootErr != nil {
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, "boot_id_unavailable")
	}
	_, err := m.store.PrepareCleanup(cmd)
	if err != nil {
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, storeFailureCode(err))
	}
	entry, ok := m.store.Entry(cmd.ActuationID)
	if !ok {
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, "missing_tombstone")
	}
	process := ProcessIdentity{PID: entry.PID, JobName: entry.JobName, BootID: entry.BootID}
	if entry.ProcessCreationTime != nil {
		process.ProcessCreationTime = *entry.ProcessCreationTime
	}
	m.mu.Lock()
	job, ownsJob := m.jobs[cmd.ActuationID]
	ownedProcess, ownsProcess := m.processes[cmd.ActuationID]
	m.mu.Unlock()
	members := 0
	hasAnyProcessIdentity := entry.PID != 0 || entry.JobName != "" || entry.ProcessCreationTime != nil
	hasCompleteProcessIdentity := entry.PID > 0 && entry.JobName != "" && entry.ProcessCreationTime != nil && entry.BootID != ""
	if hasAnyProcessIdentity && !hasCompleteProcessIdentity {
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, "job_cleanup_failed")
	}
	jobObjectAbsent := false
	if hasCompleteProcessIdentity && entry.BootID == bootID {
		members, err = m.windows.TerminateAndVerifyEmpty(ctx, entry.JobName, job, process)
		if err != nil && !ownsJob && errors.Is(err, ErrJobObjectAbsent) {
			// #4196: the agent that owned the Job Object died on this boot, so
			// KILL_ON_JOB_CLOSE reaped the tree and the named job no longer
			// exists. The job handle can no longer prove anything, but the
			// rule forbids claiming what cannot be proven, not proving it by
			// other evidence: the durable process identity must be positively
			// gone before cleanup may continue on account and token evidence.
			gone, verifyErr := m.windows.VerifyProcessIdentityGone(ctx, process)
			if verifyErr != nil {
				return m.failed(cmd.ActuationID, cmd.Generation, bootID, "job_cleanup_failed")
			}
			if !gone {
				// Job gone, exact process still running: an orphaned elevated
				// process. Its own code, so it never reads as "could not
				// terminate or verify the job".
				return m.failed(cmd.ActuationID, cmd.Generation, bootID, "job_absent_process_alive")
			}
			members, err, jobObjectAbsent = 0, nil, true
		}
		if err != nil || members != 0 {
			return m.failed(cmd.ActuationID, cmd.Generation, bootID, "job_cleanup_failed")
		}
	}
	deprovisioned, err := m.account.Deprovision(ctx)
	if err != nil {
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, "account_cleanup_failed")
	}
	verified, err := m.account.VerifyClean(ctx)
	if err != nil || verified.Enabled || verified.InAdministrators || deprovisioned.Enabled || deprovisioned.InAdministrators {
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, "account_verification_failed")
	}
	privileged, err := m.windows.VerifyNoPrivilegedToken(ctx, elevaccount.AccountName)
	if err != nil || privileged {
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, "privileged_token_verification_failed")
	}
	evidence := evidenceFromEntry(entry)
	evidence.BootID = bootID
	evidence.JobMemberCount = intPtr(0)
	evidence.AccountEnabled = boolPtr(verified.Enabled)
	evidence.AccountInAdministrators = boolPtr(verified.InAdministrators)
	evidence.PrivilegedTokenPresent = boolPtr(privileged)
	if jobObjectAbsent {
		evidence.JobObjectAbsent = boolPtr(true)
	}
	if err := m.store.ClearProcessIdentity(cmd.ActuationID, cmd.Generation); err != nil {
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, "persist_cleanup_evidence_failed")
	}
	result := m.result(cmd.ActuationID, cmd.Generation, ResultCleaned, evidence)
	m.emit(result)
	m.mu.Lock()
	delete(m.jobs, cmd.ActuationID)
	delete(m.processes, cmd.ActuationID)
	m.mu.Unlock()
	if ownsProcess {
		m.windows.CloseProcess(ownedProcess)
	}
	if ownsJob {
		m.windows.CloseJob(job)
	}
	return result
}

func (m *lifecycleManager) Reconcile(ctx context.Context) []Result {
	if err := m.acquireOperation(ctx); err != nil {
		m.setAvailable(false)
		entries := m.store.Entries()
		results := make([]Result, 0, len(entries))
		for _, entry := range entries {
			result := m.failed(entry.ActuationID, entry.Generation, "windows-boot-unavailable", "operation_timeout")
			m.recordCleanupOutcome(entry.ActuationID, result)
			results = append(results, result)
		}
		return results
	}
	defer m.releaseOperation()
	m.setAvailable(false)
	entries := m.store.Entries()
	results := make([]Result, 0, len(entries))
	verificationAvailable := true
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			result := m.failed(entry.ActuationID, entry.Generation, "windows-boot-unavailable", "reconcile_cancelled")
			m.markUnresolved(entry.ActuationID, entry.Generation)
			m.emit(result)
			results = append(results, result)
			verificationAvailable = false
			continue
		}
		if entry.DesiredState == DesiredCleanup {
			result := m.cleanupLocked(ctx, cleanupCommandFromEntry(entry, entry.Generation))
			m.recordCleanupOutcome(entry.ActuationID, result)
			if result.State == ResultFailed {
				m.emit(result)
				verificationAvailable = false
			}
			results = append(results, result)
			continue
		}
		result, verified := m.reconcileActiveLocked(ctx, entry)
		if verified {
			m.clearUnresolvedThrough(entry.ActuationID, entry.Generation)
		} else {
			m.markUnresolved(entry.ActuationID, entry.Generation)
		}
		m.emit(result)
		results = append(results, result)
		verificationAvailable = verificationAvailable && verified
	}
	m.mu.Lock()
	m.available = verificationAvailable && len(m.unresolved) == 0
	m.mu.Unlock()
	return results
}

func (m *lifecycleManager) reconcileActiveLocked(ctx context.Context, entry LedgerEntry) (Result, bool) {
	bootID, err := m.currentBootID(ctx)
	if err != nil {
		return m.failed(entry.ActuationID, entry.Generation, bootID, "boot_id_unavailable"), false
	}
	evidence := evidenceFromEntry(entry)
	evidence.BootID = bootID
	if entry.PID <= 0 || entry.JobName == "" || entry.ProcessCreationTime == nil || entry.BootID == "" {
		result := m.result(entry.ActuationID, entry.Generation, ResultFailed, evidence)
		result.FailureCode = "reconcile_identity_unavailable"
		return result, false
	}
	process := ProcessIdentity{PID: entry.PID, ProcessCreationTime: *entry.ProcessCreationTime, JobName: entry.JobName, BootID: entry.BootID}
	if entry.BootID == bootID {
		job, members, reopenErr := m.windows.ReopenAndVerifyActive(ctx, entry.JobName, process)
		if reopenErr == nil && members > 0 {
			evidence.JobMemberCount = intPtr(members)
			m.mu.Lock()
			m.jobs[entry.ActuationID] = job
			m.mu.Unlock()
			return m.result(entry.ActuationID, entry.Generation, ResultVerifiedActive, evidence), true
		}
	}
	verifiedEvidence, code, verified := m.verifyAccountClean(ctx, evidence)
	result := m.result(entry.ActuationID, entry.Generation, ResultFailed, verifiedEvidence)
	if code != "" {
		result.FailureCode = code
	} else if entry.BootID != bootID {
		result.FailureCode = "reboot_process_vanished"
	} else {
		result.FailureCode = "active_job_unavailable"
	}
	return result, verified
}

// verifyAccountClean proves the dormant elevation account is deprovisioned,
// disabled, out of Administrators and holding no live token.
//
// An absent account is tolerated in exactly one situation: this agent has no
// record of ever having applied an actuation. The account is provisioned
// lazily when PAM is first enabled, so on the majority of the fleet it was
// never created. Reconciling a recorded actuation is the opposite case, where
// a missing account is anomalous and must keep failing closed.
//
// That condition is derived here rather than passed in by the caller. It is
// not simply "the ledger is empty": a ledger that could not be READ also
// yields zero entries, and on such a device the actuation history is unknown,
// not absent.
func (m *lifecycleManager) verifyAccountClean(ctx context.Context, evidence ResultEvidence) (ResultEvidence, string, bool) {
	deprovisioned, err := m.account.Deprovision(ctx)
	if err != nil {
		return evidence, "account_cleanup_failed", false
	}
	verified, err := m.account.VerifyClean(ctx)
	if err != nil || verified.Enabled || verified.InAdministrators || deprovisioned.Enabled || deprovisioned.InAdministrators {
		return evidence, "account_verification_failed", false
	}
	neverActuated := len(m.store.Entries()) == 0 && m.store.LoadError() == nil
	privileged, err := m.windows.VerifyNoPrivilegedToken(ctx, elevaccount.AccountName)
	tokenScanned := true
	switch {
	case err != nil:
		// The scan needs the account's SID, so it fails outright when the name
		// resolves to nothing. On a never-actuated agent that means the
		// dormant account was never created: nothing has ever logged on as it,
		// so no process can be holding a token for it (#4587). Any other
		// error, and any error at all once an actuation is on record — where a
		// deleted account can still leave a live orphaned token behind — stays
		// a verification failure.
		if !neverActuated || !elevaccount.IsAccountAbsent(err) {
			return evidence, "privileged_token_verification_failed", false
		}
		// Logged because a skipped security check should never be invisible.
		// This fires once per agent lifetime, not once per heartbeat: the
		// disable settles, and the next call returns at SetEnabled's early
		// return without reaching this code.
		tokenScanned = false
		log.Info("PAM token scan skipped: elevation account absent and no actuation on record",
			"account", elevaccount.AccountName)
	case privileged:
		return evidence, "privileged_token_verification_failed", false
	}
	evidence.AccountEnabled = boolPtr(false)
	evidence.AccountInAdministrators = boolPtr(false)
	if tokenScanned {
		// Left nil when the scan was skipped: not measured is not the same
		// claim as measured absent.
		evidence.PrivilegedTokenPresent = boolPtr(false)
	}
	return evidence, "", true
}

func (m *lifecycleManager) SetEnabled(ctx context.Context, enabled bool) error {
	if err := m.acquireOperation(ctx); err != nil {
		m.markUnresolved("__account__", 0)
		return fmt.Errorf("PAM lifecycle operation timed out: %w", err)
	}
	defer m.releaseOperation()
	m.mu.Lock()
	current := m.enabled
	admissionOpen := m.admissionOpen
	available := m.available
	unresolved := len(m.unresolved)
	m.mu.Unlock()
	if enabled {
		if !available || unresolved > 0 {
			return errors.New("PAM cleanup remains unresolved")
		}
		if current && admissionOpen {
			return nil
		}
		m.mu.Lock()
		m.enabled = true
		m.admissionOpen = true
		m.mu.Unlock()
		return nil
	}
	if !current && available && unresolved == 0 {
		return nil
	}
	m.mu.Lock()
	m.admissionOpen = false
	m.mu.Unlock()
	entries := m.store.Entries()
	var failures []string
	if loadErr := m.store.LoadError(); loadErr != nil {
		// An unreadable ledger reports zero entries, the same shape as "this
		// device never actuated" — but it is not the same claim. The actuation
		// history is unknown, so nothing about the account may be concluded
		// from emptiness. Fail closed; here the repeating heartbeat ERROR is
		// the correct signal, because this is a genuine failure state.
		failures = append(failures, "account:ledger_unavailable")
		m.markUnresolved("__account__", 0)
	} else if len(entries) == 0 {
		bootID, bootErr := m.currentBootID(ctx)
		if bootErr != nil {
			failures = append(failures, "account:boot_id_unavailable")
			m.markUnresolved("__account__", 0)
		} else if _, code, verified := m.verifyAccountClean(ctx, ResultEvidence{BootID: bootID}); !verified {
			failures = append(failures, "account:"+code)
			m.markUnresolved("__account__", 0)
		} else {
			m.clearUnresolved("__account__")
		}
	}
	for _, entry := range entries {
		generation := entry.Generation
		if entry.DesiredState == DesiredActive {
			generation++
		}
		result := m.cleanupLocked(ctx, cleanupCommandFromEntry(entry, generation))
		m.recordCleanupOutcome(entry.ActuationID, result)
		if result.State == ResultFailed {
			m.emit(result)
			failures = append(failures, fmt.Sprintf("%s:%s", entry.ActuationID, result.FailureCode))
		}
	}
	m.mu.Lock()
	remainingUnresolved := len(m.unresolved)
	m.mu.Unlock()
	if remainingUnresolved > 0 && len(failures) == 0 {
		failures = append(failures, "unresolved_cleanup_evidence")
	}
	if len(failures) > 0 {
		return fmt.Errorf("PAM disable cleanup unverified: %s", strings.Join(failures, ", "))
	}
	m.mu.Lock()
	m.enabled = false
	m.admissionOpen = false
	m.available = len(m.unresolved) == 0
	m.mu.Unlock()
	return nil
}

// AcquireLegacyActuation grants a context-bounded lease over the same
// lifecycle gate used by v2 apply/cleanup/reconcile and policy disable. The
// frozen Manager interface remains unchanged; legacy callers discover this
// optional concrete capability and fail closed when it is absent.
func (m *lifecycleManager) AcquireLegacyActuation(ctx context.Context) (func(), error) {
	if err := m.acquireOperation(ctx); err != nil {
		return nil, err
	}
	m.mu.Lock()
	allowed := m.enabled && m.admissionOpen && m.available && len(m.unresolved) == 0
	m.mu.Unlock()
	if !allowed {
		m.releaseOperation()
		return nil, errors.New("PAM legacy actuation admission unavailable")
	}
	var once sync.Once
	return func() { once.Do(m.releaseOperation) }, nil
}

func (m *lifecycleManager) acquireOperation(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-m.operationGate:
		return nil
	}
}

func (m *lifecycleManager) releaseOperation() { m.operationGate <- struct{}{} }

func (m *lifecycleManager) recordCleanupOutcome(actuationID string, result Result) {
	if result.State == ResultCleaned {
		m.clearUnresolvedThrough(actuationID, result.Generation)
		return
	}
	m.markUnresolved(actuationID, result.Generation)
}

func (m *lifecycleManager) markUnresolved(key string, generation uint64) {
	m.mu.Lock()
	if current, ok := m.unresolved[key]; !ok || generation > current {
		m.unresolved[key] = generation
	}
	m.available = false
	m.admissionOpen = false
	m.mu.Unlock()
}

func (m *lifecycleManager) clearUnresolvedThrough(key string, generation uint64) {
	m.mu.Lock()
	if unresolvedGeneration, ok := m.unresolved[key]; ok && generation >= unresolvedGeneration {
		delete(m.unresolved, key)
	}
	if len(m.unresolved) == 0 {
		m.available = true
	}
	m.mu.Unlock()
}

func (m *lifecycleManager) clearUnresolved(key string) {
	m.mu.Lock()
	delete(m.unresolved, key)
	if len(m.unresolved) == 0 {
		m.available = true
	}
	m.mu.Unlock()
}

func cleanupCommandFromEntry(entry LedgerEntry, generation uint64) CleanupCommand {
	return CleanupCommand{ProtocolVersion: 2, ActuationID: entry.ActuationID, Generation: generation,
		RequestID: entry.RequestID, DeviceID: entry.DeviceID, OrgID: entry.OrgID}
}

func (m *lifecycleManager) setAvailable(available bool) {
	m.mu.Lock()
	m.available = available
	m.mu.Unlock()
}

func (m *lifecycleManager) emit(result Result) {
	if m.observe != nil {
		m.observe(result)
	}
}

func (m *lifecycleManager) result(actuationID string, generation uint64, state ResultState, evidence ResultEvidence) Result {
	return Result{ProtocolVersion: 2, ObservationID: uuid.NewString(), ActuationID: actuationID,
		Generation: generation, State: state, ObservedAt: time.Now().UTC(), Evidence: evidence}
}

func (m *lifecycleManager) currentBootID(ctx context.Context) (string, error) {
	bootID, err := m.windows.CurrentBootID(ctx)
	bootID = strings.TrimSpace(bootID)
	if err != nil || bootID == "" {
		return "windows-boot-unavailable", errors.New("current Windows boot identity unavailable")
	}
	return bootID, nil
}

// storeFailureCode separates "the ledger rejected this command" from "the
// ledger could not be written" and "the ledger could not be read". All three
// used to surface as invalid_command, which made a total ledger outage
// (issue #4184) indistinguishable from a malformed request on the server side.
func storeFailureCode(err error) string {
	switch {
	case errors.Is(err, ErrLedgerPersist):
		return "ledger_persist_failed"
	case errors.Is(err, ErrLedgerUnavailable):
		return "ledger_unavailable"
	default:
		return "invalid_command"
	}
}

// receivedHandoffFailureCode keeps a server that refused this envelope
// distinguishable on the wire from an agent that could not deliver the
// observation at all. Both contain identically - the target is never resumed -
// but they point an operator at different things.
func receivedHandoffFailureCode(err error) string {
	if errors.Is(err, ErrReceivedObservationRejected) {
		return "received_observation_rejected"
	}
	return "received_observation_handoff_failed"
}

func (m *lifecycleManager) failed(actuationID string, generation uint64, bootID, code string) Result {
	result := m.result(actuationID, generation, ResultFailed, ResultEvidence{BootID: bootID})
	result.FailureCode = code
	return result
}

func JobName(actuationID string, generation uint64) string {
	return fmt.Sprintf("Global\\Breeze.PAM.%s.g%d", strings.ToLower(actuationID), generation)
}

func evidenceFromEntry(entry LedgerEntry) ResultEvidence {
	return ResultEvidence{PID: entry.PID, ProcessCreationTime: entry.ProcessCreationTime, JobName: entry.JobName, BootID: entry.BootID}
}

func evidenceFromProcess(process ProcessIdentity, members *int) ResultEvidence {
	creation := process.ProcessCreationTime.UTC()
	return ResultEvidence{PID: process.PID, ProcessCreationTime: &creation, WindowsSessionID: process.WindowsSessionID,
		JobName: process.JobName, JobMemberCount: members, TargetHash: process.TargetHash, BootID: process.BootID}
}

func zeroString(value *string) {
	if value == nil {
		return
	}
	*value = strings.Repeat("\x00", len(*value))
	*value = ""
}

func boolPtr(value bool) *bool { return &value }
func intPtr(value int) *int    { return &value }

func failedResult(actuationID string, generation uint64, code string) Result {
	return Result{
		ProtocolVersion: 2,
		ObservationID:   uuid.NewString(),
		ActuationID:     actuationID,
		Generation:      generation,
		State:           ResultFailed,
		ObservedAt:      time.Now().UTC(),
		FailureCode:     code,
		Evidence:        ResultEvidence{},
	}
}

var _ Manager = (*lifecycleManager)(nil)
