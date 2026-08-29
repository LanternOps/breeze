package pamlifetime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/elevaccount"
	"github.com/google/uuid"
)

type recordingLifetimeStore struct {
	*Store
	order    *[]string
	clearErr error
}

func (s *recordingLifetimeStore) PrepareApply(cmd ApplyCommand) (Decision, error) {
	decision, err := s.Store.PrepareApply(cmd)
	if err == nil && decision == DecisionApply {
		*s.order = append(*s.order, "persist desired active generation")
	}
	return decision, err
}

func (s *recordingLifetimeStore) PrepareCleanup(cmd CleanupCommand) (Decision, error) {
	decision, err := s.Store.PrepareCleanup(cmd)
	if err == nil && decision == DecisionCleanup {
		*s.order = append(*s.order, "persist cleanup tombstone")
	}
	return decision, err
}

func (s *recordingLifetimeStore) BindProcess(actuationID string, generation uint64, process ProcessIdentity) error {
	err := s.Store.BindProcess(actuationID, generation, process)
	if err == nil {
		*s.order = append(*s.order, "persist process identity")
	}
	return err
}

func (s *recordingLifetimeStore) ClearProcessIdentity(actuationID string, generation uint64) error {
	*s.order = append(*s.order, "clear durable process identity")
	if s.clearErr != nil {
		return s.clearErr
	}
	return s.Store.ClearProcessIdentity(actuationID, generation)
}

type fakeWindowsPrimitives struct {
	order               *[]string
	launchSpec          suspendedLaunchSpec
	job                 jobOwnership
	cleanupProcess      ProcessIdentity
	cleanupJobName      string
	cleanupErr          error
	cleanupMembers      int
	privilegedToken     bool
	privilegedTokenErr  error
	identityGone        bool
	identityGoneErr     error
	identityGoneCalls   int
	identityGoneProcess ProcessIdentity
	bootID              string
	validateErr         error
	createProcessErr    error
	createJobErr        error
	setJobErr           error
	assignErr           error
	resumeErr           error
	resumeCalls         int
	verifyActiveErr     error
	verifyActiveCalls   int
	reopenJob           jobOwnership
	reopenMembers       int
	reopenErr           error
	reopenCalls         int
	createStarted       chan<- struct{}
	blockCreate         <-chan struct{}
	closeProcessCount   int
	closeThreadCount    int
	closeJobCount       int
	invalidCloseCount   int
	processClosed       bool
	threadClosed        bool
	jobClosed           bool
	pinTarget           bool
	targetHeld          bool
	targetReleaseCount  int
	createSawTargetHeld bool
}

func (f *fakeWindowsPrimitives) CurrentBootID(context.Context) (string, error) {
	if f.bootID == "" {
		return "windows-boot-42", nil
	}
	return f.bootID, nil
}

func (f *fakeWindowsPrimitives) ValidateTarget(_ context.Context, path string, expectedHash *string) (string, string, error) {
	*f.order = append(*f.order, "validate identity/generation/hash/lifetime")
	if f.validateErr != nil {
		return "", "", f.validateErr
	}
	if path == "" {
		return "", "", errors.New("empty path")
	}
	hash := strings.Repeat("a", 64)
	if expectedHash != nil && !strings.EqualFold(*expectedHash, hash) {
		return "", "", errors.New("hash mismatch")
	}
	return path, hash, nil
}

func (f *fakeWindowsPrimitives) PinTarget(ctx context.Context, path string, expectedHash *string) (string, string, func(), error) {
	canonical, hash, err := f.ValidateTarget(ctx, path, expectedHash)
	if err != nil {
		return "", "", nil, err
	}
	f.pinTarget = true
	f.targetHeld = true
	return canonical, hash, func() {
		f.targetHeld = false
		f.targetReleaseCount++
	}, nil
}

func (f *fakeWindowsPrimitives) CreateSuspended(_ context.Context, spec suspendedLaunchSpec) (suspendedProcessOwnership, error) {
	f.launchSpec = spec
	f.createSawTargetHeld = f.targetHeld
	*f.order = append(*f.order, "CreateProcessAsUser(CREATE_SUSPENDED)")
	if f.createStarted != nil {
		close(f.createStarted)
	}
	if f.blockCreate != nil {
		<-f.blockCreate
	}
	if f.createProcessErr != nil {
		return suspendedProcessOwnership{}, f.createProcessErr
	}
	return suspendedProcessOwnership{
		Identity: ProcessIdentity{
			PID:                 4242,
			ProcessCreationTime: time.Unix(1234, 0).UTC(),
			WindowsSessionID:    7,
			TargetHash:          strings.Repeat("a", 64),
			BootID:              "windows-boot-42",
		},
		processHandle: 11,
		threadHandle:  12,
	}, nil
}

func (f *fakeWindowsPrimitives) CreateJob(_ context.Context, name string) (jobOwnership, error) {
	*f.order = append(*f.order, "CreateJobObjectW("+name+")")
	if f.createJobErr != nil {
		return jobOwnership{}, f.createJobErr
	}
	f.job = jobOwnership{name: name, handle: 21, inheritable: false}
	return f.job, nil
}

func (f *fakeWindowsPrimitives) SetJobLimits(_ context.Context, job jobOwnership, flags uint32) error {
	*f.order = append(*f.order, "SetInformationJobObject(KILL_ON_JOB_CLOSE)")
	if f.setJobErr != nil {
		return f.setJobErr
	}
	f.job = job
	f.job.limitFlags = flags
	return nil
}

func (f *fakeWindowsPrimitives) AssignProcess(_ context.Context, _ jobOwnership, _ suspendedProcessOwnership) error {
	*f.order = append(*f.order, "AssignProcessToJobObject")
	return f.assignErr
}

func (f *fakeWindowsPrimitives) Resume(_ context.Context, _ suspendedProcessOwnership) error {
	f.resumeCalls++
	*f.order = append(*f.order, "ResumeThread")
	return f.resumeErr
}

func (f *fakeWindowsPrimitives) VerifyActive(_ context.Context, _ suspendedProcessOwnership, _ jobOwnership) (int, error) {
	f.verifyActiveCalls++
	*f.order = append(*f.order, "verify active process and job")
	return 1, f.verifyActiveErr
}

func (f *fakeWindowsPrimitives) ReopenAndVerifyActive(_ context.Context, name string, process ProcessIdentity) (jobOwnership, int, error) {
	f.reopenCalls++
	*f.order = append(*f.order, "reopen and verify active job")
	f.cleanupJobName = name
	f.cleanupProcess = process
	if f.reopenErr != nil {
		return jobOwnership{}, 0, f.reopenErr
	}
	job := f.reopenJob
	if job.handle == 0 {
		job = jobOwnership{name: name, handle: 31, inheritable: false, limitFlags: jobObjectLimitKillOnJobClose}
	}
	members := f.reopenMembers
	if members == 0 {
		members = 1
	}
	return job, members, nil
}

func (f *fakeWindowsPrimitives) TerminateAndVerifyEmpty(_ context.Context, name string, _ jobOwnership, process ProcessIdentity) (int, error) {
	*f.order = append(*f.order, "TerminateJobObject and observe zero members")
	f.cleanupJobName = name
	f.cleanupProcess = process
	if name == "" && process.PID == 0 && f.cleanupErr == nil {
		return 0, errors.New("no durable job or process")
	}
	return f.cleanupMembers, f.cleanupErr
}

