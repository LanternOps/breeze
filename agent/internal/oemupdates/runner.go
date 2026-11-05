package oemupdates

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/flashguard"
)

// maxRunDuration bounds a run without a firmware install. It sits under the
// API's 2 h stale-command reaper, so the agent reports before the row is reaped.
const maxRunDuration = 110 * time.Minute

// runDeadline is maxRunDuration, a variable so tests can shorten it.
var runDeadline = maxRunDuration

// flashSectionKind names this feature's flash-guard sections.
const flashSectionKind = "oem_update"

const workDir = "work"

// Run executes one oem_update_run. The order is fixed: elevation, notAfter,
// lock, marker, preflight, tool (gate, fresh verification, install), category
// split, flash guard, Apply, mapped result, marker end. It never returns an
// invalid result: anything the contract would refuse becomes "failed".
func Run(ctx context.Context, req RunRequest, lane Lane, deps Deps) RunResult {
	elevated := deps.Elevated
	if elevated == nil {
		elevated = isElevated
	}
	if !elevated() {
		return refuse(req.Lane, OutcomeFailed, "not_elevated", errNotElevated)
	}
	start := deps.now()
	// Review Focus 4: a device clock running fast refuses here, the safe
	// direction; a slow one is stopped server-side by deliver_by.
	if !start.Before(req.NotAfter) {
		return refuse(req.Lane, OutcomeRetryLater, "not_after_passed",
			fmt.Errorf("now %s is not before notAfter %s", start.Format(time.RFC3339), req.NotAfter.Format(time.RFC3339)))
	}
	release, err := AcquireRunLock(deps.Store)
	if err != nil {
		return refuse(req.Lane, OutcomeRetryLater, "run_in_flight", err)
	}
	defer release()

	r := &run{req: req, lane: lane, deps: deps, start: start}
	r.marker = Marker{CommandID: req.CommandID, Lane: req.Lane, Trigger: req.Trigger, StartedAt: start, Stage: StageStarting}
	if err := WriteMarker(deps.Store, r.marker); err != nil {
		// No durable record means a restart could not tell this run happened,
		// and a firmware install could not be verified: refuse.
		return refuse(req.Lane, OutcomeFailed, "marker_unwritable", err)
	}
	result := r.execute(ctx)
	deps.progress(StageReporting)
	r.end(result)
	return result
}

type run struct {
	req     RunRequest
	lane    Lane
	deps    Deps
	start   time.Time
	marker  Marker
	pending PendingVerification
}

func (r *run) setStage(stage string) {
	r.marker.Stage = stage
	if err := WriteMarker(r.deps.Store, r.marker); err != nil {
		log.Warn("could not update the vendor update run marker", "stage", stage, "error", err.Error())
	}
}

