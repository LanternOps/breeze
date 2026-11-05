package bitlockerguard

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/security"
)

type memStore struct {
	mu        sync.Mutex
	files     map[string][]byte
	failWrite error
}

func newMemStore() *memStore { return &memStore{files: map[string][]byte{}} }

func (s *memStore) ReadFile(name string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, ok := s.files[name]
	if !ok {
		return nil, fs.ErrNotExist
	}
	return append([]byte(nil), data...), nil
}

func (s *memStore) WriteFile(name string, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failWrite != nil {
		return s.failWrite
	}
	s.files[name] = append([]byte(nil), data...)
	return nil
}

func (s *memStore) Remove(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.files, name)
	return nil
}

// volume is a fake OS volume. Suspend and resume change its state the way the
// cmdlets do, and every call is counted.
type volume struct {
	state       string
	stateErr    error
	suspendErr  error
	suspendNoop bool
	resumeErr   error
	resumeNoop  bool
	suspends    []int
	resumes     int
	protectors  string
	protErr     error
	protCalls   int
	now         time.Time
	boot        time.Time
	bootErr     error
	pending     bool
	pendingErr  error
}

func newVolume() *volume {
	now := time.Date(2027, 1, 20, 1, 0, 0, 0, time.UTC)
	return &volume{state: security.BitLockerStateOn, now: now, boot: now.Add(-48 * time.Hour)}
}

func (v *volume) deps(store Store) Deps {
	return Deps{
		Store: store,
		Now:   func() time.Time { return v.now },
		BootTime: func() (time.Time, error) {
			return v.boot, v.bootErr
		},
		State: func() (string, error) { return v.state, v.stateErr },
		Protectors: func(context.Context) (string, error) {
			v.protCalls++
			return v.protectors, v.protErr
		},
		SuspendVolume: func(_ context.Context, count int) error {
			v.suspends = append(v.suspends, count)
			if v.suspendErr != nil {
				return v.suspendErr
			}
			if !v.suspendNoop {
				v.state = security.BitLockerStateSuspended
			}
			return nil
		},
		ResumeVolume: func(context.Context) error {
			v.resumes++
			if v.resumeErr != nil {
				return v.resumeErr
			}
			if !v.resumeNoop {
				v.state = security.BitLockerStateOn
			}
			return nil
		},
		RebootPending: func() (bool, error) { return v.pending, v.pendingErr },
	}
}

// afterReboot moves the machine to a boot that happened after the suspend, past
// the settle time, with no reboot still flagged.
func (v *volume) afterReboot() {
	v.boot = v.now.Add(time.Hour)
	v.now = v.boot.Add(settleAfterBoot)
}

func mustSuspend(t *testing.T, v *volume, store Store) Token {
	t.Helper()
	tok, err := Suspend(context.Background(), MinRebootCount, v.deps(store))
	if err != nil {
		t.Fatalf("Suspend: %v", err)
	}
	if !tok.Active() {
		t.Fatal("a volume that was on must give an active token")
	}
	return tok
}

func mustInstalling(t *testing.T, v *volume, store Store, tok Token) {
	t.Helper()
	if err := MarkInstalling(tok, v.deps(store)); err != nil {
		t.Fatalf("MarkInstalling: %v", err)
	}
}

func recordGone(t *testing.T, store *memStore) {
	t.Helper()
	if _, err := store.ReadFile(recordFile); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("record kept: %v", err)
	}
}

func recordKept(t *testing.T, store *memStore) {
	t.Helper()
	if _, err := store.ReadFile(recordFile); err != nil {
		t.Fatalf("record lost: %v", err)
	}
}

func TestSuspendZeroRefused(t *testing.T) {
	v, store := newVolume(), newMemStore()
	_, err := Suspend(context.Background(), 0, v.deps(store))
	if !errors.Is(err, ErrRebootCount) {
		t.Fatalf("err = %v, want ErrRebootCount: 0 means suspended indefinitely", err)
	}
	if len(v.suspends) != 0 || len(store.files) != 0 {
		t.Fatalf("a refused count must touch nothing: suspends=%v files=%d", v.suspends, len(store.files))
	}
}

func TestSuspendBelowThreeRefused(t *testing.T) {
	for _, n := range []int{-1, 1, 2} {
		v, store := newVolume(), newMemStore()
		if _, err := Suspend(context.Background(), n, v.deps(store)); !errors.Is(err, ErrRebootCount) {
			t.Errorf("count %d: err = %v, want ErrRebootCount", n, err)
		}
		if len(v.suspends) != 0 {
			t.Errorf("count %d reached the volume", n)
		}
	}
}

