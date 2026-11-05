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

func pendingMarker(f *runFixture, ended time.Time) Marker {
	return Marker{
		CommandID: testCommandID, Lane: LaneDell, Trigger: TriggerScheduled,
		StartedAt: ended.Add(-30 * time.Minute), Stage: StageInstalling, FlashStarted: true,
		EndedAt: &ended, Outcome: OutcomeSuccessRebootRequired, BiosVersionBefore: "1.20.0", VerifyPending: true,
	}
}

// suspend → update → reboot → verify: the post-reboot report is posted once,
// retried with backoff while the route answers 404.
func TestResumeVerifiesBitlockerAndBios(t *testing.T) {
	waits := noSleep(t)
	f := newRunFixture(t)
	ended := f.clock.Now()
	if err := WriteMarker(f.store, pendingMarker(f, ended)); err != nil {
		t.Fatal(err)
	}
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
	_ = WriteMarker(f.store, pendingMarker(f, ended))
	f.sys.boot = ended.Add(-time.Hour) // the agent restarted, the machine did not
	posted := false
	if err := ResumePending(context.Background(), f.deps, func(Verification) error { posted = true; return nil }); err != nil {
		t.Fatal(err)
	}
	if posted {
		t.Fatal("verified before the reboot: BitLocker would read suspended")
	}
	if m, _ := ReadMarker(f.store); !m.VerifyPending {
		t.Fatal("pending verification dropped")
	}
}

// Decision 8: a volume still suspended after the reboot is reported, and the
// agent changes nothing.
func TestStillSuspendedIsReportedNotChanged(t *testing.T) {
	noSleep(t)
	f := newRunFixture(t)
	ended := f.clock.Now()
	_ = WriteMarker(f.store, pendingMarker(f, ended))
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

func TestResumeClosesAnInterruptedMarker(t *testing.T) {
	noSleep(t)
	f := newRunFixture(t)
	started := f.clock.Now().Add(-time.Hour)
	_ = WriteMarker(f.store, Marker{CommandID: testCommandID, Lane: LaneDell, StartedAt: started, Stage: StageInstalling, FlashStarted: true})
	f.sys.boot = started.Add(-time.Hour)
	if err := ResumePending(context.Background(), f.deps, func(Verification) error { return nil }); err != nil {
		t.Fatal(err)
	}
	m, err := ReadMarker(f.store)
	if err != nil || m.EndedAt == nil || m.Outcome != OutcomeInterrupted || !m.VerifyPending {
		t.Fatalf("marker = %+v, %v", m, err)
	}
	if _, ok := ReadInterruptedMarker(f.store); ok {
		t.Fatal("still reads as interrupted")
	}
}

func TestInterruptedDriverRunNeedsNoVerification(t *testing.T) {
	noSleep(t)
	f := newRunFixture(t)
	_ = WriteMarker(f.store, Marker{CommandID: testCommandID, Lane: LaneDell, StartedAt: f.clock.Now(), Stage: StageInstalling})
	f.sys.boot = f.clock.Now().Add(time.Minute)
	posted := false
	_ = ResumePending(context.Background(), f.deps, func(Verification) error { posted = true; return nil })
	if posted {
		t.Fatal("a driver-only run was verified")
	}
}

func TestResumeGivesUpAfterBoundedAttempts(t *testing.T) {
	noSleep(t)
	f := newRunFixture(t)
	ended := f.clock.Now()
	_ = WriteMarker(f.store, pendingMarker(f, ended))
	f.sys.boot = ended.Add(time.Minute)
	calls := 0
	err := ResumePending(context.Background(), f.deps, func(Verification) error { calls++; return errors.New("offline") })
	if err == nil || calls != maxVerifyAttempts {
		t.Fatalf("calls=%d err=%v, want %d attempts and an error", calls, err, maxVerifyAttempts)
	}
	if m, _ := ReadMarker(f.store); m.VerifyPending {
		t.Fatal("a verification that cannot be delivered must not retry forever")
	}
}

func TestResumeStopsOnRejection(t *testing.T) {
	noSleep(t)
	f := newRunFixture(t)
	ended := f.clock.Now()
	_ = WriteMarker(f.store, pendingMarker(f, ended))
	f.sys.boot = ended.Add(time.Minute)
	calls := 0
	_ = ResumePending(context.Background(), f.deps, func(Verification) error { calls++; return ErrVerificationRejected })
	if calls != 1 {
		t.Fatalf("calls = %d, a rejected report is not retried", calls)
	}
}

func TestResumeWithNoMarkerDoesNothing(t *testing.T) {
	f := newRunFixture(t)
	if err := ResumePending(context.Background(), f.deps, func(Verification) error { t.Fatal("posted"); return nil }); err != nil {
		t.Fatal(err)
	}
}