func (f *fakeWindowsPrimitives) VerifyProcessIdentityGone(_ context.Context, process ProcessIdentity) (bool, error) {
	f.identityGoneCalls++
	f.identityGoneProcess = process
	*f.order = append(*f.order, "verify durable process identity gone")
	return f.identityGone, f.identityGoneErr
}

func (f *fakeWindowsPrimitives) VerifyNoPrivilegedToken(_ context.Context, _ string) (bool, error) {
	*f.order = append(*f.order, "verify privileged-token absence")
	return f.privilegedToken, f.privilegedTokenErr
}

func (f *fakeWindowsPrimitives) CloseProcess(process suspendedProcessOwnership) {
	if process.processHandle == 0 || f.processClosed {
		f.invalidCloseCount++
		return
	}
	f.processClosed = true
	f.closeProcessCount++
	if process.threadHandle != 0 && !f.threadClosed {
		f.threadClosed = true
		f.closeThreadCount++
	}
}

func (f *fakeWindowsPrimitives) ClosePrimaryThread(process suspendedProcessOwnership) {
	if process.threadHandle == 0 || f.threadClosed {
		f.invalidCloseCount++
		return
	}
	f.threadClosed = true
	f.closeThreadCount++
	*f.order = append(*f.order, "close primary thread")
}

func (f *fakeWindowsPrimitives) CloseJob(job jobOwnership) {
	if job.handle == 0 || f.jobClosed {
		f.invalidCloseCount++
		return
	}
	f.jobClosed = true
	f.closeJobCount++
}

type fakeAccountLifecycle struct {
	order            *[]string
	deprovision      elevaccount.AccountEvidence
	verified         elevaccount.AccountEvidence
	deprovisionCount int
}

func (f *fakeAccountLifecycle) Promote(context.Context) (elevaccount.Credential, error) {
	*f.order = append(*f.order, "promote dormant account")
	return elevaccount.Credential{Username: elevaccount.AccountName, Password: "ephemeral"}, nil
}

func (f *fakeAccountLifecycle) Deprovision(context.Context) (elevaccount.AccountEvidence, error) {
	f.deprovisionCount++
	*f.order = append(*f.order, "rotate password, remove Administrators, disable account")
	return f.deprovision, nil
}

func (f *fakeAccountLifecycle) VerifyClean(context.Context) (elevaccount.AccountEvidence, error) {
	*f.order = append(*f.order, "verify account disabled and non-admin")
	return f.verified, nil
}

func TestJobNameIsDeterministicAndLowercase(t *testing.T) {
	got := JobName("ABCDEFAB-1234-4ABC-8DEF-ABCDEFABCDEF", 9)
	want := `Global\Breeze.PAM.abcdefab-1234-4abc-8def-abcdefabcdef.g9`
	if got != want {
		t.Fatalf("JobName = %q, want %q", got, want)
	}
}

func TestApplyOwnsSuspendedProcessInNonEscapableJobBeforeResume(t *testing.T) {
	var order []string
	store := &recordingLifetimeStore{Store: NewStore(filepath.Join(t.TempDir(), "ledger.json")), order: &order}
	win := &fakeWindowsPrimitives{order: &order}
	account := &fakeAccountLifecycle{order: &order}
	var emitted []ResultState
	manager := newLifecycleManager(store, win, account, func(result Result) {
		order = append(order, "emit "+string(result.State))
		emitted = append(emitted, result.State)
	})

	result := manager.Apply(context.Background(), validApply(1))

	wantOrder := []string{
		"validate identity/generation/hash/lifetime",
		"persist desired active generation",
		"promote dormant account",
		"CreateProcessAsUser(CREATE_SUSPENDED)",
		"CreateJobObjectW(" + JobName(testActuationID, 1) + ")",
		"SetInformationJobObject(KILL_ON_JOB_CLOSE)",
		"AssignProcessToJobObject",
		"persist process identity",
		"emit received",
		"ResumeThread",
		"close primary thread",
		"verify active process and job",
		"emit verified_active",
	}
	if !reflect.DeepEqual(order, wantOrder) {
		t.Fatalf("apply order =\n%q\nwant\n%q", order, wantOrder)
	}
	if result.State != ResultVerifiedActive || !reflect.DeepEqual(emitted, []ResultState{ResultReceived, ResultVerifiedActive}) {
		t.Fatalf("result/emissions = %+v / %v", result, emitted)
	}
	if win.job.inheritable {
		t.Fatal("Job Object handle must be non-inheritable")
	}
	if win.job.limitFlags != jobObjectLimitKillOnJobClose {
		t.Fatalf("job flags = %#x, want only KILL_ON_JOB_CLOSE", win.job.limitFlags)
	}
	if win.job.limitFlags&(jobObjectLimitBreakawayOK|jobObjectLimitSilentBreakawayOK) != 0 {
		t.Fatalf("job flags permit breakaway: %#x", win.job.limitFlags)
	}
	if win.launchSpec.creationFlags&createSuspended == 0 || win.launchSpec.creationFlags&createBreakawayFromJob != 0 {
		t.Fatalf("creation flags = %#x, want suspended without breakaway", win.launchSpec.creationFlags)
	}
}

// TestApplyWithReceivedObservationAcknowledgesReceivedBeforeResume pins the
// rc.3 ordering decision: the `received` observation is handed off while the
// target is still suspended, so a handoff the server refuses can be contained by
// never resuming the process at all. The durable identity the observation
// carries (PID, creation time, job name) is fully bound by BindProcess, so
// nothing in the evidence needs the process to be running.
func TestApplyWithReceivedObservationAcknowledgesReceivedBeforeResume(t *testing.T) {
	var order []string
	store := &recordingLifetimeStore{Store: NewStore(filepath.Join(t.TempDir(), "ledger.json")), order: &order}
	win := &fakeWindowsPrimitives{order: &order}
	manager := newLifecycleManager(store, win, &fakeAccountLifecycle{order: &order}, nil)

	result := manager.ApplyWithReceivedObservation(context.Background(), validApply(1), func(received Result) error {
		order = append(order, "handoff received")
		if received.State != ResultReceived || received.ActuationID != testActuationID || received.Generation != 1 {
			t.Fatalf("received handoff = %+v", received)
		}
		if err := uuid.Validate(received.ObservationID); err != nil {
			t.Fatalf("observation id is not canonical UUID: %q: %v", received.ObservationID, err)
		}
		return nil
	})

	wantOrder := []string{
		"validate identity/generation/hash/lifetime",
		"persist desired active generation",
		"promote dormant account",
		"CreateProcessAsUser(CREATE_SUSPENDED)",
		"CreateJobObjectW(" + JobName(testActuationID, 1) + ")",
		"SetInformationJobObject(KILL_ON_JOB_CLOSE)",
		"AssignProcessToJobObject",
		"persist process identity",
		"handoff received",
		"ResumeThread",
		"close primary thread",
		"verify active process and job",
	}
	if !reflect.DeepEqual(order, wantOrder) {
		t.Fatalf("apply handoff order =\n%q\nwant\n%q", order, wantOrder)
	}
	if result.State != ResultVerifiedActive {
		t.Fatalf("result = %+v, want verified_active", result)
	}
}

