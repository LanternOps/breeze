// Deferral arithmetic and its on-disk ledger (issue #3207).
//
// Untagged on purpose, for the same reason reboot_plan.go is: ./internal/patching
// is not in the test-agent-windows package allowlist (#3019, #3046), so anything
// behind a build tag is tested nowhere in CI.
//
// The COUNTER is a UX affordance; the DEADLINE is the guarantee. A deferral is
// always clamped to the deadline the API sent, and refused outright when the
// clamp leaves less room than MinRebootDelay. That is what finally gives
// RebootState.Deadline a job (#3253: stored and reported, never enforced).
package patching

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
)

const deferralLedgerFile = "reboot_deferrals.json"

// Refusal reasons. These are shown to the signed-in user verbatim (W3), so they
// are phrased as statements about their restart rather than about the agent.
const (
	deferralReasonNotEnabled      = "deferral is not enabled by policy"
	deferralReasonNoneRemaining   = "no postponements remaining"
	deferralReasonDeadlineReached = "the restart deadline has been reached"
)

// DeferralPolicy is the budget for ONE scheduled reboot, resolved server-side
// and delivered on the schedule_reboot payload. Its zero value is "no deferral",
// which is what every pre-#3207 call site and every old API produces — an absent
// policy must never widen what the agent will do.
type DeferralPolicy struct {
	Allowed         bool
	MaxDeferrals    int
	DeferralMinutes int
}

// DeferralOutcome is the verdict on one postponement request.
type DeferralOutcome struct {
	Granted bool
	// NewDelay is the delay to re-schedule under. Only set when Granted.
	NewDelay time.Duration
	// Reason explains a refusal and is intended to be shown to the user. Only
	// set when the request was refused.
	Reason string
}

// ComputeDeferral is pure: no clock, no disk, no locks. Everything that decides
// whether a user may postpone their restart lives here so it can be asserted
// exhaustively without driving timers.
func ComputeDeferral(policy DeferralPolicy, used int, now, deadline time.Time) DeferralOutcome {
	if !policy.Allowed || policy.MaxDeferrals <= 0 || policy.DeferralMinutes <= 0 {
		return DeferralOutcome{Reason: deferralReasonNotEnabled}
	}
	if used >= policy.MaxDeferrals {
		return DeferralOutcome{Reason: deferralReasonNoneRemaining}
	}
	want := time.Duration(policy.DeferralMinutes) * time.Minute
	// The clamp. A zero or past deadline yields a non-positive remainder and so
	// falls through to the refusal below rather than granting anything.
	if remaining := deadline.Sub(now); remaining < want {
		want = remaining
	}
	if want < MinRebootDelay {
		return DeferralOutcome{Reason: deferralReasonDeadlineReached}
	}
	return DeferralOutcome{Granted: true, NewDelay: want}
}

// DeferralLedger persists the count for ONE reboot campaign, keyed by its hard
// deadline truncated to the minute. A schedule carrying a different deadline is
// a different administrator decision (Schedule is documented last-writer-wins),
// so it legitimately starts a fresh budget — the deadline still bounds it.
//
// Best-effort by design: a missing, corrupt, or expired ledger means zero
// deferrals used, never an error that blocks a reboot. Losing the count costs
// the user an extra postponement after an agent restart; it can never let them
// postpone past the deadline, because the deadline is enforced separately.
type DeferralLedger struct {
	Deadline time.Time `json:"deadline"`
	Used     int       `json:"used"`
}

func deferralLedgerPath() string {
	return filepath.Join(config.GetDataDir(), deferralLedgerFile)
}

// LoadDeferralLedger returns how many postponements this campaign has already
// used. Zero for anything it cannot positively confirm.
func LoadDeferralLedger(path string, deadline, now time.Time) int {
	data, err := os.ReadFile(path)
	if err != nil {
		// Missing is the normal case on the first deferral of a campaign; a
		// genuine read error is still only worth a debug line because the
		// consequence is bounded (one extra postponement, never a missed
		// deadline) — unlike the reboot-history file, which IS the circuit
		// breaker's memory and therefore warns.
		if !os.IsNotExist(err) {
			log.Debug("reboot deferral ledger unreadable; postponement count resets to zero",
				"path", path, "error", err)
		}
		return 0
	}
	var ledger DeferralLedger
	if err := json.Unmarshal(data, &ledger); err != nil {
		log.Warn("reboot deferral ledger is corrupt; postponement count resets to zero",
			"path", path, "error", err)
		return 0
	}
	if !ledger.Deadline.Truncate(time.Minute).Equal(deadline.Truncate(time.Minute)) {
		return 0
	}
	if !ledger.Deadline.After(now) {
		return 0
	}
	if ledger.Used < 0 {
		return 0
	}
	return ledger.Used
}

// SaveDeferralLedger records the count for this campaign.
//
// Written atomically (temp file in the same directory, then rename) so a crash
// or a full disk mid-write leaves the previous count in place instead of a
// truncated file. A torn ledger would read back as zero used, which quietly
// hands the user their whole budget again.
func SaveDeferralLedger(path string, deadline time.Time, used int) error {
	data, err := json.Marshal(DeferralLedger{Deadline: deadline, Used: used})
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, deferralLedgerFile+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() {
		// No-op once the rename succeeded; on any failure path this is what
		// keeps the temp file from accumulating in the data dir.
		_ = os.Remove(tmpName)
	}()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("rename deferral ledger into place: %w", err)
	}
	return nil
}
