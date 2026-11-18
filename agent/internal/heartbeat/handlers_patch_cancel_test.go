package heartbeat

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/patching"
)

// TestHandleCancelRebootOutcomes is #10186 at the command layer: cancelling
// when nothing is pending is the outcome the caller asked for, so it completes
// (cancelled:false + a reason) instead of shipping a red "no reboot scheduled"
// failure into the device's activity.
func TestHandleCancelRebootOutcomes(t *testing.T) {
	cases := []struct {
		name          string
		setup         func(t *testing.T, h *Heartbeat)
		wantCancelled bool
		wantReason    string
	}{
		{
			name:       "nothing pending",
			setup:      func(*testing.T, *Heartbeat) {},
			wantReason: cancelRebootReasonNothingScheduled,
		},
		{
			name: "pending",
			setup: func(t *testing.T, h *Heartbeat) {
				if err := h.rebootMgr.Schedule(time.Hour, time.Time{}, "Patch", "patch_job"); err != nil {
					t.Fatalf("Schedule: %v", err)
				}
			},
			wantCancelled: true,
		},
		{
			name: "already cancelled",
			setup: func(t *testing.T, h *Heartbeat) {
				if err := h.rebootMgr.Schedule(time.Hour, time.Time{}, "Patch", "patch_job"); err != nil {
					t.Fatalf("Schedule: %v", err)
				}
				if res := handleCancelReboot(h, Command{}); res.Status != "completed" {
					t.Fatalf("first cancel: status = %q (%s)", res.Status, res.Error)
				}
			},
			wantReason: cancelRebootReasonNothingScheduled,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newTestHeartbeatWithRebootManager(t)
			tc.setup(t, h)

			res := handleCancelReboot(h, Command{})
			if res.Status != "completed" || res.ExitCode != 0 {
				t.Fatalf("status = %q exit = %d (%s), want completed/0", res.Status, res.ExitCode, res.Error)
			}
			got := scheduleRebootResultMap(t, res.Stdout)
			if got["cancelled"] != tc.wantCancelled {
				t.Errorf("cancelled = %v, want %v", got["cancelled"], tc.wantCancelled)
			}
			reason, hasReason := got["reason"]
			if tc.wantReason == "" && hasReason {
				t.Errorf("reason = %v on a real cancellation, want it absent", reason)
			}
			if tc.wantReason != "" && reason != tc.wantReason {
				t.Errorf("reason = %v, want %q", reason, tc.wantReason)
			}
			if h.rebootMgr.State().RebootScheduled {
				t.Error("a reboot is still scheduled after cancel_reboot")
			}
		})
	}
}

// TestCancelRebootResultKeepsRealFailuresRed: only "nothing to cancel" becomes
// a success. An OS countdown that could not be aborted, or a shutdown already
// being handed to the OS, means the machine may still go down — those must
// stay failures with their message intact.
func TestCancelRebootResultKeepsRealFailuresRed(t *testing.T) {
	cases := []struct {
		name          string
		err           error
		wantStatus    string
		wantCancelled any
	}{
		{name: "cancelled", err: nil, wantStatus: "completed", wantCancelled: true},
		{name: "nothing scheduled", err: patching.ErrNoRebootScheduled, wantStatus: "completed", wantCancelled: false},
		{name: "nothing scheduled, wrapped", err: fmt.Errorf("cancel: %w", patching.ErrNoRebootScheduled), wantStatus: "completed", wantCancelled: false},
		{name: "abort failed", err: errors.New("reboot schedule cleared, but the OS countdown could not be aborted: exit 1"), wantStatus: "failed"},
		{name: "mid-invocation", err: errors.New("the restart command is being handed to the operating system and can no longer be cancelled"), wantStatus: "failed"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := cancelRebootResult(tc.err, 0)
			if res.Status != tc.wantStatus {
				t.Fatalf("status = %q (%s), want %q", res.Status, res.Error, tc.wantStatus)
			}
			if tc.wantStatus == "failed" {
				if res.Error != tc.err.Error() {
					t.Errorf("error = %q, want %q", res.Error, tc.err.Error())
				}
				return
			}
			got := scheduleRebootResultMap(t, res.Stdout)
			if got["cancelled"] != tc.wantCancelled {
				t.Errorf("cancelled = %v, want %v", got["cancelled"], tc.wantCancelled)
			}
		})
	}
}

func TestHandleCancelRebootWithoutManagerFails(t *testing.T) {
	res := handleCancelReboot(&Heartbeat{}, Command{})
	if res.Status != "failed" {
		t.Fatalf("status = %q, want failed when no reboot manager exists", res.Status)
	}
}