func TestApplyWithReceivedObservationFailureClosesOwnershipAndMarksUnresolved(t *testing.T) {
	var order []string
	win := &fakeWindowsPrimitives{order: &order}
	account := &fakeAccountLifecycle{order: &order}
	manager := newLifecycleManager(NewStore(filepath.Join(t.TempDir(), "ledger.json")), win, account, nil)

	result := manager.ApplyWithReceivedObservation(context.Background(), validApply(1), func(Result) error {
		return errors.New("durable enqueue failed")
	})

	if result.State != ResultFailed || result.FailureCode != "received_observation_handoff_failed" {
		t.Fatalf("result = %+v, want stable handoff failure", result)
	}
	if win.resumeCalls != 0 {
		t.Fatalf("Resume calls = %d, want 0: a refused handoff must leave the target suspended", win.resumeCalls)
	}
	if win.verifyActiveCalls != 0 {
		t.Fatalf("VerifyActive calls = %d, want 0", win.verifyActiveCalls)
	}
	if win.closeProcessCount != 1 || win.closeThreadCount != 1 || win.closeJobCount != 1 || win.invalidCloseCount != 0 {
		t.Fatalf("close counts process/thread/job/invalid = %d/%d/%d/%d, want 1/1/1/0",
			win.closeProcessCount, win.closeThreadCount, win.closeJobCount, win.invalidCloseCount)
	}
	if account.deprovisionCount != 1 {
		t.Fatalf("deprovision calls = %d, want 1", account.deprovisionCount)
	}
	if manager.Available() || manager.unresolved[testActuationID] != 1 {
		t.Fatalf("failure did not close availability for generation: available=%v unresolved=%v",
			manager.Available(), manager.unresolved)
	}
}

// TestApplyWithReceivedObservationRejectedAcknowledgementUsesDistinctFailureCode
// keeps one failure code from meaning two things. A transport or enqueue outage
// (the agent could not hand the observation over) stays
// received_observation_handoff_failed; a server that answered and refused this
// envelope (stale or rejected) is received_observation_rejected. Containment is
// identical - the process is never resumed - but the operator-facing cause is
// not.
func TestApplyWithReceivedObservationRejectedAcknowledgementUsesDistinctFailureCode(t *testing.T) {
	var order []string
	win := &fakeWindowsPrimitives{order: &order}
	account := &fakeAccountLifecycle{order: &order}
	manager := newLifecycleManager(NewStore(filepath.Join(t.TempDir(), "ledger.json")), win, account, nil)

	result := manager.ApplyWithReceivedObservation(context.Background(), validApply(1), func(Result) error {
		return fmt.Errorf("%w: server classified the received observation as %q", ErrReceivedObservationRejected, "stale")
	})

	if result.State != ResultFailed || result.FailureCode != "received_observation_rejected" {
		t.Fatalf("result = %+v, want failed/received_observation_rejected", result)
	}
	if win.resumeCalls != 0 || win.verifyActiveCalls != 0 {
		t.Fatalf("resume/verify calls = %d/%d, want 0/0", win.resumeCalls, win.verifyActiveCalls)
	}
	if win.closeProcessCount != 1 || win.closeJobCount != 1 || win.invalidCloseCount != 0 {
		t.Fatalf("close counts process/job/invalid = %d/%d/%d, want 1/1/0",
			win.closeProcessCount, win.closeJobCount, win.invalidCloseCount)
	}
	if account.deprovisionCount != 1 {
		t.Fatalf("deprovision calls = %d, want 1", account.deprovisionCount)
	}
	if manager.Available() || manager.unresolved[testActuationID] != 1 {
		t.Fatalf("rejected handoff did not close availability for generation: available=%v unresolved=%v",
			manager.Available(), manager.unresolved)
	}
}

func TestApplyWithReceivedObservationDuplicateDoesNotHandoff(t *testing.T) {
	var order []string
	manager := newLifecycleManager(NewStore(filepath.Join(t.TempDir(), "ledger.json")),
		&fakeWindowsPrimitives{order: &order}, &fakeAccountLifecycle{order: &order}, nil)
	cmd := validApply(1)
	if result := manager.Apply(context.Background(), cmd); result.State != ResultVerifiedActive {
		t.Fatalf("initial apply = %+v", result)
	}
	handoffCalls := 0
	result := manager.ApplyWithReceivedObservation(context.Background(), cmd, func(Result) error {
		handoffCalls++
		return nil
	})
	if result.State != ResultReceived || handoffCalls != 0 {
		t.Fatalf("duplicate result/handoff calls = %+v/%d, want received/0", result, handoffCalls)
	}
}

func TestCleanupPersistsTombstoneBeforeTreeAndVerifiedAccountCleanup(t *testing.T) {
	var order []string
	store := &recordingLifetimeStore{Store: NewStore(filepath.Join(t.TempDir(), "ledger.json")), order: &order}
	win := &fakeWindowsPrimitives{order: &order}
	clean := elevaccount.AccountEvidence{Enabled: false, InAdministrators: false}
	account := &fakeAccountLifecycle{order: &order, deprovision: clean, verified: clean}
	manager := newLifecycleManager(store, win, account, func(result Result) {
		order = append(order, "emit "+string(result.State))
	})

	if result := manager.Apply(context.Background(), validApply(1)); result.State != ResultVerifiedActive {
		t.Fatalf("apply setup failed: %+v", result)
	}
	order = nil
	result := manager.Cleanup(context.Background(), validCleanup(2))

	wantOrder := []string{
		"persist cleanup tombstone",
		"TerminateJobObject and observe zero members",
		"rotate password, remove Administrators, disable account",
		"verify account disabled and non-admin",
		"verify privileged-token absence",
		"clear durable process identity",
		"emit cleaned",
	}
	if !reflect.DeepEqual(order, wantOrder) {
		t.Fatalf("cleanup order =\n%q\nwant\n%q", order, wantOrder)
	}
	if result.State != ResultCleaned || result.Evidence.JobMemberCount == nil || *result.Evidence.JobMemberCount != 0 {
		t.Fatalf("cleanup result = %+v", result)
	}
	if win.cleanupJobName != JobName(testActuationID, 1) {
		t.Fatalf("cleanup job = %q", win.cleanupJobName)
	}
	if win.cleanupProcess.PID != 4242 || !win.cleanupProcess.ProcessCreationTime.Equal(time.Unix(1234, 0).UTC()) {
		t.Fatalf("cleanup process identity = %+v", win.cleanupProcess)
	}
	if win.closeProcessCount != 1 || win.closeThreadCount != 1 || win.closeJobCount != 1 || win.invalidCloseCount != 0 {
		t.Fatalf("successful lifecycle close counts process/thread/job/invalid = %d/%d/%d/%d, want 1/1/1/0",
			win.closeProcessCount, win.closeThreadCount, win.closeJobCount, win.invalidCloseCount)
	}
}

func TestCleanupFailsClosedWhenJobOrEvidenceIsUnverifiable(t *testing.T) {
	cases := []struct {
		name       string
		cleanupErr error
		privileged bool
		verifyErr  error
	}{
		{name: "helper or job ownership lost", cleanupErr: errors.New("job unavailable")},
		{name: "privileged token still present", privileged: true},
		{name: "token state unverifiable", verifyErr: errors.New("token query failed")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var order []string
			store := &recordingLifetimeStore{Store: NewStore(filepath.Join(t.TempDir(), "ledger.json")), order: &order}
			win := &fakeWindowsPrimitives{order: &order, cleanupErr: tc.cleanupErr, privilegedToken: tc.privileged, privilegedTokenErr: tc.verifyErr}
			clean := elevaccount.AccountEvidence{Enabled: false, InAdministrators: false}
			manager := newLifecycleManager(store, win, &fakeAccountLifecycle{order: &order, deprovision: clean, verified: clean}, nil)
			if got := manager.Apply(context.Background(), validApply(1)); got.State != ResultVerifiedActive {
				t.Fatalf("apply setup failed: %+v", got)
			}
			if got := manager.Cleanup(context.Background(), validCleanup(2)); got.State != ResultFailed {
				t.Fatalf("cleanup = %+v, want failed", got)
			}
			entry, ok := store.Entry(testActuationID)
			if !ok || entry.DesiredState != DesiredCleanup {
				t.Fatalf("cleanup tombstone lost: %+v, %v", entry, ok)
			}
		})
	}
}

