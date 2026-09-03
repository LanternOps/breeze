package heartbeat

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/patching"
)

func TestBuildRebootStatusReportReturnsNilWhenNothingIsScheduled(t *testing.T) {
	cases := map[string]patching.RebootState{
		"zero state":                     {},
		"pending reboot but no schedule": {PendingReboot: true},
		"scheduled flag without a time":  {RebootScheduled: true},
		"a time but the flag is off":     {ScheduledAt: time.Now().Add(time.Hour)},
	}
	for name, state := range cases {
		t.Run(name, func(t *testing.T) {
			if report := buildRebootStatusReport(state); report != nil {
				t.Fatalf("expected nil report, got %+v", report)
			}
		})
	}
}

func TestBuildRebootStatusReportProjectsTheLiveSchedule(t *testing.T) {
	scheduledAt := time.Date(2026, 9, 2, 13, 0, 0, 0, time.UTC)
	deadline := time.Date(2026, 9, 2, 16, 0, 0, 0, time.UTC)

	report := buildRebootStatusReport(patching.RebootState{
		RebootScheduled: true,
		ScheduledAt:     scheduledAt,
		Deadline:        deadline,
		Source:          "patch_job",
		DeferralAllowed: true,
		DeferralsUsed:   1,
		MaxDeferrals:    3,
		DeferralMinutes: 60,
		// Agent-internal bookkeeping that must NOT cross the wire.
		NotifiedUser:         true,
		NotificationsPlanned: 3,
		LastError:            "shutdown.exe exited 1",
	})

	if report == nil {
		t.Fatal("expected a report")
	}
	if !report.ScheduledAt.Equal(scheduledAt) {
		t.Errorf("scheduledAt = %v, want %v", report.ScheduledAt, scheduledAt)
	}
	if report.Deadline == nil || !report.Deadline.Equal(deadline) {
		t.Errorf("deadline = %v, want %v", report.Deadline, deadline)
	}
	if report.Source != "patch_job" {
		t.Errorf("source = %q, want patch_job", report.Source)
	}
	if report.DeferralsUsed != 1 || report.MaxDeferrals != 3 {
		t.Errorf("deferrals = %d of %d, want 1 of 3", report.DeferralsUsed, report.MaxDeferrals)
	}

	// The projection is a deliberate allowlist: anything the console has no
	// column for must not appear in the JSON.
	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, leaked := range []string{
		"notifiedUser", "notificationSent", "notificationsPlanned",
		"lastError", "deferralAllowed", "deferralMinutes", "reason",
		"pendingReboot", "rebootScheduled",
	} {
		if _, present := decoded[leaked]; present {
			t.Errorf("internal field %q leaked onto the heartbeat wire", leaked)
		}
	}
}

func TestBuildRebootStatusReportOmitsAZeroDeadline(t *testing.T) {
	// RebootState carries the zero time.Time when a schedule has no deadline.
	// Marshalling that would report year 0001 to the console, which the server
	// would happily store as a deadline in the distant past.
	report := buildRebootStatusReport(patching.RebootState{
		RebootScheduled: true,
		ScheduledAt:     time.Now().Add(time.Hour),
		Source:          "manual",
	})
	if report == nil {
		t.Fatal("expected a report")
	}
	if report.Deadline != nil {
		t.Errorf("deadline = %v, want nil", report.Deadline)
	}
	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, present := decoded["deadline"]; present {
		t.Errorf("deadline key present for a schedule with no deadline: %s", encoded)
	}
}

func TestBuildRebootStatusReportZeroesTheBudgetWhenDeferralIsOff(t *testing.T) {
	// A restart nobody can postpone must read "cannot be postponed", not
	// "postponed 0 of 3" — the policy numbers are meaningless once
	// DeferralAllowed is false.
	report := buildRebootStatusReport(patching.RebootState{
		RebootScheduled: true,
		ScheduledAt:     time.Now().Add(time.Hour),
		Source:          "patch_job",
		DeferralAllowed: false,
		DeferralsUsed:   2,
		MaxDeferrals:    3,
	})
	if report == nil {
		t.Fatal("expected a report")
	}
	if report.DeferralsUsed != 0 || report.MaxDeferrals != 0 {
		t.Errorf("deferrals = %d of %d, want 0 of 0", report.DeferralsUsed, report.MaxDeferrals)
	}
}

