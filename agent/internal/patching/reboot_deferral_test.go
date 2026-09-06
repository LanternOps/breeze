// Untagged on purpose — see reboot_plan_test.go and reboot_deferral.go.
package patching

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestComputeDeferral(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	pol := DeferralPolicy{Allowed: true, MaxDeferrals: 2, DeferralMinutes: 60}

	// scheduledAt defaults to `now` in these cases unless a case sets it, so the
	// table reads as "postpone a restart that is due right now" — the strictest
	// framing, since any extra headroom only makes a grant easier.
	cases := []struct {
		name        string
		policy      DeferralPolicy
		used        int
		scheduledAt time.Time
		deadline    time.Time
		want        DeferralOutcome
	}{
		{
			name:   "policy disabled refuses",
			policy: DeferralPolicy{Allowed: false, MaxDeferrals: 5, DeferralMinutes: 60},
			used:   0, deadline: now.Add(9 * time.Hour),
			want: DeferralOutcome{Granted: false, Reason: deferralReasonNotEnabled},
		},
		{
			// The zero value of DeferralPolicy is what every pre-#3207 call site
			// produces. It must refuse, never fall through to a default budget.
			name:   "zero-valued policy refuses",
			policy: DeferralPolicy{},
			used:   0, deadline: now.Add(9 * time.Hour),
			want: DeferralOutcome{Granted: false, Reason: deferralReasonNotEnabled},
		},
		{
			name:   "allowed but zero count refuses",
			policy: DeferralPolicy{Allowed: true, MaxDeferrals: 0, DeferralMinutes: 60},
			used:   0, deadline: now.Add(9 * time.Hour),
			want: DeferralOutcome{Granted: false, Reason: deferralReasonNotEnabled},
		},
		{
			name:   "allowed but zero window refuses",
			policy: DeferralPolicy{Allowed: true, MaxDeferrals: 2, DeferralMinutes: 0},
			used:   0, deadline: now.Add(9 * time.Hour),
			want: DeferralOutcome{Granted: false, Reason: deferralReasonNotEnabled},
		},
		{
			name: "budget exhausted refuses", policy: pol, used: 2,
			deadline: now.Add(9 * time.Hour),
			want:     DeferralOutcome{Granted: false, Reason: deferralReasonNoneRemaining},
		},
		{
			// A ledger that somehow overshoots must still refuse, not wrap around.
			name: "budget overshot refuses", policy: pol, used: 7,
			deadline: now.Add(9 * time.Hour),
			want:     DeferralOutcome{Granted: false, Reason: deferralReasonNoneRemaining},
		},
		{
			name:   "grants the full window when the deadline is far away",
			policy: pol, used: 0, deadline: now.Add(9 * time.Hour),
			want: DeferralOutcome{Granted: true, NewDelay: 60 * time.Minute},
		},
		{
			name:   "grants the last postponement in the budget",
			policy: pol, used: 1, deadline: now.Add(9 * time.Hour),
			want: DeferralOutcome{Granted: true, NewDelay: 60 * time.Minute},
		},
		{
			// #3253: the deadline is what actually bounds a deferral. A 60-minute
			// window with 20 minutes left must yield 20, not 60.
			name:   "clamps the window to the hard deadline",
			policy: pol, used: 1, deadline: now.Add(20 * time.Minute),
			want: DeferralOutcome{Granted: true, NewDelay: 20 * time.Minute},
		},
		{
			// Exactly MinRebootDelay is still schedulable: PlanReboot's floor is
			// this same constant, so the closing notice still has room to render.
			name:   "grants a clamp landing exactly on MinRebootDelay",
			policy: pol, used: 0, deadline: now.Add(MinRebootDelay),
			want: DeferralOutcome{Granted: true, NewDelay: MinRebootDelay},
		},
		{
			name:   "refuses when the clamp leaves less than MinRebootDelay",
			policy: pol, used: 0, deadline: now.Add(30 * time.Second),
			want: DeferralOutcome{Granted: false, Reason: deferralReasonDeadlineReached},
		},
		{
			name:   "refuses a deadline already in the past",
			policy: pol, used: 0, deadline: now.Add(-time.Minute),
			want: DeferralOutcome{Granted: false, Reason: deferralReasonDeadlineReached},
		},
		{
			// A caller that never received a deadline must not get an unbounded
			// postponement out of the zero time.
			name:   "refuses a zero deadline",
			policy: pol, used: 0, deadline: time.Time{},
			want: DeferralOutcome{Granted: false, Reason: deferralReasonDeadlineReached},
		},
		{
			// The window is added to the SCHEDULE, not to now. Computed from now
			// this would be 60m, which moves a restart that was two hours away an
			// hour CLOSER — the user pressed Postpone and lost an hour.
			name:   "adds the window to the scheduled time, never pulling it earlier",
			policy: pol, used: 0,
			scheduledAt: now.Add(2 * time.Hour), deadline: now.Add(4 * time.Hour),
			want: DeferralOutcome{Granted: true, NewDelay: 3 * time.Hour},
		},
		{
			// Which is also what makes the counter and the API's derived deadline
			// agree: scheduledAt + maxDeferrals*window IS the deadline, so the last
			// postponement lands exactly on it.
			name:   "the last postponement lands exactly on the derived deadline",
			policy: pol, used: 1,
			scheduledAt: now.Add(3 * time.Hour), deadline: now.Add(4 * time.Hour),
			want: DeferralOutcome{Granted: true, NewDelay: 4 * time.Hour},
		},
		{
			// An overdue schedule pushes off from now, not from a past instant.
			name:   "an overdue schedule postpones from now",
			policy: pol, used: 0,
			scheduledAt: now.Add(-30 * time.Minute), deadline: now.Add(4 * time.Hour),
			want: DeferralOutcome{Granted: true, NewDelay: 60 * time.Minute},
		},
		{
			// A deadline behind the schedule must refuse rather than clamp, which
			// would drag the restart forward in the name of postponing it.
			name:   "refuses a deadline that sits before the current schedule",
			policy: pol, used: 0,
			scheduledAt: now.Add(2 * time.Hour), deadline: now.Add(time.Hour),
			want: DeferralOutcome{Granted: false, Reason: deferralReasonDeadlineReached},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			scheduledAt := tc.scheduledAt
			if scheduledAt.IsZero() {
				scheduledAt = now
			}
			got := ComputeDeferral(tc.policy, tc.used, now, scheduledAt, tc.deadline)
			if got.Granted != tc.want.Granted || got.NewDelay != tc.want.NewDelay {
				t.Fatalf("got %+v, want %+v", got, tc.want)
			}
			if !got.Granted {
				if got.Reason != tc.want.Reason {
					t.Errorf("reason = %q, want %q", got.Reason, tc.want.Reason)
				}
				if got.NewDelay != 0 {
					t.Errorf("refused outcome carries NewDelay=%v, want 0", got.NewDelay)
				}
			}
			if got.Granted && got.Reason != "" {
				t.Errorf("granted outcome carries Reason=%q, want empty", got.Reason)
			}
		})
	}
}