func TestV2WindowsImplementationDoesNotUseConsentOrSendInputProof(t *testing.T) {
	for _, name := range []string{"manager_windows.go", "job_windows.go"} {
		raw, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		lower := strings.ToLower(string(raw))
		if strings.Contains(lower, "sendinput") || strings.Contains(lower, "consent.exe") {
			t.Fatalf("%s couples v2 proof to SendInput/consent.exe", name)
		}
	}
}

func TestEveryManagerResultCarriesStableBootIDThroughJSONRoundTrip(t *testing.T) {
	assertRoundTrip := func(result Result) {
		t.Helper()
		if result.Evidence.BootID != "windows-boot-42" {
			t.Fatalf("%s bootId = %q, want stable current boot id", result.State, result.Evidence.BootID)
		}
		raw, err := json.Marshal(result)
		if err != nil {
			t.Fatal(err)
		}
		var roundTrip Result
		if err := json.Unmarshal(raw, &roundTrip); err != nil {
			t.Fatal(err)
		}
		if roundTrip.Evidence.BootID == "" {
			t.Fatalf("wire roundtrip omitted required evidence.bootId: %s", raw)
		}
	}

	var order []string
	failingWin := &fakeWindowsPrimitives{order: &order, bootID: "windows-boot-42", validateErr: errors.New("rejected")}
	failingManager := newLifecycleManager(NewStore(filepath.Join(t.TempDir(), "ledger.json")), failingWin,
		&fakeAccountLifecycle{order: &order}, nil)
	assertRoundTrip(failingManager.Apply(context.Background(), validApply(1)))

	order = nil
	win := &fakeWindowsPrimitives{order: &order, bootID: "windows-boot-42"}
	clean := elevaccount.AccountEvidence{Enabled: false, InAdministrators: false}
	var observed []Result
	manager := newLifecycleManager(NewStore(filepath.Join(t.TempDir(), "ledger.json")), win,
		&fakeAccountLifecycle{order: &order, deprovision: clean, verified: clean}, func(result Result) {
			observed = append(observed, result)
		})
	assertRoundTrip(manager.Apply(context.Background(), validApply(1)))
	assertRoundTrip(manager.Cleanup(context.Background(), validCleanup(2)))
	for _, result := range observed {
		assertRoundTrip(result)
	}
}

func TestCleanupOnlyGenerationOneVerifiesAbsenceWithoutInventedJob(t *testing.T) {
	var order []string
	clean := elevaccount.AccountEvidence{Enabled: false, InAdministrators: false}
	win := &fakeWindowsPrimitives{order: &order}
	manager := newLifecycleManager(NewStore(filepath.Join(t.TempDir(), "ledger.json")), win,
		&fakeAccountLifecycle{order: &order, deprovision: clean, verified: clean}, nil)

	for attempt := 1; attempt <= 2; attempt++ {
		result := manager.Cleanup(context.Background(), validCleanup(1))
		if result.State != ResultCleaned {
			t.Fatalf("cleanup-only attempt %d = %+v, want verified cleaned", attempt, result)
		}
	}
	if win.cleanupJobName != "" || win.cleanupProcess.PID != 0 {
		t.Fatalf("cleanup-only denial invented process ownership: job=%q process=%+v", win.cleanupJobName, win.cleanupProcess)
	}
	if win.invalidCloseCount != 0 || win.closeProcessCount != 0 || win.closeJobCount != 0 {
		t.Fatalf("cleanup-only closed nonexistent ownership: invalid/process/job=%d/%d/%d",
			win.invalidCloseCount, win.closeProcessCount, win.closeJobCount)
	}
}

func TestApplyAndCleanupSerializeWithoutPIDZeroTombstone(t *testing.T) {
	var order []string
	started := make(chan struct{})
	release := make(chan struct{})
	clean := elevaccount.AccountEvidence{Enabled: false, InAdministrators: false}
	win := &fakeWindowsPrimitives{order: &order, createStarted: started, blockCreate: release}
	store := NewStore(filepath.Join(t.TempDir(), "ledger.json"))
	manager := newLifecycleManager(store, win, &fakeAccountLifecycle{order: &order, deprovision: clean, verified: clean}, nil)

	applyDone := make(chan Result, 1)
	go func() { applyDone <- manager.Apply(context.Background(), validApply(1)) }()
	<-started
	cleanupDone := make(chan Result, 1)
	go func() { cleanupDone <- manager.Cleanup(context.Background(), validCleanup(2)) }()
	select {
	case result := <-cleanupDone:
		t.Fatalf("cleanup interleaved before apply ownership was durable: %+v", result)
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	if result := <-applyDone; result.State != ResultVerifiedActive {
		t.Fatalf("apply = %+v", result)
	}
	if result := <-cleanupDone; result.State != ResultCleaned {
		t.Fatalf("cleanup = %+v", result)
	}
	entry, ok := store.Entry(testActuationID)
	if !ok || entry.PID != 0 || entry.ProcessCreationTime != nil || entry.JobName != "" || entry.BootID != "" || entry.DesiredState != DesiredCleanup {
		t.Fatalf("serialized tombstone = %+v, %v", entry, ok)
	}
}

func TestHigherGenerationApplyCannotOverwriteLiveOwnership(t *testing.T) {
	var order []string
	win := &fakeWindowsPrimitives{order: &order}
	store := NewStore(filepath.Join(t.TempDir(), "ledger.json"))
	manager := newLifecycleManager(store, win, &fakeAccountLifecycle{order: &order}, nil)
	if result := manager.Apply(context.Background(), validApply(1)); result.State != ResultVerifiedActive {
		t.Fatalf("initial apply = %+v", result)
	}
	if result := manager.Apply(context.Background(), validApply(2)); result.State != ResultFailed {
		t.Fatalf("higher apply = %+v, want fail-closed", result)
	}
	entry, _ := store.Entry(testActuationID)
	if entry.Generation != 1 || entry.PID != 4242 {
		t.Fatalf("live ownership overwritten: %+v", entry)
	}
}

func TestApplyFailureClosesEachOwnedHandleExactlyOnce(t *testing.T) {
	cases := []struct {
		name        string
		configure   func(*fakeWindowsPrimitives)
		wantProcess int
		wantThread  int
		wantJob     int
	}{
		{"create process", func(f *fakeWindowsPrimitives) { f.createProcessErr = errors.New("process") }, 0, 0, 0},
		{"create job", func(f *fakeWindowsPrimitives) { f.createJobErr = errors.New("job") }, 1, 1, 0},
		{"set limits", func(f *fakeWindowsPrimitives) { f.setJobErr = errors.New("limits") }, 1, 1, 1},
		{"assign", func(f *fakeWindowsPrimitives) { f.assignErr = errors.New("assign") }, 1, 1, 1},
		{"resume", func(f *fakeWindowsPrimitives) { f.resumeErr = errors.New("resume") }, 1, 1, 1},
		{"verify", func(f *fakeWindowsPrimitives) { f.verifyActiveErr = errors.New("verify") }, 1, 1, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var order []string
			win := &fakeWindowsPrimitives{order: &order}
			tc.configure(win)
			manager := newLifecycleManager(NewStore(filepath.Join(t.TempDir(), "ledger.json")), win,
				&fakeAccountLifecycle{order: &order}, nil)
			if result := manager.Apply(context.Background(), validApply(1)); result.State != ResultFailed {
				t.Fatalf("result = %+v", result)
			}
			if win.closeProcessCount != tc.wantProcess || win.closeThreadCount != tc.wantThread || win.closeJobCount != tc.wantJob || win.invalidCloseCount != 0 {
				t.Fatalf("close counts process/thread/job/invalid = %d/%d/%d/%d, want %d/%d/%d/0",
					win.closeProcessCount, win.closeThreadCount, win.closeJobCount, win.invalidCloseCount,
					tc.wantProcess, tc.wantThread, tc.wantJob)
			}
		})
	}
}

