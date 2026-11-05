package oemupdates

import (
	"context"
	"errors"
	"testing"
	"time"
)

func noSleep(t *testing.T) *[]time.Duration {
	t.Helper()
	var waits []time.Duration
	prev := resumeSleep
	resumeSleep = func(ctx context.Context, d time.Duration) error { waits = append(waits, d); return ctx.Err() }
	t.Cleanup(func() { resumeSleep = prev })
	return &waits
}

func addPending(t *testing.T, f *runFixture, commandID string, after time.Time) {
	t.Helper()
	if err := addPendingVerification(f.store, PendingVerification{
		CommandID: commandID, VerifyAfter: after, BiosVersionBefore: "1.20.0", CreatedAt: after,
	}); err != nil {
		t.Fatal(err)
	}
}

func pendingIDs(t *testing.T, f *runFixture) []string {
	t.Helper()
	list, err := readPendingVerifications(f.store)
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, len(list))
	for _, p := range list {
		ids = append(ids, p.CommandID)
	}
	return ids
}

// suspend → update → reboot → verify: the post-reboot report is posted once,
// retried with backoff while the route answers 404.
func TestResumeVerifiesBitlockerAndBios(t *testing.T) {
	waits := noSleep(t)
	f := newRunFixture(t)
	ended := f.clock.Now()
	addPending(t, f, testCommandID, ended)
	f.sys.boot = ended.Add(10 * time.Minute)
	f.sys.bios = "1.21.0"
	f.prot.state = BitLockerOn
	var sent []Verification
	calls := 0
	report := func(v Verification) error {
		calls++
		if calls <= 2 {
			return ErrVerificationNotFound
		}
		sent = append(sent, v)
		return nil
	}
	if err := ResumePending(context.Background(), f.deps, report); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 1 {
		t.Fatalf("sent %d verifications, want 1", len(sent))
	}
	v := sent[0]
	if v.CommandID != testCommandID || v.BitlockerAfter != BitLockerOn || v.BiosVersionAfter == nil || *v.BiosVersionAfter != "1.21.0" {
		t.Fatalf("verification = %+v", v)
	}
	if err := v.Validate(); err != nil {
		t.Fatal(err)
	}
	if len(*waits) != 2 || (*waits)[1] <= (*waits)[0] {
		t.Fatalf("waits = %v, want two growing backoffs", *waits)
	}
	if ids := pendingIDs(t, f); len(ids) != 0 {
		t.Fatalf("pending after success = %v", ids)
	}
	if err := ResumePending(context.Background(), f.deps, report); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 1 {
		t.Fatal("a second start posted the verification again")
	}
}

func TestResumeWaitsForTheReboot(t *testing.T) {
	noSleep(t)
	f := newRunFixture(t)
	ended := f.clock.Now()
	addPending(t, f, testCommandID, ended)
	f.sys.boot = ended.Add(-time.Hour) // the agent restarted, the machine did not
	posted := false
	if err := ResumePending(context.Background(), f.deps, func(Verification) error { posted = true; return nil }); err != nil {
		t.Fatal(err)
	}
	if posted {
		t.Fatal("verified before the reboot: BitLocker would read suspended")
	}
	if ids := pendingIDs(t, f); len(ids) != 1 {
		t.Fatal("pending verification dropped")
	}
}

// Decision 8: a volume still suspended after the reboot is reported, and the
// agent changes nothing.
func TestStillSuspendedIsReportedNotChanged(t *testing.T) {
	noSleep(t)
	f := newRunFixture(t)
	ended := f.clock.Now()
	addPending(t, f, testCommandID, ended)
	f.sys.boot = ended.Add(5 * time.Minute)
	f.prot.state = BitLockerSuspended
	var got Verification
	if err := ResumePending(context.Background(), f.deps, func(v Verification) error { got = v; return nil }); err != nil {
		t.Fatal(err)
	}
	if got.BitlockerAfter != BitLockerSuspended {
		t.Fatalf("reported %q", got.BitlockerAfter)
	}
	if len(f.exec.Calls()) != 0 {
		t.Fatal("the agent ran something to change BitLocker")
	}
}

func TestRecoverInterruptedClosesTheMarker(t *testing.T) {
	f := newRunFixture(t)
	started := f.clock.Now().Add(-time.Hour)
	_ = WriteMarker(f.store, Marker{CommandID: testCommandID, Lane: LaneDell, StartedAt: started, Stage: StageInstalling, FlashStarted: true})
	if err := RecoverInterrupted(f.deps); err != nil {
		t.Fatal(err)
	}
	m, err := ReadMarker(f.store)
	if err != nil || m.EndedAt == nil || m.Outcome != OutcomeInterrupted {
		t.Fatalf("marker = %+v, %v", m, err)
	}
	if _, ok := ReadInterruptedMarker(f.store); ok {
		t.Fatal("still reads as interrupted")
	}
}

func TestRecoverInterruptedLeavesALiveRunAlone(t *testing.T) {
	f := newRunFixture(t)
	_ = WriteMarker(f.store, Marker{CommandID: testCommandID, Lane: LaneDell, StartedAt: f.clock.Now(), Stage: StageInstalling})
	release, err := AcquireRunLock(f.store)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	_ = RecoverInterrupted(f.deps)
	if _, ok := ReadInterruptedMarker(f.store); !ok {
		t.Fatal("closed the marker of a run that holds the lock")
	}
}