// A granted deferral must never schedule the machine down after the deadline —
// that is the whole guarantee the counter does not provide.
func TestComputeDeferralNeverExceedsTheDeadline(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	pol := DeferralPolicy{Allowed: true, MaxDeferrals: 10, DeferralMinutes: 240}

	for offset := time.Minute; offset <= 8*time.Hour; offset += 37 * time.Second {
		deadline := now.Add(offset)
		for _, sched := range []time.Duration{-time.Hour, 0, time.Minute, offset / 2, offset, offset + time.Hour} {
			scheduledAt := now.Add(sched)
			got := ComputeDeferral(pol, 0, now, scheduledAt, deadline)
			if !got.Granted {
				continue
			}
			landing := now.Add(got.NewDelay)
			if landing.After(deadline) {
				t.Fatalf("offset %v sched %v: lands at %v, past the deadline %v", offset, sched, landing, deadline)
			}
			if landing.Before(scheduledAt) {
				t.Fatalf("offset %v sched %v: lands at %v, EARLIER than the current schedule %v",
					offset, sched, landing, scheduledAt)
			}
			if got.NewDelay < MinRebootDelay {
				t.Fatalf("offset %v sched %v: granted %v, below MinRebootDelay", offset, sched, got.NewDelay)
			}
		}
	}
}

