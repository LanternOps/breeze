package heartbeat

import (
	"testing"
	"time"
)

// deadlineAction (#11065 W06). Absent keeps today's force; "hold" makes the
// deadline the window close; anything else fails the command, so a value this
// agent does not know is never read as "force the restart".

func TestScheduleRebootWithoutADeadlineActionKeepsForce(t *testing.T) {
	h := newTestHeartbeatWithRebootManager(t)
	res := handleScheduleReboot(h, Command{Payload: map[string]any{
		"delayMinutes": float64(15), "reason": "Patch", "source": "patch_job",
	}})
	if res.Status != "completed" {
		t.Fatalf("status = %q (%s)", res.Status, res.Error)
	}
	if got := h.rebootMgr.State().DeadlineAction; got != "" {
		t.Fatalf("DeadlineAction = %q, want empty (force)", got)
	}
	if got := scheduleRebootResultMap(t, res.Stdout); got["deadlineAction"] != nil {
		t.Fatalf("result carries deadlineAction %v for a payload that never sent it", got["deadlineAction"])
	}
}

func TestScheduleRebootHonoursHold(t *testing.T) {
	h := newTestHeartbeatWithRebootManager(t)
	deadline := time.Now().Add(3 * time.Hour).UTC().Truncate(time.Second)
	res := handleScheduleReboot(h, Command{Payload: map[string]any{
		"delayMinutes": float64(15), "reason": "Vendor updates", "source": "oem_update",
		"deadline": deadline.Format(time.RFC3339), "deadlineAction": "hold",
	}})
	if res.Status != "completed" {
		t.Fatalf("status = %q (%s)", res.Status, res.Error)
	}
	if got := h.rebootMgr.State().DeadlineAction; got != "hold" {
		t.Fatalf("DeadlineAction = %q, want hold", got)
	}
	if got := scheduleRebootResultMap(t, res.Stdout); got["deadlineAction"] != "hold" {
		t.Fatalf("result deadlineAction = %v, want hold", got["deadlineAction"])
	}
}

func TestScheduleRebootRejectsAnUnknownDeadlineAction(t *testing.T) {
	for _, v := range []any{"force", "HOLD", "", true, float64(1), nil} {
		h := newTestHeartbeatWithRebootManager(t)
		res := handleScheduleReboot(h, Command{Payload: map[string]any{
			"delayMinutes": float64(15), "reason": "Patch", "source": "patch_job",
			"deadline":       time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
			"deadlineAction": v,
		}})
		if res.Status == "completed" {
			t.Fatalf("deadlineAction %#v was accepted", v)
		}
		if h.rebootMgr.State().RebootScheduled {
			t.Fatalf("deadlineAction %#v scheduled a restart", v)
		}
	}
}

func TestScheduleRebootHoldNeedsAnExplicitDeadline(t *testing.T) {
	h := newTestHeartbeatWithRebootManager(t)
	res := handleScheduleReboot(h, Command{Payload: map[string]any{
		"delayMinutes": float64(15), "reason": "Vendor updates", "source": "oem_update",
		"deadlineAction": "hold",
	}})
	if res.Status == "completed" {
		t.Fatal("a hold restart without the window close was accepted")
	}
}

// A hold restart that could not begin inside its window even on time is
// refused up front, not warned about and then dropped.
func TestScheduleRebootRefusesAHoldPastItsWindow(t *testing.T) {
	h := newTestHeartbeatWithRebootManager(t)
	res := handleScheduleReboot(h, Command{Payload: map[string]any{
		"delayMinutes": float64(60), "reason": "Vendor updates", "source": "oem_update",
		"deadline":       time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339),
		"deadlineAction": "hold",
	}})
	if res.Status == "completed" {
		t.Fatal("a hold restart that cannot begin before the window closes was accepted")
	}
	if h.rebootMgr.State().RebootScheduled {
		t.Fatal("the refused restart was scheduled")
	}
}