// A transient failure keeps the verification for the next start; only an
// accepted or rejected report, or old age, ends it.
func TestTransientFailureKeepsVerificationPending(t *testing.T) {
	noSleep(t)
	f := newRunFixture(t)
	ended := f.clock.Now()
	addPending(t, f, testCommandID, ended)
	f.sys.boot = ended.Add(time.Minute)
	calls := 0
	err := ResumePending(context.Background(), f.deps, func(Verification) error { calls++; return errors.New("offline") })
	if err == nil || calls != maxVerifyAttemptsPerStart {
		t.Fatalf("calls=%d err=%v, want %d attempts and an error", calls, err, maxVerifyAttemptsPerStart)
	}
	if ids := pendingIDs(t, f); len(ids) != 1 {
		t.Fatal("a transient failure dropped the verification")
	}
}

func TestOldVerificationIsDropped(t *testing.T) {
	noSleep(t)
	f := newRunFixture(t)
	ended := f.clock.Now().Add(-maxVerifyAge - time.Hour)
	addPending(t, f, testCommandID, ended)
	f.sys.boot = ended.Add(time.Minute)
	posted := false
	_ = ResumePending(context.Background(), f.deps, func(Verification) error { posted = true; return nil })
	if posted || len(pendingIDs(t, f)) != 0 {
		t.Fatalf("posted=%v pending=%v, want an aged-out verification dropped unsent", posted, pendingIDs(t, f))
	}
}

func TestResumeStopsOnRejection(t *testing.T) {
	noSleep(t)
	f := newRunFixture(t)
	ended := f.clock.Now()
	addPending(t, f, testCommandID, ended)
	f.sys.boot = ended.Add(time.Minute)
	calls := 0
	_ = ResumePending(context.Background(), f.deps, func(Verification) error { calls++; return ErrVerificationRejected })
	if calls != 1 || len(pendingIDs(t, f)) != 0 {
		t.Fatalf("calls = %d pending=%v; a rejected report is not retried", calls, pendingIDs(t, f))
	}
}

func TestStateIsReadForEachAttempt(t *testing.T) {
	noSleep(t)
	f := newRunFixture(t)
	ended := f.clock.Now()
	addPending(t, f, testCommandID, ended)
	f.sys.boot = ended.Add(time.Minute)
	f.prot.state = BitLockerSuspended
	var last Verification
	calls := 0
	_ = ResumePending(context.Background(), f.deps, func(v Verification) error {
		calls++
		last = v
		if calls == 1 {
			f.prot.state = BitLockerOn // protection came back meanwhile
			return ErrVerificationNotFound
		}
		return nil
	})
	if last.BitlockerAfter != BitLockerOn {
		t.Fatalf("reported %q, want the fresh reading", last.BitlockerAfter)
	}
}

// Verification never rewrites the run marker, so a run that starts while a
// report is backing off keeps its own marker.
func TestVerificationDoesNotClobberANewRun(t *testing.T) {
	noSleep(t)
	f := newRunFixture(t)
	ended := f.clock.Now()
	addPending(t, f, testCommandID, ended)
	f.sys.boot = ended.Add(time.Minute)
	const newCommand = "11111111-2222-4333-8444-555555555555"
	calls := 0
	_ = ResumePending(context.Background(), f.deps, func(Verification) error {
		calls++
		if calls == 1 {
			_ = WriteMarker(f.store, Marker{CommandID: newCommand, Lane: LaneDell, StartedAt: f.clock.Now(), Stage: StageInstalling})
			addPending(t, f, newCommand, f.clock.Now().Add(time.Hour))
			return ErrVerificationNotFound
		}
		return nil
	})
	if m, ok := ReadInterruptedMarker(f.store); !ok || m.CommandID != newCommand {
		t.Fatalf("the new run's marker was overwritten: %+v", m)
	}
	if ids := pendingIDs(t, f); len(ids) != 1 || ids[0] != newCommand {
		t.Fatalf("pending = %v, want only the new run's", ids)
	}
}

func TestPendingVerificationsAreBounded(t *testing.T) {
	f := newRunFixture(t)
	base := f.clock.Now()
	for i := 0; i < maxPendingVerifications+3; i++ {
		id := "00000000-0000-4000-8000-00000000000" + string(rune('a'+i))
		addPending(t, f, id, base.Add(time.Duration(i)*time.Minute))
	}
	ids := pendingIDs(t, f)
	if len(ids) != maxPendingVerifications || ids[len(ids)-1] != "00000000-0000-4000-8000-00000000000"+string(rune('a'+maxPendingVerifications+2)) {
		t.Fatalf("pending = %v, want the newest %d", ids, maxPendingVerifications)
	}
}

func TestResumeWithNothingPendingDoesNothing(t *testing.T) {
	f := newRunFixture(t)
	if err := ResumePending(context.Background(), f.deps, func(Verification) error { t.Fatal("posted"); return nil }); err != nil {
		t.Fatal(err)
	}
}