func TestTargetHashPinRemainsHeldThroughSuspendedCreation(t *testing.T) {
	var order []string
	win := &fakeWindowsPrimitives{order: &order}
	manager := newLifecycleManager(NewStore(filepath.Join(t.TempDir(), "ledger.json")), win,
		&fakeAccountLifecycle{order: &order}, nil)

	if result := manager.Apply(context.Background(), validApply(1)); result.State != ResultVerifiedActive {
		t.Fatalf("apply = %+v", result)
	}
	if !win.pinTarget || !win.createSawTargetHeld {
		t.Fatalf("target pin not held through CreateSuspended: pin=%v createSawHeld=%v", win.pinTarget, win.createSawTargetHeld)
	}
	if win.targetHeld || win.targetReleaseCount != 1 {
		t.Fatalf("target pin release held/count = %v/%d, want false/1", win.targetHeld, win.targetReleaseCount)
	}
}

func durableActiveEntry(t *testing.T, store *Store, cmd ApplyCommand, process ProcessIdentity) {
	t.Helper()
	if _, err := store.PrepareApply(cmd); err != nil {
		t.Fatalf("prepare active entry: %v", err)
	}
	if err := store.BindProcess(cmd.ActuationID, cmd.Generation, process); err != nil {
		t.Fatalf("bind active process: %v", err)
	}
}

func TestReconcileRestartAdoptsReopenableDesiredActiveJob(t *testing.T) {
	var order []string
	store := NewStore(filepath.Join(t.TempDir(), "ledger.json"))
	process := ProcessIdentity{PID: 4242, ProcessCreationTime: time.Unix(1234, 0).UTC(), JobName: JobName(testActuationID, 1), BootID: "windows-boot-42"}
	durableActiveEntry(t, store, validApply(1), process)
	win := &fakeWindowsPrimitives{order: &order, bootID: "windows-boot-42", reopenMembers: 2}
	manager := newLifecycleManager(store, win, &fakeAccountLifecycle{order: &order}, nil)

	results := manager.Reconcile(context.Background())

	if len(results) != 1 || results[0].State != ResultVerifiedActive || results[0].Evidence.JobMemberCount == nil || *results[0].Evidence.JobMemberCount != 2 {
		t.Fatalf("reconcile results = %+v, want verified active with two job members", results)
	}
	if _, ok := manager.jobs[testActuationID]; !ok {
		t.Fatal("reconciled Job Object ownership was not retained")
	}
}

func TestReconcileCrashClosedJobFailsWithoutClaimingCleaned(t *testing.T) {
	var order []string
	store := NewStore(filepath.Join(t.TempDir(), "ledger.json"))
	process := ProcessIdentity{PID: 4242, ProcessCreationTime: time.Unix(1234, 0).UTC(), JobName: JobName(testActuationID, 1), BootID: "windows-boot-42"}
	durableActiveEntry(t, store, validApply(1), process)
	clean := elevaccount.AccountEvidence{Enabled: false, InAdministrators: false}
	win := &fakeWindowsPrimitives{order: &order, bootID: "windows-boot-42", reopenErr: errors.New("job closed with prior owner")}
	manager := newLifecycleManager(store, win, &fakeAccountLifecycle{order: &order, deprovision: clean, verified: clean}, nil)

	results := manager.Reconcile(context.Background())

	if len(results) != 1 || results[0].State != ResultFailed || results[0].State == ResultCleaned {
		t.Fatalf("reconcile results = %+v, want failed evidence without cleaned claim", results)
	}
	entry, _ := store.Entry(testActuationID)
	if entry.DesiredState != DesiredActive {
		t.Fatalf("crash reconciliation rewrote server desired state: %+v", entry)
	}
}

func TestReconcileFinishesDurableCleanupTombstone(t *testing.T) {
	var order []string
	store := NewStore(filepath.Join(t.TempDir(), "ledger.json"))
	if _, err := store.PrepareCleanup(validCleanup(1)); err != nil {
		t.Fatal(err)
	}
	clean := elevaccount.AccountEvidence{Enabled: false, InAdministrators: false}
	manager := newLifecycleManager(store, &fakeWindowsPrimitives{order: &order}, &fakeAccountLifecycle{order: &order, deprovision: clean, verified: clean}, nil)

	results := manager.Reconcile(context.Background())

	if len(results) != 1 || results[0].State != ResultCleaned {
		t.Fatalf("reconcile results = %+v, want cleaned tombstone", results)
	}
}

func TestReconcileRebootedVanishedProcessRequiresEvidenceNotAutomaticCleaned(t *testing.T) {
	var order []string
	store := NewStore(filepath.Join(t.TempDir(), "ledger.json"))
	process := ProcessIdentity{PID: 4242, ProcessCreationTime: time.Unix(1234, 0).UTC(), JobName: JobName(testActuationID, 1), BootID: "windows-boot-old"}
	durableActiveEntry(t, store, validApply(1), process)
	clean := elevaccount.AccountEvidence{Enabled: false, InAdministrators: false}
	win := &fakeWindowsPrimitives{order: &order, bootID: "windows-boot-new"}
	manager := newLifecycleManager(store, win, &fakeAccountLifecycle{order: &order, deprovision: clean, verified: clean}, nil)

	results := manager.Reconcile(context.Background())

	if len(results) != 1 || results[0].State != ResultFailed || results[0].Evidence.BootID != "windows-boot-new" {
		t.Fatalf("reboot reconcile = %+v, want failed current-boot evidence", results)
	}
	if win.reopenCalls != 0 {
		t.Fatalf("reboot reconciliation reopened a prior-boot job %d times", win.reopenCalls)
	}
}

func TestDisableCleansActiveWorkBeforeReportingDisabled(t *testing.T) {
	var order []string
	store := NewStore(filepath.Join(t.TempDir(), "ledger.json"))
	clean := elevaccount.AccountEvidence{Enabled: false, InAdministrators: false}
	win := &fakeWindowsPrimitives{order: &order}
	manager := newLifecycleManager(store, win, &fakeAccountLifecycle{order: &order, deprovision: clean, verified: clean}, nil)
	if result := manager.Apply(context.Background(), validApply(1)); result.State != ResultVerifiedActive {
		t.Fatalf("apply setup = %+v", result)
	}

	if err := manager.SetEnabled(context.Background(), false); err != nil {
		t.Fatalf("disable: %v", err)
	}
	entry, _ := store.Entry(testActuationID)
	if manager.enabled || entry.DesiredState != DesiredCleanup || entry.Generation != 2 {
		t.Fatalf("disable state enabled=%v entry=%+v", manager.enabled, entry)
	}
}

