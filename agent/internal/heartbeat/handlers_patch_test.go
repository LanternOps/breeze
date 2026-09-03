package heartbeat

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/patching"
)

func newTestHeartbeatWithRebootManager(t *testing.T) *Heartbeat {
	t.Helper()
	mgr := patching.NewRebootManager(func(string, string, string) {}, 3)
	t.Cleanup(mgr.Stop)
	return &Heartbeat{rebootMgr: mgr}
}

func scheduleRebootResultMap(t *testing.T, res any) map[string]any {
	t.Helper()
	stdout, ok := res.(string)
	if !ok {
		t.Fatalf("result stdout is %T, want string", res)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(stdout), &got); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	return got
}

func TestScheduleRebootDefaultsDeferralOffWhenTheApiOmitsIt(t *testing.T) {
	// An OLD API sends only delayMinutes/reason/source. The absent keys must
	// mean deferral OFF — never "enabled".
	h := newTestHeartbeatWithRebootManager(t)
	res := handleScheduleReboot(h, Command{Payload: map[string]any{
		"delayMinutes": float64(15), "reason": "Patch", "source": "patch_job",
	}})
	if res.Status != "completed" {
		t.Fatalf("status = %q (%s)", res.Status, res.Error)
	}
	st := h.rebootMgr.State()
	if st.DeferralAllowed {
		t.Error("deferral enabled from a payload that never mentioned it")
	}
	if st.MaxDeferrals != 0 || st.DeferralMinutes != 0 {
		t.Errorf("budget = %d x %dm, want 0", st.MaxDeferrals, st.DeferralMinutes)
	}
	// The absent deadline still falls back to the scheduled reboot time, which
	// is exactly what an agent predating #3207 did.
	if st.Deadline.IsZero() {
		t.Error("Deadline is zero — an absent deadline must fall back to now+delay")
	}

	// get_reboot_status reports the budget with no handler change.
	got := scheduleRebootResultMap(t, res.Stdout)
	if got["deferralAllowed"] != false {
		t.Errorf("reported deferralAllowed = %v, want false", got["deferralAllowed"])
	}
}

func TestScheduleRebootHonoursTheDeferralBudget(t *testing.T) {
	h := newTestHeartbeatWithRebootManager(t)
	deadline := time.Now().Add(3 * time.Hour).UTC().Truncate(time.Second)
	res := handleScheduleReboot(h, Command{Payload: map[string]any{
		"delayMinutes": float64(15), "reason": "Patch", "source": "patch_job",
		"deadline":     deadline.Format(time.RFC3339),
		"allowDeferral": true, "maxDeferrals": float64(2), "deferralMinutes": float64(60),
	}})
	if res.Status != "completed" {
		t.Fatalf("status = %q (%s)", res.Status, res.Error)
	}
	st := h.rebootMgr.State()
	if !st.DeferralAllowed || st.MaxDeferrals != 2 || st.DeferralMinutes != 60 {
		t.Fatalf("state = %+v", st)
	}
	if !st.Deadline.Equal(deadline) {
		t.Errorf("Deadline = %v, want the payload's %v", st.Deadline, deadline)
	}
}

// Forward compatibility: a NEWER API may add payload keys this agent has never
// heard of. They must be ignored, not rejected.
func TestScheduleRebootIgnoresUnknownPayloadKeys(t *testing.T) {
	h := newTestHeartbeatWithRebootManager(t)
	res := handleScheduleReboot(h, Command{Payload: map[string]any{
		"delayMinutes": float64(15),
		"allowDeferral": true, "maxDeferrals": float64(1), "deferralMinutes": float64(30),
		"deferralChoices": []any{"15m", "1h"}, "somethingFromTheFuture": map[string]any{"a": 1},
	}})
	if res.Status != "completed" {
		t.Fatalf("status = %q (%s)", res.Status, res.Error)
	}
	if st := h.rebootMgr.State(); !st.DeferralAllowed || st.MaxDeferrals != 1 {
		t.Errorf("state = %+v", st)
	}
}

