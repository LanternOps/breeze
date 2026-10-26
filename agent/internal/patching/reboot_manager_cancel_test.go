package patching

import (
	"errors"
	"testing"
	"time"
)

// TestCancelOutcomes pins what Cancel reports for every state a cancel_reboot
// command can land in (#10186).
//
// "Nothing to cancel" is ErrNoRebootScheduled, a sentinel the command handler
// turns into a successful result: the caller wanted the restart off and it is
// off. Every other refusal — an OS countdown that could not be aborted, a
// shutdown command mid-flight — is a different error, because there the
// machine may still go down and reporting success would be a lie.
func TestCancelOutcomes(t *testing.T) {
	abortFails := errors.New("no cancel flag on this platform")

	cases := []struct {
		name string
		// setup drives the manager into the state under test. aborts counts
		// abortOSReboot calls; abortErr is what it returns.
		setup    func(t *testing.T, rm *RebootManager, timers *fakeTimers)
		abortErr error
		// wantNothing: Cancel must return exactly the sentinel.
		wantNothing bool
		// wantErr: Cancel must fail with something that is NOT the sentinel.
		wantErr    bool
		wantAborts int
	}{
		{
			name:        "never scheduled",
			setup:       func(*testing.T, *RebootManager, *fakeTimers) {},
			wantNothing: true,
		},
		{
			name: "pending, before the OS countdown",
			setup: func(t *testing.T, rm *RebootManager, _ *fakeTimers) {
				mustSchedule(t, rm, 30*time.Minute)
			},
		},
		{
			name: "already fired: OS countdown live",
			setup: func(t *testing.T, rm *RebootManager, timers *fakeTimers) {
				mustSchedule(t, rm, 5*time.Minute)
				timers.runAt(PlanReboot(5 * time.Minute).OSInvokeAt)
			},
			wantAborts: 1,
		},
		{
			name: "already fired: OS countdown live and the abort fails",
			setup: func(t *testing.T, rm *RebootManager, timers *fakeTimers) {
				mustSchedule(t, rm, 5*time.Minute)
				timers.runAt(PlanReboot(5 * time.Minute).OSInvokeAt)
			},
			abortErr:   abortFails,
			wantErr:    true,
			wantAborts: 1,
		},
		{
			name: "already fired: the OS command failed, nothing is pending",
			setup: func(t *testing.T, rm *RebootManager, timers *fakeTimers) {
				rm.execOSReboot = func(time.Duration) error { return errors.New("shutdown binary missing") }
				mustSchedule(t, rm, 5*time.Minute)
				timers.runAt(PlanReboot(5 * time.Minute).OSInvokeAt)
			},
			wantNothing: true,
		},
		{
			name: "already cancelled",
			setup: func(t *testing.T, rm *RebootManager, _ *fakeTimers) {
				mustSchedule(t, rm, 30*time.Minute)
				if err := rm.Cancel(); err != nil {
					t.Fatalf("first Cancel: %v", err)
				}
			},
			wantNothing: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rm, timers, _, _ := newTestManager(t, 3)
			aborts := 0
			rm.abortOSReboot = func() error {
				aborts++
				return tc.abortErr
			}
			tc.setup(t, rm, timers)

			err := rm.Cancel()
			switch {
			case tc.wantNothing:
				if !errors.Is(err, ErrNoRebootScheduled) {
					t.Fatalf("Cancel = %v, want ErrNoRebootScheduled", err)
				}
			case tc.wantErr:
				if err == nil {
					t.Fatal("Cancel = nil, want a failure: the OS countdown is still running")
				}
				if errors.Is(err, ErrNoRebootScheduled) {
					t.Fatalf("Cancel = %v reads as \"nothing to cancel\", which the handler reports as success while the machine still reboots", err)
				}
			default:
				if err != nil {
					t.Fatalf("Cancel = %v, want nil", err)
				}
			}
			if aborts != tc.wantAborts {
				t.Errorf("abortOSReboot called %d time(s), want %d", aborts, tc.wantAborts)
			}
			if rm.State().RebootScheduled {
				t.Error("RebootScheduled=true after Cancel")
			}
		})
	}
}

func mustSchedule(t *testing.T, rm *RebootManager, delay time.Duration) {
	t.Helper()
	if err := rm.Schedule(delay, time.Time{}, "Patch install", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
}