func TestSuspendAboveCmdletMaximumRefused(t *testing.T) {
	v, store := newVolume(), newMemStore()
	if _, err := Suspend(context.Background(), 16, v.deps(store)); !errors.Is(err, ErrRebootCount) {
		t.Fatalf("err = %v, want ErrRebootCount: Suspend-BitLocker takes 0 to 15", err)
	}
}

func TestSuspendPassesTheCount(t *testing.T) {
	v, store := newVolume(), newMemStore()
	mustSuspend(t, v, store)
	if len(v.suspends) != 1 || v.suspends[0] != MinRebootCount {
		t.Fatalf("suspends = %v, want [%d]", v.suspends, MinRebootCount)
	}
}

func TestSuspendWritesTheRecordBeforeTheVolumeChanges(t *testing.T) {
	v, store := newVolume(), newMemStore()
	d := v.deps(store)
	inner := d.SuspendVolume
	d.SuspendVolume = func(ctx context.Context, count int) error {
		if _, err := store.ReadFile(recordFile); err != nil {
			t.Errorf("record not durable before the suspend: %v", err)
		}
		return inner(ctx, count)
	}
	if _, err := Suspend(context.Background(), MinRebootCount, d); err != nil {
		t.Fatal(err)
	}
}

func TestSuspendRefusedWhenRecordCannotBeWritten(t *testing.T) {
	v, store := newVolume(), newMemStore()
	store.failWrite = errors.New("disk full")
	_, err := Suspend(context.Background(), MinRebootCount, v.deps(store))
	if err == nil || len(v.suspends) != 0 {
		t.Fatalf("err=%v suspends=%v: no durable record, no suspend", err, v.suspends)
	}
}

func TestSuspendOnAVolumeWithBitLockerOffNeedsNoToken(t *testing.T) {
	v, store := newVolume(), newMemStore()
	v.state = security.BitLockerStateOff
	tok, err := Suspend(context.Background(), MinRebootCount, v.deps(store))
	if err != nil || tok.Active() || len(v.suspends) != 0 || len(store.files) != 0 {
		t.Fatalf("tok=%+v err=%v suspends=%v files=%d", tok, err, v.suspends, len(store.files))
	}
}

func TestSuspendRefusesAnUnknownState(t *testing.T) {
	v, store := newVolume(), newMemStore()
	v.state, v.stateErr = security.BitLockerStateUnknown, errors.New("powershell failed")
	if _, err := Suspend(context.Background(), MinRebootCount, v.deps(store)); !errors.Is(err, ErrStateUnknown) {
		t.Fatalf("err = %v, want ErrStateUnknown", err)
	}
	if len(v.suspends) != 0 {
		t.Fatal("an unknown state must not suspend")
	}
}

// "off with an error" is how the state reader reports a host without the
// module, which may still be encrypted: never read as off.
func TestSuspendReadsAStateErrorAsUnknownEvenWhenItSaysOff(t *testing.T) {
	v, store := newVolume(), newMemStore()
	v.state, v.stateErr = security.BitLockerStateOff, security.ErrBitLockerUnavailable
	tok, err := Suspend(context.Background(), MinRebootCount, v.deps(store))
	if !errors.Is(err, ErrStateUnknown) || tok.Active() {
		t.Fatalf("tok=%+v err=%v, want ErrStateUnknown", tok, err)
	}
}

func TestSuspendFailureLeavesNoRecordWhenTheVolumeStayedOn(t *testing.T) {
	v, store := newVolume(), newMemStore()
	v.suspendErr = errors.New("access denied")
	if _, err := Suspend(context.Background(), MinRebootCount, v.deps(store)); err == nil {
		t.Fatal("want an error")
	}
	recordGone(t, store)
}

func TestSuspendThatDidNotTakeEffectIsAnError(t *testing.T) {
	v, store := newVolume(), newMemStore()
	v.suspendNoop = true
	tok, err := Suspend(context.Background(), MinRebootCount, v.deps(store))
	if !errors.Is(err, ErrSuspendUnconfirmed) || tok.Active() {
		t.Fatalf("tok=%+v err=%v, want ErrSuspendUnconfirmed", tok, err)
	}
	recordGone(t, store)
}