func (r *run) execute(ctx context.Context) RunResult {
	deps := r.deps
	if deps.Preflight != nil {
		if err := deps.Preflight(); err != nil {
			return refuse(r.req.Lane, OutcomeRetryLater, "preflight_failed", err)
		}
	}

	deadline := r.start.Add(runDeadline)
	runCtx, cancelRun := context.WithDeadline(ctx, deadline)
	defer cancelRun()

	deps.progress(StageVerifying)
	r.setStage(StageVerifying)
	tool, outcome, err := EnsureTool(runCtx, r.lane, r.req.Tool, deps)
	if outcome != "" {
		return refuse(r.req.Lane, outcome, codeOr(err, "tool_unavailable"), err)
	}
	r.marker.ToolVersion = tool.Version

	plan, skips, err := r.splitCategories()
	if err != nil {
		return r.finish(refuse(r.req.Lane, OutcomeFailed, codeOr(err, "invalid_filter"), err), tool, skips)
	}
	if len(plan.Categories) == 0 {
		return r.finish(allSkipped(r.req.Lane, skips), tool, skips)
	}
	dir, err := deps.Store.Dir(workDir)
	if err != nil {
		return r.finish(refuse(r.req.Lane, OutcomeFailed, "store_unavailable", err), tool, skips)
	}
	plan.WorkDir = dir

	// The tool step can take a while (a download, an install). Re-check
	// everything that gates starting before anything irreversible begins.
	if refusal, stop := r.recheck(ctx, deadline); stop {
		return r.finish(refusal, tool, skips)
	}

	flash := plan.HasFlash()
	var releaseGuard func() error
	if flash {
		var refusal RunResult
		releaseGuard, refusal, err = r.enterFlash()
		if err != nil {
			return r.finish(refusal, tool, skips)
		}
	} else {
		deps.progress(StageInstalling)
		r.setStage(StageInstalling)
	}

	applyCtx := runCtx
	if flash {
		// Never killed while the guard is held: not at the deadline and not
		// when the agent stops. The ceiling is the section's own TTL, past
		// which the guard no longer holds power actions back either.
		var cancelFlash context.CancelFunc
		applyCtx, cancelFlash = context.WithTimeout(context.WithoutCancel(ctx), flashguard.MaxTTL)
		defer cancelFlash()
	}
	res, applyErr := r.lane.Apply(applyCtx, tool, plan, deps.Exec)
	if releaseGuard != nil {
		if err := releaseGuard(); err != nil {
			log.Warn("could not release the flash guard section; it expires on its own", "error", err.Error())
		}
	}

	switch {
	case flash && !deps.now().Before(deadline):
		// The install overran while it could not be stopped. What the tool
		// reported is kept; the outcome says the run did not end in time.
		if res.Outcome == "" && applyErr != nil {
			res.RawExitCode = nil
		}
		res.Outcome, res.ErrorCode = OutcomeInterrupted, strPtr("flash_overran_deadline")
	case applyErr != nil && !flash && errors.Is(applyCtx.Err(), context.DeadlineExceeded):
		res.Outcome, res.ErrorCode = OutcomeFailed, strPtr("deadline_exceeded")
	case applyErr != nil && !flash && ctx.Err() != nil:
		res.Outcome, res.ErrorCode = OutcomeInterrupted, strPtr("agent_stopping")
	case applyErr != nil && res.Outcome == "":
		res.Outcome = OutcomeFailed
		if res.ErrorCode == nil {
			res.ErrorCode = strPtr(codeOr(applyErr, "apply_failed"))
		}
	}
	if applyErr != nil {
		log.Warn("vendor update tool run failed", "lane", r.req.Lane, "outcome", string(res.Outcome), "error", applyErr.Error())
	}
	return r.finish(res, tool, skips)
}

// recheck refuses a run that should no longer start: the agent is stopping,
// notAfter has passed, or the run deadline has.
func (r *run) recheck(ctx context.Context, deadline time.Time) (RunResult, bool) {
	now := r.deps.now()
	switch {
	case ctx.Err() != nil:
		return refuse(r.req.Lane, OutcomeInterrupted, "agent_stopping", ctx.Err()), true
	case !now.Before(r.req.NotAfter):
		return refuse(r.req.Lane, OutcomeRetryLater, "not_after_passed", errors.New("notAfter passed before the install")), true
	case !now.Before(deadline):
		return refuse(r.req.Lane, OutcomeFailed, "deadline_exceeded", errors.New("run deadline passed before the install")), true
	}
	return RunResult{}, false
}