// allowDeferral is the only switch. A payload carrying a budget without the
// flag — a stale or hand-edited command — stays off.
func TestScheduleRebootIgnoresABudgetWithoutTheFlag(t *testing.T) {
	h := newTestHeartbeatWithRebootManager(t)
	for _, payload := range []map[string]any{
		{"delayMinutes": float64(15), "maxDeferrals": float64(5), "deferralMinutes": float64(60)},
		{"delayMinutes": float64(15), "allowDeferral": false, "maxDeferrals": float64(5), "deferralMinutes": float64(60)},
		// A non-boolean allowDeferral is not a boolean true.
		{"delayMinutes": float64(15), "allowDeferral": "true", "maxDeferrals": float64(5), "deferralMinutes": float64(60)},
	} {
		res := handleScheduleReboot(h, Command{Payload: payload})
		if res.Status != "completed" {
			t.Fatalf("payload %v: status = %q (%s)", payload, res.Status, res.Error)
		}
		if st := h.rebootMgr.State(); st.DeferralAllowed || st.MaxDeferrals != 0 {
			t.Errorf("payload %v: state = %+v, want deferral off", payload, st)
		}
	}
}

// Ranges mirror the API-side CHECK constraints. A forged or corrupted budget is
// REJECTED rather than clamped — a silent clamp is how #3373 turned a malformed
// delayMinutes into a 60-minute reboot.
func TestScheduleRebootRejectsAnOutOfRangeDeferralBudget(t *testing.T) {
	cases := []struct {
		name    string
		payload map[string]any
	}{
		{"maxDeferrals above the ceiling", map[string]any{
			"delayMinutes": float64(15), "allowDeferral": true,
			"maxDeferrals": float64(99), "deferralMinutes": float64(60)}},
		{"maxDeferrals below the floor", map[string]any{
			"delayMinutes": float64(15), "allowDeferral": true,
			"maxDeferrals": float64(0), "deferralMinutes": float64(60)}},
		{"maxDeferrals negative", map[string]any{
			"delayMinutes": float64(15), "allowDeferral": true,
			"maxDeferrals": float64(-1), "deferralMinutes": float64(60)}},
		{"maxDeferrals missing", map[string]any{
			"delayMinutes": float64(15), "allowDeferral": true,
			"deferralMinutes": float64(60)}},
		{"maxDeferrals malformed", map[string]any{
			"delayMinutes": float64(15), "allowDeferral": true,
			"maxDeferrals": "lots", "deferralMinutes": float64(60)}},
		{"deferralMinutes below the floor", map[string]any{
			"delayMinutes": float64(15), "allowDeferral": true,
			"maxDeferrals": float64(2), "deferralMinutes": float64(1)}},
		{"deferralMinutes above the ceiling", map[string]any{
			"delayMinutes": float64(15), "allowDeferral": true,
			"maxDeferrals": float64(2), "deferralMinutes": float64(5000)}},
		{"deferralMinutes missing", map[string]any{
			"delayMinutes": float64(15), "allowDeferral": true,
			"maxDeferrals": float64(2)}},
		{"deferralMinutes malformed", map[string]any{
			"delayMinutes": float64(15), "allowDeferral": true,
			"maxDeferrals": float64(2), "deferralMinutes": "an hour"}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newTestHeartbeatWithRebootManager(t)
			res := handleScheduleReboot(h, Command{Payload: tc.payload})
			if res.Status == "completed" {
				t.Fatalf("payload %v was accepted; a bad budget must be rejected, not clamped", tc.payload)
			}
			if st := h.rebootMgr.State(); st.RebootScheduled {
				t.Error("a rejected schedule_reboot still scheduled a reboot")
			}
		})
	}
}

// A malformed deadline used to be swallowed, leaving deadline = now+delay. With
// deferral live that silently collapses the budget to nothing, so it now fails
// the command instead.
func TestScheduleRebootRejectsAMalformedDeadline(t *testing.T) {
	h := newTestHeartbeatWithRebootManager(t)
	res := handleScheduleReboot(h, Command{Payload: map[string]any{
		"delayMinutes": float64(15), "deadline": "next tuesday",
	}})
	if res.Status == "completed" {
		t.Fatal("a malformed deadline was swallowed; it must fail the command")
	}
	if res.Error == "" {
		t.Error("no error message on a rejected deadline")
	}
	if h.rebootMgr.State().RebootScheduled {
		t.Error("a rejected schedule_reboot still scheduled a reboot")
	}
}

func TestScheduleRebootWithoutARebootManagerFails(t *testing.T) {
	res := handleScheduleReboot(&Heartbeat{}, Command{Payload: map[string]any{"delayMinutes": float64(15)}})
	if res.Status == "completed" {
		t.Fatal("schedule_reboot succeeded with no reboot manager")
	}
}