// The cmdlet can report a failure after the volume changed. We own that
// suspension and put it back at once.
func TestSuspendErrorAfterTheVolumeChangedIsResumed(t *testing.T) {
	v, store := newVolume(), newMemStore()
	d := v.deps(store)
	d.SuspendVolume = func(context.Context, int) error {
		v.state = security.BitLockerStateSuspended
		return errors.New("late failure")
	}
	tok, err := Suspend(context.Background(), MinRebootCount, d)
	if err == nil || tok.Active() {
		t.Fatalf("tok=%+v err=%v, want an error and no token", tok, err)
	}
	if v.state != security.BitLockerStateOn || v.resumes != 1 {
		t.Fatalf("state=%s resumes=%d, want it back on", v.state, v.resumes)
	}
	recordGone(t, store)
}

// A state we cannot read after a failed suspend keeps the record: the volume may
// be ours and suspended, so the next pass has to find out.
func TestSuspendErrorWithUnreadableStateKeepsTheRecord(t *testing.T) {
	v, store := newVolume(), newMemStore()
	d := v.deps(store)
	d.SuspendVolume = func(context.Context, int) error {
		v.state, v.stateErr = security.BitLockerStateUnknown, errors.New("powershell failed")
		return errors.New("late failure")
	}
	if _, err := Suspend(context.Background(), MinRebootCount, d); err == nil {
		t.Fatal("want an error")
	}
	recordKept(t, store)
}

func TestSuspendRefusedWhileAnEarlierRecordIsOpen(t *testing.T) {
	v, store := newVolume(), newMemStore()
	mustSuspend(t, v, store)
	v.state = security.BitLockerStateOn
	if _, err := Suspend(context.Background(), MinRebootCount, v.deps(store)); !errors.Is(err, ErrHeld) {
		t.Fatalf("err = %v, want ErrHeld", err)
	}
	if len(v.suspends) != 1 {
		t.Fatalf("suspends = %v", v.suspends)
	}
}

func TestSuspendRefusedOnAnUnreadableRecord(t *testing.T) {
	v, store := newVolume(), newMemStore()
	store.files[recordFile] = []byte("{not json")
	if _, err := Suspend(context.Background(), MinRebootCount, v.deps(store)); err == nil || len(v.suspends) != 0 {
		t.Fatalf("err=%v suspends=%v", err, v.suspends)
	}
}

func fixture(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestPreflightParsesPcr7(t *testing.T) {
	cases := []struct {
		name    string
		output  string
		bound   bool
		unknown bool
	}{
		{"fixture: bound", fixture(t, "manage-bde-pcr7-bound.txt"), true, false},
		{"fixture: not bound", fixture(t, "manage-bde-pcr7-unbound.txt"), false, false},
		{"fixture: localized is unknown", fixture(t, "manage-bde-localized-de.txt"), false, true},
		{"crlf", "Volume C: [OS]\r\nAll Key Protectors\r\n\r\n    TPM:\r\n      ID: {x}\r\n      PCR Validation Profile:\r\n        7, 11\r\n", true, false},
		{"no spaces", "    TPM:\n      PCR Validation Profile:\n        7,11\n", true, false},
		{"17 is not 7", "    TPM:\n      PCR Validation Profile:\n        0, 2, 4, 11, 17\n", false, false},
		{"23 alone is not 7", "    TPM:\n      PCR Validation Profile:\n        23\n", false, false},
		{"7 alone", "    TPM:\n      PCR Validation Profile:\n        7\n", true, false},
		{"empty", "", false, true},
		{"no TPM block", "Volume C: [OS]\nAll Key Protectors\n\n    Numerical Password:\n      ID: {x}\n", false, true},
		{"profile with no values", "    TPM:\n      PCR Validation Profile:\n", false, true},
		{"profile not numeric", "    TPM:\n      PCR Validation Profile:\n        seven, eleven\n", false, true},
		{"partly numeric", "    TPM:\n      PCR Validation Profile:\n        7, x\n", false, true},
		{"out of range", "    TPM:\n      PCR Validation Profile:\n        7, 99\n", false, true},
		{"one of two TPM protectors not bound", "    TPM:\n      PCR Validation Profile:\n        7, 11\n    TPM:\n      PCR Validation Profile:\n        0, 2, 4\n", false, false},
		{"a second profile unreadable", "    TPM:\n      PCR Validation Profile:\n        7, 11\n    TPM:\n      PCR Validation Profile:\n        n/a\n", false, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			v, store := newVolume(), newMemStore()
			v.protectors = c.output
			bound, err := Preflight(context.Background(), v.deps(store))
			if c.unknown {
				if !errors.Is(err, ErrPreflightUnknown) || bound {
					t.Fatalf("bound=%v err=%v, want unknown, failing closed", bound, err)
				}
				return
			}
			if err != nil || bound != c.bound {
				t.Fatalf("bound=%v err=%v, want %v", bound, err, c.bound)
			}
		})
	}
}

