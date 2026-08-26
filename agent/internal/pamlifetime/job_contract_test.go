package pamlifetime

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/elevaccount"
)

type recordingLifetimeStore struct {
	*Store
	order *[]string
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

type fakeWindowsPrimitives struct {
	order               *[]string
	launchSpec          suspendedLaunchSpec
	job                 jobOwnership
	cleanupProcess      ProcessIdentity
	cleanupJobName      string
	cleanupErr          error
	privilegedToken     bool
	privilegedTokenErr  error
	bootID              string
	validateErr         error
	createProcessErr    error
	createJobErr        error
	setJobErr           error
	assignErr           error
	resumeErr           error
	verifyActiveErr     error
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
	*f.order = append(*f.order, "ResumeThread")
	return f.resumeErr
}

func (f *fakeWindowsPrimitives) VerifyActive(_ context.Context, _ suspendedProcessOwnership, _ jobOwnership) (int, error) {
	*f.order = append(*f.order, "verify active process and job")
	return 1, f.verifyActiveErr
}

func (f *fakeWindowsPrimitives) TerminateAndVerifyEmpty(_ context.Context, name string, _ jobOwnership, process ProcessIdentity) (int, error) {
	*f.order = append(*f.order, "TerminateJobObject and observe zero members")
	f.cleanupJobName = name
	f.cleanupProcess = process
	if name == "" && process.PID == 0 && f.cleanupErr == nil {
		return 0, errors.New("no durable job or process")
	}
	return 0, f.cleanupErr
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
	order       *[]string
	deprovision elevaccount.AccountEvidence
	verified    elevaccount.AccountEvidence
}

func (f *fakeAccountLifecycle) Promote(context.Context) (elevaccount.Credential, error) {
	*f.order = append(*f.order, "promote dormant account")
	return elevaccount.Credential{Username: elevaccount.AccountName, Password: "ephemeral"}, nil
}

func (f *fakeAccountLifecycle) Deprovision(context.Context) (elevaccount.AccountEvidence, error) {
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
		"ResumeThread",
		"emit received",
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
	if !ok || entry.PID != 4242 || entry.DesiredState != DesiredCleanup {
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