func TestDeferralLedgerRoundTripsOnMatchingDeadline(t *testing.T) {
	path := filepath.Join(t.TempDir(), "reboot_deferrals.json")
	now := time.Now()
	deadline := now.Add(2 * time.Hour).Truncate(time.Minute)

	if err := SaveDeferralLedger(path, deadline, 2); err != nil {
		t.Fatalf("save: %v", err)
	}
	if got := LoadDeferralLedger(path, deadline, now); got != 2 {
		t.Errorf("same-deadline reload = %d, want 2 (the budget must survive an agent restart)", got)
	}
	// Sub-minute jitter in the deadline is still the same campaign: the API
	// re-sends an ISO timestamp with milliseconds, and a re-dispatch must not
	// hand the user a fresh budget just because the string differs.
	if got := LoadDeferralLedger(path, deadline.Add(20*time.Second), now); got != 2 {
		t.Errorf("same-minute reload = %d, want 2", got)
	}
	// A different deadline is a different administrator decision: fresh budget.
	if got := LoadDeferralLedger(path, deadline.Add(time.Hour), now); got != 0 {
		t.Errorf("different-deadline reload = %d, want 0", got)
	}
	// An expired ledger never resurrects.
	if got := LoadDeferralLedger(path, deadline, deadline.Add(time.Minute)); got != 0 {
		t.Errorf("expired reload = %d, want 0", got)
	}
}

func TestDeferralLedgerMissingOrCorruptFileMeansZero(t *testing.T) {
	dir := t.TempDir()
	if got := LoadDeferralLedger(filepath.Join(dir, "nope.json"), time.Now().Add(time.Hour), time.Now()); got != 0 {
		t.Errorf("missing file = %d, want 0", got)
	}
	bad := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(bad, []byte("{not json"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if got := LoadDeferralLedger(bad, time.Now().Add(time.Hour), time.Now()); got != 0 {
		t.Errorf("corrupt file = %d, want 0", got)
	}

	// A hand-edited negative count must not become extra postponements.
	negative := filepath.Join(dir, "negative.json")
	deadline := time.Now().Add(time.Hour)
	data, err := json.Marshal(DeferralLedger{Deadline: deadline, Used: -3})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(negative, data, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if got := LoadDeferralLedger(negative, deadline, time.Now()); got != 0 {
		t.Errorf("negative count = %d, want 0", got)
	}
}

func TestSaveDeferralLedgerOverwritesAndIsPrivate(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "data")
	path := filepath.Join(dir, "reboot_deferrals.json")
	deadline := time.Now().Add(90 * time.Minute)

	if err := SaveDeferralLedger(path, deadline, 1); err != nil {
		t.Fatalf("first save: %v", err)
	}
	if err := SaveDeferralLedger(path, deadline, 2); err != nil {
		t.Fatalf("second save: %v", err)
	}
	if got := LoadDeferralLedger(path, deadline, time.Now()); got != 2 {
		t.Errorf("after overwrite = %d, want 2", got)
	}

	// No stray temp files left behind by the atomic write.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != "reboot_deferrals.json" {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("ledger directory = %v, want exactly [reboot_deferrals.json]", names)
	}

	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat: %v", err)
		}
		// The ledger sits in the agent data dir alongside reboot_history.json;
		// keep it root-only for the same reason.
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Errorf("ledger mode = %o, want 600", perm)
		}
	}
}