func TestDisableHelperLossRetainsEnabledFailureAndCleanupTombstone(t *testing.T) {
	var order []string
	store := NewStore(filepath.Join(t.TempDir(), "ledger.json"))
	win := &fakeWindowsPrimitives{order: &order, cleanupErr: errors.New("helper/job ownership unavailable")}
	manager := newLifecycleManager(store, win, &fakeAccountLifecycle{order: &order}, nil)
	if result := manager.Apply(context.Background(), validApply(1)); result.State != ResultVerifiedActive {
		t.Fatalf("apply setup = %+v", result)
	}

	if err := manager.SetEnabled(context.Background(), false); err == nil {
		t.Fatal("disable succeeded without verified tree cleanup")
	}
	entry, _ := store.Entry(testActuationID)
	if !manager.enabled || entry.DesiredState != DesiredCleanup {
		t.Fatalf("failed disable state enabled=%v entry=%+v", manager.enabled, entry)
	}
}

func TestDisableClosesApplyAdmissionBeforeCleanupProof(t *testing.T) {
	var order []string
	store := NewStore(filepath.Join(t.TempDir(), "ledger.json"))
	manager := newLifecycleManager(store, &fakeWindowsPrimitives{order: &order}, &fakeAccountLifecycle{order: &order}, nil)
	if err := manager.SetEnabled(context.Background(), false); err != nil {
		t.Fatalf("disable empty manager: %v", err)
	}
	cmd := validApply(1)
	cmd.ActuationID = "20000000-0000-4000-8000-000000000001"

	result := manager.Apply(context.Background(), cmd)

	if result.State != ResultFailed || result.FailureCode != "pam_disabled" {
		t.Fatalf("apply while disabled = %+v, want pam_disabled", result)
	}
	if _, ok := store.Entry(cmd.ActuationID); ok {
		t.Fatal("disabled apply wrote a durable active row")
	}
}

func TestDisableWithoutLedgerRowsStillRequiresVerifiedAccountCleanup(t *testing.T) {
	var order []string
	manager := newLifecycleManager(NewStore(filepath.Join(t.TempDir(), "ledger.json")),
		&fakeWindowsPrimitives{order: &order},
		&fakeAccountLifecycle{order: &order, verified: elevaccount.AccountEvidence{Enabled: true}}, nil)

	err := manager.SetEnabled(context.Background(), false)

	if err == nil {
		t.Fatal("disable reported success without proving the dormant account clean")
	}
	if !manager.enabled || manager.admissionOpen {
		t.Fatalf("failed disable enabled/admission = %v/%v, want retained enabled with closed admission", manager.enabled, manager.admissionOpen)
	}
}

func TestUnverifiableReconcileClosesNewApplyAdmission(t *testing.T) {
	var order []string
	store := NewStore(filepath.Join(t.TempDir(), "ledger.json"))
	process := ProcessIdentity{PID: 4242, ProcessCreationTime: time.Unix(1234, 0).UTC(), JobName: JobName(testActuationID, 1), BootID: "windows-boot-42"}
	durableActiveEntry(t, store, validApply(1), process)
	win := &fakeWindowsPrimitives{order: &order, reopenErr: errors.New("job unavailable")}
	manager := newLifecycleManager(store, win,
		&fakeAccountLifecycle{order: &order, verified: elevaccount.AccountEvidence{Enabled: true}}, nil)
	if results := manager.Reconcile(context.Background()); len(results) != 1 || results[0].State != ResultFailed || manager.Available() {
		t.Fatalf("unverifiable reconcile = %+v available=%v", results, manager.Available())
	}
	cmd := validApply(1)
	cmd.ActuationID = "20000000-0000-4000-8000-000000000001"

	result := manager.Apply(context.Background(), cmd)

	if result.State != ResultFailed || result.FailureCode != "pam_unavailable" {
		t.Fatalf("apply after unverifiable reconcile = %+v, want pam_unavailable", result)
	}
	if _, ok := store.Entry(cmd.ActuationID); ok {
		t.Fatal("unavailable apply wrote a durable active row")
	}
}

func TestUnrelatedCleanupCannotReopenAdmissionPastUnverifiableActiveReconcile(t *testing.T) {
	var order []string
	store := NewStore(filepath.Join(t.TempDir(), "ledger.json"))
	process := ProcessIdentity{PID: 4242, ProcessCreationTime: time.Unix(1234, 0).UTC(), JobName: JobName(testActuationID, 1), BootID: "windows-boot-42"}
	durableActiveEntry(t, store, validApply(1), process)
	dirty := elevaccount.AccountEvidence{Enabled: true, InAdministrators: true}
	account := &fakeAccountLifecycle{order: &order, deprovision: dirty, verified: dirty}
	win := &fakeWindowsPrimitives{order: &order, reopenErr: errors.New("job unavailable")}
	manager := newLifecycleManager(store, win, account, nil)
	if results := manager.Reconcile(context.Background()); len(results) != 1 || results[0].State != ResultFailed || manager.Available() {
		t.Fatalf("unverifiable active reconcile = %+v available=%v", results, manager.Available())
	}

	clean := elevaccount.AccountEvidence{Enabled: false, InAdministrators: false}
	account.deprovision = clean
	account.verified = clean
	unrelated := CleanupCommand{ProtocolVersion: 2,
		ActuationID: "20000000-0000-4000-8000-000000000001", Generation: 1,
		RequestID: "20000000-0000-4000-8000-000000000002", DeviceID: "20000000-0000-4000-8000-000000000003", OrgID: "20000000-0000-4000-8000-000000000004"}
	if result := manager.Cleanup(context.Background(), unrelated); result.State != ResultCleaned {
		t.Fatalf("unrelated cleanup = %+v", result)
	}
	if manager.Available() {
		t.Fatal("unrelated cleanup reopened availability past unverifiable active reconciliation")
	}
	apply := validApply(1)
	apply.ActuationID = "30000000-0000-4000-8000-000000000001"
	if result := manager.Apply(context.Background(), apply); result.State != ResultFailed || result.FailureCode != "pam_unavailable" {
		t.Fatalf("apply past active reconciliation blocker = %+v", result)
	}

	win.reopenErr = nil
	win.reopenMembers = 1
	if results := manager.Reconcile(context.Background()); len(results) != 2 || results[0].State != ResultVerifiedActive {
		t.Fatalf("verified-active retry = %+v", results)
	}
	if !manager.Available() {
		t.Fatal("same-actuation verified retry did not clear its reconciliation blocker")
	}
}

