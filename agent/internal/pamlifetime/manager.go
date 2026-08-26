package pamlifetime

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/elevaccount"
	"github.com/google/uuid"
)

const (
	createSuspended                 uint32 = 0x00000004
	createBreakawayFromJob          uint32 = 0x01000000
	jobObjectLimitBreakawayOK       uint32 = 0x00000800
	jobObjectLimitSilentBreakawayOK uint32 = 0x00001000
	jobObjectLimitKillOnJobClose    uint32 = 0x00002000
)

type lifetimeStore interface {
	PrepareApply(ApplyCommand) (Decision, error)
	PrepareCleanup(CleanupCommand) (Decision, error)
	BindProcess(string, uint64, ProcessIdentity) error
	Entry(string) (LedgerEntry, bool)
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
	native        any
}

type jobOwnership struct {
	name        string
	handle      uintptr
	inheritable bool
	limitFlags  uint32
	native      any
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
	TerminateAndVerifyEmpty(context.Context, string, jobOwnership, ProcessIdentity) (int, error)
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
	store       lifetimeStore
	windows     windowsPrimitives
	account     accountLifecycle
	observe     func(Result)
	operationMu sync.Mutex
	mu          sync.Mutex
	jobs        map[string]jobOwnership
	processes   map[string]suspendedProcessOwnership
	enabled     bool
}

func newLifecycleManager(store lifetimeStore, windows windowsPrimitives, account accountLifecycle, observe func(Result)) *lifecycleManager {
	return &lifecycleManager{store: store, windows: windows, account: account, observe: observe,
		jobs: make(map[string]jobOwnership), processes: make(map[string]suspendedProcessOwnership), enabled: true}
}

func (m *lifecycleManager) ProtocolVersion() int { return 2 }

func (m *lifecycleManager) Apply(ctx context.Context, cmd ApplyCommand) Result {
	m.operationMu.Lock()
	defer m.operationMu.Unlock()
	bootID, err := m.currentBootID(ctx)
	if err != nil {
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, "boot_id_unavailable")
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
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, "invalid_command")
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
	if err := m.windows.Resume(ctx, process); err != nil {
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, "resume_failed")
	}
	m.windows.ClosePrimaryThread(process)
	received := m.result(cmd.ActuationID, cmd.Generation, ResultReceived, evidenceFromProcess(process.Identity, nil))
	m.emit(received)
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
	m.operationMu.Lock()
	defer m.operationMu.Unlock()
	bootID, bootErr := m.currentBootID(ctx)
	if bootErr != nil {
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, "boot_id_unavailable")
	}
	_, err := m.store.PrepareCleanup(cmd)
	if err != nil {
		return m.failed(cmd.ActuationID, cmd.Generation, bootID, "invalid_command")
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
	if hasCompleteProcessIdentity && entry.BootID == bootID {
		members, err = m.windows.TerminateAndVerifyEmpty(ctx, entry.JobName, job, process)
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

func (m *lifecycleManager) Reconcile(context.Context) []Result { return nil }

func (m *lifecycleManager) SetEnabled(_ context.Context, enabled bool) error {
	m.mu.Lock()
	m.enabled = enabled
	m.mu.Unlock()
	return nil
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
