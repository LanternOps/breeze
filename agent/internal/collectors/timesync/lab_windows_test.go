//go:build windows

package timesync

import (
	"context"
	"os"
	"testing"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// These tests change the host's W32Time service and configuration. They run only
// on a disposable workgroup lab host whose W32Time registry key, start type and
// timezone the operator has exported first and restores afterwards (plan Task 7, L7).
func labWriteOptIn(t *testing.T) {
	t.Helper()
	if os.Getenv("TIMESYNC_LAB_WRITE") != "1" {
		t.Skip("explicit lab-only write opt-in required (TIMESYNC_LAB_WRITE=1)")
	}
}
func labW32TimeState(t *testing.T, stop bool) svc.State {
	t.Helper()
	m, err := mgr.Connect()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Disconnect()
	s, err := m.OpenService("W32Time")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if stop {
		if _, err = s.Control(svc.Stop); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 60; i++ {
			if st, e := s.Query(); e == nil && st.State == svc.Stopped {
				break
			}
			time.Sleep(500 * time.Millisecond)
		}
	}
	st, err := s.Query()
	if err != nil {
		t.Fatal(err)
	}
	return st.State
}
func TestLabStartTimeServiceAlreadyRunning(t *testing.T) {
	labWriteOptIn(t)
	if labW32TimeState(t, false) != svc.Running {
		t.Fatal("precondition: start W32Time before this test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if err := startTimeService(ctx); err != nil {
		t.Fatal("already-running W32Time reported as a failed start:", err)
	}
}
func TestLabReconcileFromStoppedService(t *testing.T) {
	labWriteOptIn(t)
	sys := NewSystem()
	if sys == nil {
		t.Fatal("Windows constructor returned nil")
	}
	if labW32TimeState(t, labW32TimeState(t, false) == svc.Running) != svc.Stopped {
		t.Fatal("could not stop W32Time")
	}
	s := settingsFixture()
	r := &Reconciler{Read: func(ctx context.Context) (Observation, error) { return readManagementObservation(ctx, sys, time.Now()) },
		Writer: NewWriter(), Now: time.Now, Save: func(ManagementState) error { return nil },
		State: &ManagementState{Version: 1, Settings: &s}}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	if err := r.Run(ctx, true); err != nil {
		t.Fatal(err)
	}
	got := r.State.Report.NTP
	if got == nil {
		t.Fatal("missing NTP result")
	}
	if got.Outcome != "ok" || got.Reason != "applied" {
		msg := "<nil>"
		if got.Error != nil {
			msg = *got.Error
		}
		t.Fatalf("%s/%s error=%s before=%v after=%v", got.Outcome, got.Reason, msg, got.Before, got.After)
	}
	if labW32TimeState(t, false) != svc.Running {
		t.Fatal("W32Time not running after apply")
	}
	t.Logf("before=%v after=%v", got.Before, got.After)
}