func TestUnrelatedCleanupCannotClearCancelledReconciliationBlocker(t *testing.T) {
	var order []string
	store := NewStore(filepath.Join(t.TempDir(), "ledger.json"))
	process := ProcessIdentity{PID: 4242, ProcessCreationTime: time.Unix(1234, 0).UTC(), JobName: JobName(testActuationID, 1), BootID: "windows-boot-42"}
	durableActiveEntry(t, store, validApply(1), process)
	unrelated := CleanupCommand{ProtocolVersion: 2,
		ActuationID: "20000000-0000-4000-8000-000000000001", Generation: 1,
		RequestID: "20000000-0000-4000-8000-000000000002", DeviceID: "20000000-0000-4000-8000-000000000003", OrgID: "20000000-0000-4000-8000-000000000004"}
	if _, err := store.PrepareCleanup(unrelated); err != nil {
		t.Fatalf("prepare unrelated cleanup: %v", err)
	}
	clean := elevaccount.AccountEvidence{Enabled: false, InAdministrators: false}
	manager := newLifecycleManager(store, &fakeWindowsPrimitives{order: &order},
		&fakeAccountLifecycle{order: &order, deprovision: clean, verified: clean}, nil)
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if results := manager.Reconcile(cancelled); len(results) != 2 || manager.Available() {
		t.Fatalf("cancelled reconcile = %+v available=%v", results, manager.Available())
	}

	if result := manager.Cleanup(context.Background(), unrelated); result.State != ResultCleaned {
		t.Fatalf("unrelated cleanup retry = %+v", result)
	}
	if manager.Available() {
		t.Fatal("unrelated cleanup cleared another actuation's cancelled reconciliation blocker")
	}
}

func TestVerifiedActiveReconcileCannotClearNewerTimedOutCleanupGeneration(t *testing.T) {
	var order []string
	store := NewStore(filepath.Join(t.TempDir(), "ledger.json"))
	process := ProcessIdentity{PID: 4242, ProcessCreationTime: time.Unix(1234, 0).UTC(), JobName: JobName(testActuationID, 1), BootID: "windows-boot-42"}
	durableActiveEntry(t, store, validApply(1), process)
	manager := newLifecycleManager(store,
		&fakeWindowsPrimitives{order: &order, reopenMembers: 1}, &fakeAccountLifecycle{order: &order}, nil)
	manager.recordCleanupOutcome(testActuationID, manager.failed(testActuationID, 2, "windows-boot-42", "operation_timeout"))

	results := manager.Reconcile(context.Background())

	if len(results) != 1 || results[0].State != ResultVerifiedActive {
		t.Fatalf("verified-active reconcile = %+v", results)
	}
	if manager.Available() || manager.unresolved[testActuationID] != 2 {
		t.Fatalf("generation-1 proof cleared generation-2 ambiguity: available=%v unresolved=%v", manager.Available(), manager.unresolved)
	}
}

func TestDisableCleansEveryDurableLedgerRow(t *testing.T) {
	var order []string
	store := NewStore(filepath.Join(t.TempDir(), "ledger.json"))
	first := validCleanup(1)
	second := CleanupCommand{ProtocolVersion: 2,
		ActuationID: "20000000-0000-4000-8000-000000000001",
		Generation:  1,
		RequestID:   "20000000-0000-4000-8000-000000000002",
		DeviceID:    "20000000-0000-4000-8000-000000000003",
		OrgID:       "20000000-0000-4000-8000-000000000004"}
	for _, cmd := range []CleanupCommand{first, second} {
		if _, err := store.PrepareCleanup(cmd); err != nil {
			t.Fatalf("prepare cleanup row %s: %v", cmd.ActuationID, err)
		}
	}
	clean := elevaccount.AccountEvidence{Enabled: false, InAdministrators: false}
	var cleaned []string
	manager := newLifecycleManager(store, &fakeWindowsPrimitives{order: &order},
		&fakeAccountLifecycle{order: &order, deprovision: clean, verified: clean}, func(result Result) {
			if result.State == ResultCleaned {
				cleaned = append(cleaned, result.ActuationID)
			}
		})

	if err := manager.SetEnabled(context.Background(), false); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if len(cleaned) != 2 {
		t.Fatalf("cleaned rows = %v, want both ledger rows", cleaned)
	}
}

func TestCleanupDurablyClearsDestroyedJobIdentityBeforeCleaned(t *testing.T) {
	var order []string
	path := filepath.Join(t.TempDir(), "ledger.json")
	store := &recordingLifetimeStore{Store: NewStore(path), order: &order}
	clean := elevaccount.AccountEvidence{Enabled: false, InAdministrators: false}
	manager := newLifecycleManager(store, &fakeWindowsPrimitives{order: &order},
		&fakeAccountLifecycle{order: &order, deprovision: clean, verified: clean}, nil)
	if result := manager.Apply(context.Background(), validApply(1)); result.State != ResultVerifiedActive {
		t.Fatalf("apply setup = %+v", result)
	}

	result := manager.Cleanup(context.Background(), validCleanup(2))

	if result.State != ResultCleaned {
		t.Fatalf("cleanup = %+v", result)
	}
	entry, _ := store.Entry(testActuationID)
	if entry.DesiredState != DesiredCleanup || entry.Generation != 2 || entry.PID != 0 || entry.ProcessCreationTime != nil || entry.JobName != "" || entry.BootID != "" {
		t.Fatalf("clean tombstone retained destroyed ownership: %+v", entry)
	}
}

func TestRestartAfterCleanedTombstoneReverifiesWithoutReopeningDestroyedJob(t *testing.T) {
	var order []string
	path := filepath.Join(t.TempDir(), "ledger.json")
	clean := elevaccount.AccountEvidence{Enabled: false, InAdministrators: false}
	firstWin := &fakeWindowsPrimitives{order: &order}
	first := newLifecycleManager(NewStore(path), firstWin,
		&fakeAccountLifecycle{order: &order, deprovision: clean, verified: clean}, nil)
	if result := first.Apply(context.Background(), validApply(1)); result.State != ResultVerifiedActive {
		t.Fatalf("apply setup = %+v", result)
	}
	if result := first.Cleanup(context.Background(), validCleanup(2)); result.State != ResultCleaned {
		t.Fatalf("cleanup setup = %+v", result)
	}

	order = nil
	restartWin := &fakeWindowsPrimitives{order: &order}
	restarted := newLifecycleManager(NewStore(path), restartWin,
		&fakeAccountLifecycle{order: &order, deprovision: clean, verified: clean}, nil)
	results := restarted.Reconcile(context.Background())

	if len(results) != 1 || results[0].State != ResultCleaned {
		t.Fatalf("restart reconcile = %+v", results)
	}
	if restartWin.reopenCalls != 0 || restartWin.cleanupJobName != "" {
		t.Fatalf("restart reopened destroyed ownership: reopen=%d job=%q", restartWin.reopenCalls, restartWin.cleanupJobName)
	}
}

func TestCleanupIdentityPersistenceFailureDoesNotClaimCleaned(t *testing.T) {
	var order []string
	store := &recordingLifetimeStore{Store: NewStore(filepath.Join(t.TempDir(), "ledger.json")), order: &order,
		clearErr: errors.New("disk unavailable")}
	clean := elevaccount.AccountEvidence{Enabled: false, InAdministrators: false}
	manager := newLifecycleManager(store, &fakeWindowsPrimitives{order: &order},
		&fakeAccountLifecycle{order: &order, deprovision: clean, verified: clean}, nil)
	if result := manager.Apply(context.Background(), validApply(1)); result.State != ResultVerifiedActive {
		t.Fatalf("apply setup = %+v", result)
	}

	result := manager.Cleanup(context.Background(), validCleanup(2))

	if result.State != ResultFailed || result.FailureCode != "persist_cleanup_evidence_failed" {
		t.Fatalf("cleanup = %+v, want persistence failure", result)
	}
	entry, _ := store.Entry(testActuationID)
	if entry.PID == 0 || entry.JobName == "" || entry.ProcessCreationTime == nil {
		t.Fatalf("persistence failure erased ownership in memory: %+v", entry)
	}
	if manager.Available() || manager.admissionOpen {
		t.Fatalf("persistence ambiguity left manager available/admitting: %v/%v", manager.Available(), manager.admissionOpen)
	}
}