func TestRebootStatusMarshalsAsExplicitNullWhenNothingIsScheduled(t *testing.T) {
	// The whole absent-vs-null contract: a capable agent with no scheduled
	// restart must put `"rebootStatus":null` on the wire so the server clears
	// a restart it was previously told about. An `omitempty` tag here would
	// make a cancelled restart stick on the device page forever.
	encoded, err := json.Marshal(HeartbeatPayload{Status: "online", AgentVersion: "0.110.0"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	raw, present := decoded["rebootStatus"]
	if !present {
		t.Fatalf("rebootStatus key missing from the payload: %s", encoded)
	}
	if string(raw) != "null" {
		t.Errorf("rebootStatus = %s, want null", raw)
	}
}

func TestRebootStatusForHeartbeatToleratesAMissingManager(t *testing.T) {
	h := &Heartbeat{}
	if report := h.rebootStatusForHeartbeat(); report != nil {
		t.Fatalf("expected nil report with no reboot manager, got %+v", report)
	}
}

func TestRebootStatusForHeartbeatReadsTheLiveManager(t *testing.T) {
	mgr := patching.NewRebootManager(func(string, string, string) {}, 3)
	t.Cleanup(mgr.Stop)
	h := &Heartbeat{rebootMgr: mgr}

	if report := h.rebootStatusForHeartbeat(); report != nil {
		t.Fatalf("expected nil before anything is scheduled, got %+v", report)
	}

	deadline := time.Now().Add(2 * time.Hour)
	if err := mgr.ScheduleWithOptions(time.Hour, deadline, "Patch install", "patch_job", patching.RebootOptions{
		Deferral: patching.DeferralPolicy{Allowed: true, MaxDeferrals: 3, DeferralMinutes: 60},
	}); err != nil {
		t.Fatalf("schedule: %v", err)
	}

	report := h.rebootStatusForHeartbeat()
	if report == nil {
		t.Fatal("expected a report once a restart is scheduled")
	}
	if report.Source != "patch_job" {
		t.Errorf("source = %q, want patch_job", report.Source)
	}
	if report.MaxDeferrals != 3 {
		t.Errorf("maxDeferrals = %d, want 3", report.MaxDeferrals)
	}
	if report.DeferralsUsed != 0 {
		t.Errorf("deferralsUsed = %d, want 0", report.DeferralsUsed)
	}
	if report.ScheduledAt.IsZero() {
		t.Error("scheduledAt is zero")
	}

	if err := mgr.Cancel(); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if report := h.rebootStatusForHeartbeat(); report != nil {
		t.Fatalf("expected nil after cancel, got %+v", report)
	}
}

func TestRebootStatusReportTimestampsParseAsRFC3339(t *testing.T) {
	// The server validates these with zod's datetime({offset:true}); a shape
	// Go marshals but zod rejects would silently drop the whole snapshot.
	scheduledAt := time.Date(2026, 9, 2, 13, 0, 0, 0, time.UTC)
	deadline := scheduledAt.Add(3 * time.Hour)
	encoded, err := json.Marshal(buildRebootStatusReport(patching.RebootState{
		RebootScheduled: true,
		ScheduledAt:     scheduledAt,
		Deadline:        deadline,
		Source:          "maintenance_window",
	}))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded struct {
		ScheduledAt string `json:"scheduledAt"`
		Deadline    string `json:"deadline"`
	}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for name, value := range map[string]string{"scheduledAt": decoded.ScheduledAt, "deadline": decoded.Deadline} {
		if _, err := time.Parse(time.RFC3339, value); err != nil {
			t.Errorf("%s = %q is not RFC3339: %v", name, value, err)
		}
	}
}