// enterFlash opens the flash-guard section and makes the run durable before a
// firmware install starts: the marker says a flash began, and a pending
// verification exists in case the machine never comes back to this process.
// Both writes are mandatory; failing either releases the section and refuses.
func (r *run) enterFlash() (release func() error, refusal RunResult, err error) {
	deps := r.deps
	if deps.Guard == nil {
		err = errors.New("no flash guard")
		return nil, refuse(r.req.Lane, OutcomeFailed, "flash_guard_unavailable", err), err
	}
	release, err = deps.Guard.Enter(flashSectionKind, r.req.CommandID, flashguard.MaxTTL)
	if err != nil {
		if errors.Is(err, flashguard.ErrPowerActionPending) || errors.Is(err, flashguard.ErrSectionActive) {
			return nil, refuse(r.req.Lane, OutcomeBlockedRebootPending, "flash_guard_busy", err), err
		}
		return nil, refuse(r.req.Lane, OutcomeFailed, "flash_guard_unavailable", err), err
	}
	r.pending = PendingVerification{CommandID: r.req.CommandID, VerifyAfter: deps.now(), CreatedAt: deps.now()}
	if deps.System != nil {
		if bios, berr := deps.System.BiosVersion(); berr == nil {
			r.pending.BiosVersionBefore = sanitizeToolText(bios, maxVersionLen)
		}
	}
	r.marker.FlashStarted = true
	r.marker.Stage = StageInstalling
	if err = WriteMarker(deps.Store, r.marker); err == nil {
		err = addPendingVerification(deps.Store, r.pending)
	}
	if err != nil {
		r.marker.FlashStarted = false
		if rerr := release(); rerr != nil {
			log.Warn("could not release the flash guard section; it expires on its own", "error", rerr.Error())
		}
		_ = removePendingVerification(deps.Store, r.req.CommandID)
		return nil, refuse(r.req.Lane, OutcomeFailed, "marker_unwritable", err), err
	}
	deps.progress(StageInstalling)
	return release, RunResult{}, nil
}

// splitCategories asks the lane what it will run, then removes the firmware
// categories that fail their gates, in order: a reboot Breeze controls, power,
// a current recovery key. The checks run here, immediately before the install.
func (r *run) splitCategories() (FilterPlan, []SkippedCategory, error) {
	plan, err := r.lane.Filter(r.req.Categories, r.req.BlockedUpdateIDs)
	if err != nil {
		return FilterPlan{}, nil, err
	}
	var skips []SkippedCategory
	needReboot := map[string]bool{}
	for _, c := range r.lane.SkippedForNoReboot() {
		needReboot[c] = true
	}
	keep := plan.Categories[:0:0]
	for _, c := range plan.Categories {
		if needReboot[c] && !r.req.RebootControlled {
			skips = append(skips, SkippedCategory{Category: c, Reason: SkipNoRebootControl})
			continue
		}
		keep = append(keep, c)
	}

	skipFlash := func(reason, why string) {
		next := keep[:0:0]
		for _, c := range keep {
			if IsFlashCategory(c) {
				skips = append(skips, SkippedCategory{Category: c, Reason: reason})
				continue
			}
			next = append(next, c)
		}
		if len(next) != len(keep) {
			log.Info("firmware categories skipped", "lane", r.req.Lane, "reason", reason, "detail", why)
		}
		keep = next
	}
	hasFlash := func() bool {
		for _, c := range keep {
			if IsFlashCategory(c) {
				return true
			}
		}
		return false
	}
	if hasFlash() {
		if r.deps.Power == nil {
			skipFlash(SkipPower, "no power reading")
		} else if status, err := r.deps.Power.Status(); err != nil {
			skipFlash(SkipPower, err.Error())
		} else if ok, why := CheckFlashPower(status); !ok {
			skipFlash(SkipPower, why)
		}
	}
	if hasFlash() {
		if r.deps.Protectors == nil {
			skipFlash(SkipNoRecoveryKey, "no protector reading")
		} else if live, err := r.deps.Protectors.Live(); err != nil {
			skipFlash(SkipNoRecoveryKey, err.Error())
		} else if !CheckRecoveryKey(live.RecoveryPasswordIDs, r.req.EscrowedProtectorIDs, live.BitLockerOn) {
			skipFlash(SkipNoRecoveryKey, "no live recovery-password protector is escrowed")
		}
	}
	if len(keep) == len(plan.Categories) {
		return plan, skips, nil
	}
	if len(keep) == 0 {
		return FilterPlan{}, skips, nil
	}
	plan, err = r.lane.Filter(keep, r.req.BlockedUpdateIDs)
	return plan, skips, err
}

// allSkipped names the outcome when every category was skipped: a missing key
// first, then power, since those are what a tech can act on.
func allSkipped(lane string, skips []SkippedCategory) RunResult {
	has := func(reason string) bool {
		for _, s := range skips {
			if s.Reason == reason {
				return true
			}
		}
		return false
	}
	switch {
	case has(SkipNoRecoveryKey):
		return refuse(lane, OutcomeBlockedNoRecoveryKey, "", nil)
	case has(SkipPower):
		return refuse(lane, OutcomeBlockedOnBattery, "", nil)
	}
	return refuse(lane, OutcomeFailed, "all_categories_skipped", errors.New("every requested category was skipped"))
}