func TestDirectCleanupFailurePoisonsCrossActuationApplyUntilEveryRetryVerifies(t *testing.T) {
	var order []string
	store := NewStore(filepath.Join(t.TempDir(), "ledger.json"))
	dirty := elevaccount.AccountEvidence{Enabled: true, InAdministrators: true}
	account := &fakeAccountLifecycle{order: &order, deprovision: dirty, verified: dirty}
	manager := newLifecycleManager(store, &fakeWindowsPrimitives{order: &order}, account, nil)
	first := validCleanup(1)
	second := CleanupCommand{ProtocolVersion: 2,
		ActuationID: "20000000-0000-4000-8000-000000000001", Generation: 1,
		RequestID: "20000000-0000-4000-8000-000000000002", DeviceID: "20000000-0000-4000-8000-000000000003", OrgID: "20000000-0000-4000-8000-000000000004"}
	for _, cmd := range []CleanupCommand{first, second} {
		if result := manager.Cleanup(context.Background(), cmd); result.State != ResultFailed {
			t.Fatalf("dirty cleanup %s = %+v", cmd.ActuationID, result)
		}
	}
	if manager.Available() || manager.admissionOpen || len(manager.unresolved) != 2 {
		t.Fatalf("ambiguity state available/admission/unresolved = %v/%v/%v", manager.Available(), manager.admissionOpen, manager.unresolved)
	}
	apply := validApply(1)
	apply.ActuationID = "30000000-0000-4000-8000-000000000001"
	if result := manager.Apply(context.Background(), apply); result.FailureCode != "pam_unavailable" {
		t.Fatalf("cross-actuation apply = %+v", result)
	}
	if err := manager.SetEnabled(context.Background(), true); err == nil {
		t.Fatal("SetEnabled(true) reopened unresolved manager")
	}

	clean := elevaccount.AccountEvidence{Enabled: false, InAdministrators: false}
	account.deprovision = clean
	account.verified = clean
	if result := manager.Cleanup(context.Background(), first); result.State != ResultCleaned {
		t.Fatalf("first retry = %+v", result)
	}
	if manager.Available() || len(manager.unresolved) != 1 {
		t.Fatalf("one unresolved row restored availability: available=%v unresolved=%v", manager.Available(), manager.unresolved)
	}
	if result := manager.Cleanup(context.Background(), second); result.State != ResultCleaned {
		t.Fatalf("second retry = %+v", result)
	}
	if !manager.Available() || len(manager.unresolved) != 0 {
		t.Fatalf("all retries did not restore proof: available=%v unresolved=%v", manager.Available(), manager.unresolved)
	}
	if err := manager.SetEnabled(context.Background(), true); err != nil {
		t.Fatalf("SetEnabled(true) after proof: %v", err)
	}
}

func TestDisabledPolicyRetryStillResolvesLaterDirectCleanupAmbiguity(t *testing.T) {
	var order []string
	clean := elevaccount.AccountEvidence{Enabled: false, InAdministrators: false}
	account := &fakeAccountLifecycle{order: &order, deprovision: clean, verified: clean}
	manager := newLifecycleManager(NewStore(filepath.Join(t.TempDir(), "ledger.json")),
		&fakeWindowsPrimitives{order: &order}, account, nil)
	if err := manager.SetEnabled(context.Background(), false); err != nil {
		t.Fatalf("initial disable: %v", err)
	}

	dirty := elevaccount.AccountEvidence{Enabled: true, InAdministrators: true}
	account.deprovision = dirty
	account.verified = dirty
	if result := manager.Cleanup(context.Background(), validCleanup(1)); result.State != ResultFailed {
		t.Fatalf("direct cleanup ambiguity = %+v", result)
	}
	if manager.Available() || len(manager.unresolved) != 1 {
		t.Fatalf("ambiguity state available/unresolved = %v/%v", manager.Available(), manager.unresolved)
	}

	account.deprovision = clean
	account.verified = clean
	if err := manager.SetEnabled(context.Background(), false); err != nil {
		t.Fatalf("disabled-policy retry: %v", err)
	}
	if !manager.Available() || len(manager.unresolved) != 0 {
		t.Fatalf("retry did not retain disabled/verified state: available=%v unresolved=%v", manager.Available(), manager.unresolved)
	}
	if manager.enabled || manager.admissionOpen {
		t.Fatalf("retry reopened disabled policy: enabled/admission=%v/%v", manager.enabled, manager.admissionOpen)
	}
}

func TestOlderCleanupProofCannotClearNewerUnresolvedGeneration(t *testing.T) {
	var order []string
	manager := newLifecycleManager(NewStore(filepath.Join(t.TempDir(), "ledger.json")),
		&fakeWindowsPrimitives{order: &order}, &fakeAccountLifecycle{order: &order}, nil)
	newerFailure := manager.failed(testActuationID, 3, "windows-boot-42", "operation_timeout")
	manager.recordCleanupOutcome(testActuationID, newerFailure)
	manager.recordCleanupOutcome(testActuationID, manager.result(testActuationID, 2, ResultCleaned, ResultEvidence{}))

	if manager.Available() || manager.unresolved[testActuationID] != 3 {
		t.Fatalf("older proof cleared newer ambiguity: available=%v unresolved=%v", manager.Available(), manager.unresolved)
	}
	manager.recordCleanupOutcome(testActuationID, manager.result(testActuationID, 3, ResultCleaned, ResultEvidence{}))
	if !manager.Available() || len(manager.unresolved) != 0 {
		t.Fatalf("matching proof did not clear ambiguity: available=%v unresolved=%v", manager.Available(), manager.unresolved)
	}
}

func TestLegacyActuationLeaseSerializesDisableAndHonorsCancellation(t *testing.T) {
	var order []string
	clean := elevaccount.AccountEvidence{Enabled: false, InAdministrators: false}
	manager := newLifecycleManager(NewStore(filepath.Join(t.TempDir(), "ledger.json")),
		&fakeWindowsPrimitives{order: &order}, &fakeAccountLifecycle{order: &order, deprovision: clean, verified: clean}, nil)
	release, err := manager.AcquireLegacyActuation(context.Background())
	if err != nil {
		t.Fatalf("acquire lease: %v", err)
	}
	disableDone := make(chan error, 1)
	go func() { disableDone <- manager.SetEnabled(context.Background(), false) }()
	select {
	case err := <-disableDone:
		t.Fatalf("disable crossed in-flight legacy actuation: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	release()
	if err := <-disableDone; err != nil {
		t.Fatalf("disable after release: %v", err)
	}

	blockedRelease, err := manager.AcquireLegacyActuation(context.Background())
	if err == nil {
		blockedRelease()
		t.Fatal("disabled manager granted legacy lease")
	}

	manager.mu.Lock()
	manager.enabled = true
	manager.admissionOpen = true
	manager.available = true
	manager.mu.Unlock()
	release, err = manager.AcquireLegacyActuation(context.Background())
	if err != nil {
		t.Fatalf("second acquire: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	result := manager.Cleanup(ctx, validCleanup(1))
	if result.State != ResultFailed || result.FailureCode != "operation_timeout" || ctx.Err() != context.DeadlineExceeded {
		t.Fatalf("cancelled cleanup = %+v ctx=%v", result, ctx.Err())
	}
	release()
}