// manage-bde's output can carry recovery passwords. No error may repeat it.
func TestPreflightErrorNeverRepeatsTheOutput(t *testing.T) {
	const secret = "111111-222222-333333-444444-555555-666666-777777-888888"
	v, store := newVolume(), newMemStore()
	v.protectors = "    Numerical Password:\n      Password:\n        " + secret + "\n"
	_, err := Preflight(context.Background(), v.deps(store))
	if err == nil {
		t.Fatal("want unknown")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("error repeats the output: %v", err)
	}
}

func TestPreflightFailsClosedWhenManageBdeFails(t *testing.T) {
	v, store := newVolume(), newMemStore()
	v.protectors, v.protErr = fixture(t, "manage-bde-pcr7-bound.txt"), errors.New("exit status 1")
	bound, err := Preflight(context.Background(), v.deps(store))
	if bound || !errors.Is(err, ErrPreflightUnknown) {
		t.Fatalf("bound=%v err=%v", bound, err)
	}
}

func TestPreflightNamesTheVolumeState(t *testing.T) {
	cases := []struct {
		state string
		err   error
		want  error
	}{
		{security.BitLockerStateOff, nil, ErrBitLockerOff},
		{security.BitLockerStateSuspended, nil, ErrAlreadySuspended},
		{security.BitLockerStateUnknown, nil, ErrStateUnknown},
		{security.BitLockerStateOff, security.ErrBitLockerUnavailable, ErrStateUnknown},
	}
	for _, c := range cases {
		v, store := newVolume(), newMemStore()
		v.state, v.stateErr = c.state, c.err
		bound, err := Preflight(context.Background(), v.deps(store))
		if bound || !errors.Is(err, c.want) {
			t.Errorf("state %s: bound=%v err=%v, want %v", c.state, bound, err, c.want)
		}
		if v.protCalls != 0 {
			t.Errorf("state %s: manage-bde ran", c.state)
		}
	}
}

