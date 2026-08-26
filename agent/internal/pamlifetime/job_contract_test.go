package pamlifetime

import (
	"context"
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
	order              *[]string
	launchSpec         suspendedLaunchSpec
	job                jobOwnership
	cleanupProcess     ProcessIdentity
	cleanupJobName     string
	cleanupErr         error
	privilegedToken    bool
	privilegedTokenErr error
}

func (f *fakeWindowsPrimitives) ValidateTarget(_ context.Context, path string, expectedHash *string) (string, string, error) {
	*f.order = append(*f.order, "validate identity/generation/hash/lifetime")
	if path == "" {
		return "", "", errors.New("empty path")
	}
	hash := strings.Repeat("a", 64)
	if expectedHash != nil && !strings.EqualFold(*expectedHash, hash) {
		return "", "", errors.New("hash mismatch")
	}
	return path, hash, nil
}

func (f *fakeWindowsPrimitives) CreateSuspended(_ context.Context, spec suspendedLaunchSpec) (suspendedProcessOwnership, error) {
	f.launchSpec = spec
	*f.order = append(*f.order, "CreateProcessAsUser(CREATE_SUSPENDED)")
	return suspendedProcessOwnership{
		Identity: ProcessIdentity{
			PID:                 4242,
			ProcessCreationTime: time.Unix(1234, 0).UTC(),
			WindowsSessionID:    7,
			TargetHash:          strings.Repeat("a", 64),
		},
		processHandle: 11,
		threadHandle:  12,
	}, nil
}

func (f *fakeWindowsPrimitives) CreateJob(_ context.Context, name string) (jobOwnership, error) {
	*f.order = append(*f.order, "CreateJobObjectW("+name+")")
	f.job = jobOwnership{name: name, handle: 21, inheritable: false}
	return f.job, nil
}

func (f *fakeWindowsPrimitives) SetJobLimits(_ context.Context, job jobOwnership, flags uint32) error {
	*f.order = append(*f.order, "SetInformationJobObject(KILL_ON_JOB_CLOSE)")
	f.job = job
	f.job.limitFlags = flags
	return nil
}

func (f *fakeWindowsPrimitives) AssignProcess(_ context.Context, _ jobOwnership, _ suspendedProcessOwnership) error {
	*f.order = append(*f.order, "AssignProcessToJobObject")
	return nil
}

func (f *fakeWindowsPrimitives) Resume(_ context.Context, _ suspendedProcessOwnership) error {
	*f.order = append(*f.order, "ResumeThread")
	return nil
}

func (f *fakeWindowsPrimitives) VerifyActive(_ context.Context, _ suspendedProcessOwnership, _ jobOwnership) (int, error) {
	*f.order = append(*f.order, "verify active process and job")
	return 1, nil
}

func (f *fakeWindowsPrimitives) TerminateAndVerifyEmpty(_ context.Context, name string, _ jobOwnership, process ProcessIdentity) (int, error) {
	*f.order = append(*f.order, "TerminateJobObject and observe zero members")
	f.cleanupJobName = name
	f.cleanupProcess = process
	return 0, f.cleanupErr
}

func (f *fakeWindowsPrimitives) VerifyNoPrivilegedToken(_ context.Context, _ string) (bool, error) {
	*f.order = append(*f.order, "verify privileged-token absence")
	return f.privilegedToken, f.privilegedTokenErr
}

func (f *fakeWindowsPrimitives) CloseProcess(suspendedProcessOwnership)       {}
func (f *fakeWindowsPrimitives) ClosePrimaryThread(suspendedProcessOwnership) {}
func (f *fakeWindowsPrimitives) CloseJob(jobOwnership)                        {}

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