// finish normalizes a result against the contract.
func (r *run) finish(res RunResult, tool ToolState, skips []SkippedCategory) RunResult {
	res.Lane = r.req.Lane
	if res.Takeover == "" {
		res.Takeover = TakeoverNotAttempted
	}
	if tool.Version != "" {
		v := sanitizeToolText(tool.Version, maxVersionLen)
		res.ToolVersion = &v
	}
	res.SkippedCategories = mergeSkips(res.SkippedCategories, skips)
	res.Items = sanitizeItems(res.Items)
	if err := res.Validate(); err != nil {
		log.Warn("vendor update result failed the contract; reporting failed", "lane", r.req.Lane, "error", err.Error())
		return RunResult{
			Lane: r.req.Lane, Outcome: OutcomeFailed, ToolVersion: res.ToolVersion, RawExitCode: res.RawExitCode,
			ErrorCode: strPtr("result_invalid"), RebootRequired: res.RebootRequired, ShutdownRequired: res.ShutdownRequired,
			SkippedCategories: res.SkippedCategories, Takeover: TakeoverNotAttempted,
		}
	}
	return res
}

func mergeSkips(a, b []SkippedCategory) []SkippedCategory {
	seen := map[string]bool{}
	var out []SkippedCategory
	for _, s := range append(append([]SkippedCategory(nil), b...), a...) {
		if seen[s.Category] || !IsCategory(s.Category) {
			continue
		}
		seen[s.Category] = true
		out = append(out, s)
	}
	return out
}

func sanitizeItems(items []Item) []Item {
	if len(items) > maxItems {
		items = items[:maxItems]
	}
	out := make([]Item, 0, len(items))
	for _, it := range items {
		out = append(out, Item{
			Title:    sanitizeToolText(it.Title, maxItemTitle),
			Category: it.Category,
			Version:  sanitizeToolText(it.Version, maxVersionLen),
			Result:   it.Result,
		})
	}
	return out
}

// end records the outcome in the marker, and whether the next start after a
// reboot must verify a firmware install.
func (r *run) end(res RunResult) {
	now := r.deps.now()
	r.marker.EndedAt = &now
	r.marker.Outcome = res.Outcome
	if err := WriteMarker(r.deps.Store, r.marker); err != nil {
		log.Warn("could not end the vendor update run marker", "error", err.Error())
	}
	if !r.marker.FlashStarted {
		return
	}
	if !flashMayHaveRun(res.Outcome) {
		if err := removePendingVerification(r.deps.Store, r.req.CommandID); err != nil {
			log.Warn("could not clear a pending vendor update verification", "error", err.Error())
		}
		return
	}
	// The reboot the install needs comes after it ends.
	r.pending.VerifyAfter = now
	if err := addPendingVerification(r.deps.Store, r.pending); err != nil {
		log.Warn("could not update a pending vendor update verification; the one from the flash start stands", "error", err.Error())
	}
}

func flashMayHaveRun(o Outcome) bool {
	switch o {
	case OutcomeNoUpdates, OutcomeNotSupported, OutcomeToolUnavailable, OutcomeBlockedOnBattery,
		OutcomeBlockedRebootPending, OutcomeBlockedNoRecoveryKey, OutcomeRetryLater:
		return false
	}
	return true
}

func refuse(lane string, outcome Outcome, code string, err error) RunResult {
	if err != nil {
		log.Info("vendor update run refused", "lane", lane, "outcome", string(outcome), "errorCode", code, "reason", err.Error())
	}
	r := RunResult{Lane: lane, Outcome: outcome, Takeover: TakeoverNotAttempted}
	if code != "" {
		r.ErrorCode = strPtr(code)
	}
	return r
}

func codeOr(err error, fallback string) string {
	if c := errorCodeOf(err); c != "" {
		return c
	}
	return fallback
}