func TestResumeOnlyWhatWeSuspended(t *testing.T) {
	v, store := newVolume(), newMemStore()
	v.state = security.BitLockerStateSuspended // someone else's
	if _, err := Suspend(context.Background(), MinRebootCount, v.deps(store)); !errors.Is(err, ErrAlreadySuspended) {
		t.Fatalf("Suspend: %v, want ErrAlreadySuspended", err)
	}
	recordGone(t, store)
	v.afterReboot()
	v.now = v.now.Add(ResumeDeadline * 2)
	res, err := ResumeOnStart(context.Background(), v.deps(store))
	if err != nil || res.Action != ActionNone {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if v.resumes != 0 || v.state != security.BitLockerStateSuspended {
		t.Fatalf("resumes=%d state=%s: someone else's suspension must stay", v.resumes, v.state)
	}
}

func TestResumeRunsAfterCrash(t *testing.T) {
	v, store := newVolume(), newMemStore()
	tok := mustSuspend(t, v, store)
	mustInstalling(t, v, store, tok)
	// The process is gone. All that is left is the durable record.
	v.afterReboot()
	res, err := ResumeOnStart(context.Background(), v.deps(store))
	if err != nil {
		t.Fatal(err)
	}
	if res.Action != ActionResumed || res.Reason != ReasonRebooted || v.state != security.BitLockerStateOn {
		t.Fatalf("res=%+v state=%s", res, v.state)
	}
	recordGone(t, store)
	// Nothing left to do on the next start.
	if res, _ := ResumeOnStart(context.Background(), v.deps(store)); res.Action != ActionNone || v.resumes != 1 {
		t.Fatalf("second start: %+v resumes=%d", res, v.resumes)
	}
}

func TestResumeRecoversACrashBetweenRecordAndSuspend(t *testing.T) {
	v, store := newVolume(), newMemStore()
	d := v.deps(store)
	d.SuspendVolume = func(context.Context, int) error { panic("crash") }
	func() {
		defer func() { _ = recover() }()
		_, _ = Suspend(context.Background(), MinRebootCount, d)
	}()
	recordKept(t, store)
	v.now = v.now.Add(lateSuspendGrace)
	res, err := ResumeOnStart(context.Background(), v.deps(store))
	if err != nil || res.Action != ActionCleared || v.resumes != 0 {
		t.Fatalf("res=%+v err=%v resumes=%d: the volume never left on", res, err, v.resumes)
	}
	recordGone(t, store)
}

// A killed PowerShell does not cancel the WMI call behind it, so the suspend can
// land after the state read. Without the record that volume would read as someone
// else's and never be resumed.
func TestSuspendThatMayStillLandKeepsTheRecord(t *testing.T) {
	v, store := newVolume(), newMemStore()
	v.suspendErr = fmt.Errorf("%w: timed out", ErrIndeterminate)
	if _, err := Suspend(context.Background(), MinRebootCount, v.deps(store)); !errors.Is(err, ErrIndeterminate) {
		t.Fatalf("err = %v", err)
	}
	recordKept(t, store)

	// Inside the grace the volume reads on, and the record stays open.
	res, err := ResumeOnStart(context.Background(), v.deps(store))
	if err != nil || res.Action != ActionHeld || res.Reason != ReasonSuspendMayLand {
		t.Fatalf("inside the grace: res=%+v err=%v", res, err)
	}
	recordKept(t, store)

	// It landed late: the record proves it is ours.
	v.state = security.BitLockerStateSuspended
	res, err = ResumeOnStart(context.Background(), v.deps(store))
	if err != nil || res.Action != ActionResumed || res.Reason != ReasonNoInstall || v.state != security.BitLockerStateOn {
		t.Fatalf("landed: res=%+v err=%v state=%s", res, err, v.state)
	}
	recordGone(t, store)
}

func TestSuspendThatNeverLandedClosesAfterTheGrace(t *testing.T) {
	v, store := newVolume(), newMemStore()
	v.suspendErr = fmt.Errorf("%w: timed out", ErrIndeterminate)
	if _, err := Suspend(context.Background(), MinRebootCount, v.deps(store)); err == nil {
		t.Fatal("want an error")
	}
	v.now = v.now.Add(lateSuspendGrace)
	res, err := ResumeOnStart(context.Background(), v.deps(store))
	if err != nil || res.Action != ActionCleared || v.resumes != 0 {
		t.Fatalf("res=%+v err=%v resumes=%d", res, err, v.resumes)
	}
	recordGone(t, store)
}

func TestSuspendCancelledByTheContextKeepsTheRecord(t *testing.T) {
	v, store := newVolume(), newMemStore()
	ctx, cancel := context.WithCancel(context.Background())
	d := v.deps(store)
	d.SuspendVolume = func(context.Context, int) error {
		cancel()
		return errors.New("exit status 1")
	}
	if _, err := Suspend(ctx, MinRebootCount, d); err == nil {
		t.Fatal("want an error")
	}
	recordKept(t, store)
}

func TestResumeBeforeAnyInstallStartedNeedsNoReboot(t *testing.T) {
	v, store := newVolume(), newMemStore()
	mustSuspend(t, v, store)
	res, err := ResumeOnStart(context.Background(), v.deps(store))
	if err != nil || res.Action != ActionResumed || res.Reason != ReasonNoInstall {
		t.Fatalf("res=%+v err=%v", res, err)
	}
}

func TestResumeHoldsWhileWaitingForTheReboot(t *testing.T) {
	v, store := newVolume(), newMemStore()
	tok := mustSuspend(t, v, store)
	mustInstalling(t, v, store, tok)
	v.now = v.now.Add(ResumeDeadline - time.Minute)
	res, err := ResumeOnStart(context.Background(), v.deps(store))
	if err != nil || res.Action != ActionHeld || res.Reason != ReasonWaitingForReboot || v.resumes != 0 {
		t.Fatalf("res=%+v err=%v resumes=%d", res, err, v.resumes)
	}
	recordKept(t, store)
}

func TestResumeWhenRebootNeverHappens(t *testing.T) {
	v, store := newVolume(), newMemStore()
	tok := mustSuspend(t, v, store)
	mustInstalling(t, v, store, tok)
	v.now = v.now.Add(ResumeDeadline)
	res, err := ResumeOnStart(context.Background(), v.deps(store))
	if err != nil {
		t.Fatal(err)
	}
	if res.Action != ActionResumed || res.Reason != ReasonDeadline || v.state != security.BitLockerStateOn {
		t.Fatalf("res=%+v state=%s: past the deadline it resumes and says why", res, v.state)
	}
	recordGone(t, store)
}

func TestDeadlineHoldsUnreadableBootTime(t *testing.T) {
	v, store := newVolume(), newMemStore()
	tok := mustSuspend(t, v, store)
	mustInstalling(t, v, store, tok)
	v.bootErr = errors.New("no boot time")
	if res, err := ResumeOnStart(context.Background(), v.deps(store)); err != nil || res.Action != ActionHeld {
		t.Fatalf("before the deadline: res=%+v err=%v", res, err)
	}
	v.now = v.now.Add(ResumeDeadline)
	if res, err := ResumeOnStart(context.Background(), v.deps(store)); err != nil || res.Reason != ReasonDeadline {
		t.Fatalf("past the deadline: res=%+v err=%v", res, err)
	}
}

func TestResumeHoldsWhileAnotherRebootIsFlagged(t *testing.T) {
	v, store := newVolume(), newMemStore()
	tok := mustSuspend(t, v, store)
	mustInstalling(t, v, store, tok)
	v.afterReboot()
	v.pending = true
	res, err := ResumeOnStart(context.Background(), v.deps(store))
	if err != nil || res.Action != ActionHeld || res.Reason != ReasonRebootPending || v.resumes != 0 {
		t.Fatalf("res=%+v err=%v resumes=%d", res, err, v.resumes)
	}
	v.pending, v.pendingErr = false, errors.New("registry denied")
	if res, _ := ResumeOnStart(context.Background(), v.deps(store)); res.Action != ActionHeld || v.resumes != 0 {
		t.Fatalf("an unreadable flag holds: %+v", res)
	}
	// The deadline beats the flag: a flag that never clears cannot keep the
	// volume unprotected.
	v.pending, v.pendingErr = true, nil
	v.now = v.now.Add(ResumeDeadline)
	if res, _ := ResumeOnStart(context.Background(), v.deps(store)); res.Reason != ReasonDeadline {
		t.Fatalf("past the deadline: %+v", res)
	}
}

func TestResumeWaitsForTheBootToSettle(t *testing.T) {
	v, store := newVolume(), newMemStore()
	tok := mustSuspend(t, v, store)
	mustInstalling(t, v, store, tok)
	v.boot = v.now.Add(time.Hour)
	v.now = v.boot.Add(settleAfterBoot - time.Second)
	res, err := ResumeOnStart(context.Background(), v.deps(store))
	if err != nil || res.Action != ActionHeld || res.Reason != ReasonSettling || v.resumes != 0 {
		t.Fatalf("res=%+v err=%v resumes=%d", res, err, v.resumes)
	}
}

func TestResumeClearsTheRecordWhenWindowsAlreadyResumed(t *testing.T) {
	for _, state := range []string{security.BitLockerStateOn, security.BitLockerStateOff} {
		v, store := newVolume(), newMemStore()
		tok := mustSuspend(t, v, store)
		mustInstalling(t, v, store, tok)
		v.afterReboot()
		v.state = state
		res, err := ResumeOnStart(context.Background(), v.deps(store))
		if err != nil || res.Action != ActionCleared || v.resumes != 0 {
			t.Fatalf("%s: res=%+v err=%v resumes=%d", state, res, err, v.resumes)
		}
		recordGone(t, store)
	}
}

func TestResumeKeepsTheRecordOnAnUnreadableState(t *testing.T) {
	v, store := newVolume(), newMemStore()
	tok := mustSuspend(t, v, store)
	mustInstalling(t, v, store, tok)
	v.afterReboot()
	v.state, v.stateErr = security.BitLockerStateUnknown, errors.New("powershell failed")
	res, err := ResumeOnStart(context.Background(), v.deps(store))
	if err == nil || res.Action != ActionHeld || v.resumes != 0 {
		t.Fatalf("res=%+v err=%v resumes=%d", res, err, v.resumes)
	}
	recordKept(t, store)
}

func TestResumeFailureKeepsTheRecordForTheNextTry(t *testing.T) {
	v, store := newVolume(), newMemStore()
	tok := mustSuspend(t, v, store)
	mustInstalling(t, v, store, tok)
	v.afterReboot()
	v.resumeErr = errors.New("access denied")
	if _, err := ResumeOnStart(context.Background(), v.deps(store)); err == nil {
		t.Fatal("want an error")
	}
	recordKept(t, store)
	v.resumeErr = nil
	if res, err := ResumeOnStart(context.Background(), v.deps(store)); err != nil || res.Action != ActionResumed {
		t.Fatalf("res=%+v err=%v", res, err)
	}
}

func TestResumeThatDidNotTakeEffectKeepsTheRecord(t *testing.T) {
	v, store := newVolume(), newMemStore()
	tok := mustSuspend(t, v, store)
	mustInstalling(t, v, store, tok)
	v.afterReboot()
	v.resumeNoop = true
	if _, err := ResumeOnStart(context.Background(), v.deps(store)); !errors.Is(err, ErrResumeUnconfirmed) {
		t.Fatalf("err = %v, want ErrResumeUnconfirmed", err)
	}
	recordKept(t, store)
}

func TestResumeOnAnUnreadableRecordTouchesNothing(t *testing.T) {
	v, store := newVolume(), newMemStore()
	store.files[recordFile] = []byte("{not json")
	v.state = security.BitLockerStateSuspended
	if _, err := ResumeOnStart(context.Background(), v.deps(store)); err == nil || v.resumes != 0 {
		t.Fatalf("err=%v resumes=%d", err, v.resumes)
	}
}

func TestResumeNowPutsBackAToken(t *testing.T) {
	v, store := newVolume(), newMemStore()
	tok := mustSuspend(t, v, store)
	mustInstalling(t, v, store, tok)
	if err := Resume(context.Background(), tok, v.deps(store)); err != nil {
		t.Fatal(err)
	}
	if v.state != security.BitLockerStateOn {
		t.Fatalf("state = %s", v.state)
	}
	recordGone(t, store)
}

// Only a volume with a record is ever resumed, even with a token in hand.
func TestResumeWithAStaleTokenDoesNothing(t *testing.T) {
	v, store := newVolume(), newMemStore()
	tok := mustSuspend(t, v, store)
	if err := store.Remove(recordFile); err != nil {
		t.Fatal(err)
	}
	if err := Resume(context.Background(), tok, v.deps(store)); err != nil || v.resumes != 0 {
		t.Fatalf("err=%v resumes=%d: this suspension is no longer ours", err, v.resumes)
	}
}

// Resume means nothing is staged. If it fails, the next pass must retry soon and
// not hold for a reboot nothing needs.
func TestFailedResumeRetriesWithoutWaitingForAReboot(t *testing.T) {
	v, store := newVolume(), newMemStore()
	tok := mustSuspend(t, v, store)
	mustInstalling(t, v, store, tok)
	v.resumeErr = errors.New("powershell timed out")
	if err := Resume(context.Background(), tok, v.deps(store)); err == nil {
		t.Fatal("want an error")
	}
	v.resumeErr = nil
	res, err := ResumeOnStart(context.Background(), v.deps(store))
	if err != nil || res.Action != ActionResumed || res.Reason != ReasonNoInstall {
		t.Fatalf("res=%+v err=%v", res, err)
	}
}

func TestRebootOwed(t *testing.T) {
	v, store := newVolume(), newMemStore()
	check := func(want bool) {
		t.Helper()
		if got, err := RebootOwed(v.deps(store)); got != want || err != nil {
			t.Fatalf("owed=%v err=%v, want %v", got, err, want)
		}
	}
	check(false) // no record
	tok := mustSuspend(t, v, store)
	check(false) // no install started
	mustInstalling(t, v, store, tok)
	check(true)
	v.bootErr = errors.New("no boot time")
	check(true) // a flash started and nothing shows the reboot happened
	v.bootErr = nil
	v.afterReboot()
	check(false)
	store.files[recordFile] = []byte("{not json")
	if _, err := RebootOwed(v.deps(store)); err == nil {
		t.Fatal("an unreadable record must say so")
	}
}

func TestCommandError(t *testing.T) {
	alive := context.Background()
	if err := commandError(alive, nil, nil); err != nil {
		t.Fatalf("err = %v", err)
	}
	failed := errors.New("exit status 1")
	stderr := &boundedBuffer{limit: 16}
	if _, err := stderr.Write([]byte("access denied\r\n and a lot more text after the limit")); err != nil {
		t.Fatal(err)
	}
	err := commandError(alive, failed, stderr)
	if !errors.Is(err, failed) || errors.Is(err, ErrIndeterminate) || !strings.Contains(err.Error(), "access denied") {
		t.Fatalf("err = %v", err)
	}
	if strings.ContainsAny(err.Error(), "\r\n") {
		t.Fatalf("err = %q: a command's text must not break a log line", err)
	}
	dead, cancel := context.WithCancel(alive)
	cancel()
	if err := commandError(dead, failed, nil); !errors.Is(err, ErrIndeterminate) {
		t.Fatalf("killed by the context: %v", err)
	}
}

func TestBoundedBufferKeepsTheLimitAndSaysSo(t *testing.T) {
	b := &boundedBuffer{limit: 4}
	if n, err := b.Write([]byte("abc")); n != 3 || err != nil || b.overflow {
		t.Fatalf("n=%d err=%v overflow=%v", n, err, b.overflow)
	}
	if n, err := b.Write([]byte("defg")); n != 4 || err != nil || !b.overflow || string(b.data) != "abcd" {
		t.Fatalf("n=%d err=%v overflow=%v data=%q", n, err, b.overflow, b.data)
	}
}

func TestResumeOfAnInactiveTokenDoesNothing(t *testing.T) {
	v, store := newVolume(), newMemStore()
	v.state = security.BitLockerStateSuspended // someone else's
	if err := Resume(context.Background(), Token{}, v.deps(store)); err != nil || v.resumes != 0 {
		t.Fatalf("err=%v resumes=%d", err, v.resumes)
	}
}

func TestMarkInstallingMustBeDurable(t *testing.T) {
	v, store := newVolume(), newMemStore()
	tok := mustSuspend(t, v, store)
	store.failWrite = errors.New("disk full")
	if err := MarkInstalling(tok, v.deps(store)); err == nil {
		t.Fatal("no durable phase, no install")
	}
}

func TestHeld(t *testing.T) {
	v, store := newVolume(), newMemStore()
	if held, err := Held(v.deps(store)); held || err != nil {
		t.Fatalf("no record: held=%v err=%v", held, err)
	}
	mustSuspend(t, v, store)
	if held, err := Held(v.deps(store)); !held || err != nil {
		t.Fatalf("record: held=%v err=%v", held, err)
	}
	store.files[recordFile] = []byte("{not json")
	if _, err := Held(v.deps(store)); err == nil {
		t.Fatal("an unreadable record must say so")
	}
}

func TestSuspendScriptRefusesWhatWouldReachACommandLine(t *testing.T) {
	if got, err := suspendScript("C:", 3); err != nil || !strings.Contains(got, "-MountPoint 'C:' -RebootCount 3 ") {
		t.Fatalf("got %q err=%v", got, err)
	}
	for _, count := range []int{0, 2, 16} {
		if _, err := suspendScript("C:", count); !errors.Is(err, ErrRebootCount) {
			t.Errorf("count %d: %v", count, err)
		}
	}
	for _, drive := range []string{"", "C", "C:\\", "C:'; Remove-Item x; '", "CC:"} {
		if _, err := suspendScript(drive, 3); err == nil {
			t.Errorf("suspend accepted drive %q", drive)
		}
		if _, err := resumeScript(drive); err == nil {
			t.Errorf("resume accepted drive %q", drive)
		}
	}
}

func TestMountPoint(t *testing.T) {
	for in, want := range map[string]string{"": "C:", " ": "C:", "C:": "C:", "d:": "D:"} {
		if got, err := mountPoint(in); err != nil || got != want {
			t.Errorf("%q: got %q err=%v", in, got, err)
		}
	}
	for _, in := range []string{"C", `C:\`, "C:;x", "CC:"} {
		if _, err := mountPoint(in); err == nil {
			t.Errorf("%q accepted", in)
		}
	}
}

func TestManageBdeAsksForTpmProtectorsOnly(t *testing.T) {
	got := strings.Join(manageBdeArgs("C:"), " ")
	if got != "-protectors -get C: -Type TPM" {
		t.Fatalf("args = %q: anything wider prints the recovery password", got)
	}
}

func TestMissingSeamsFailClosed(t *testing.T) {
	if _, err := Suspend(context.Background(), MinRebootCount, Deps{}); err == nil {
		t.Fatal("Suspend with no seams must refuse")
	}
	if bound, err := Preflight(context.Background(), Deps{}); bound || err == nil {
		t.Fatalf("Preflight with no seams: bound=%v err=%v", bound, err)
	}
	if _, err := ResumeOnStart(context.Background(), Deps{}); err == nil {
		t.Fatal("ResumeOnStart with no seams must refuse")
	}
}
