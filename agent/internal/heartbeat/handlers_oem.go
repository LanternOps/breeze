package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"runtime"
	"time"

	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/internal/oemupdates"
	"github.com/breeze-rmm/agent/internal/oemupdates/bitlockerguard"
	"github.com/breeze-rmm/agent/internal/patching"
	"github.com/breeze-rmm/agent/internal/privilege"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdOemUpdateRun] = handleOemUpdateRun
	interruptedResultBodies[tools.CmdOemUpdateRun] = oemInterruptedResultBody
	handlerRegistry[tools.CmdOemUpdateRelease] = handleOemUpdateRelease
}

// Seams, so the handler tests on any OS without running a vendor tool.
var (
	oemGOOS     = runtime.GOOS
	oemElevated = privilege.IsRunningAsRoot
	oemLaneFor  = oemupdates.LaneFor
	oemRun      = oemupdates.Run
	oemDepsFor  = productionOemDeps
	oemStore    = oemupdates.DefaultStore
	oemRelease  = oemupdates.Release
)

// handleOemUpdateRelease hands a vendor tool's schedule back (#11065 W06). The
// result is stdout JSON; a release that restored, or found nothing of
// Breeze's to restore, completes (the API clears its takeover state), and
// anything else fails so the API releases again.
func handleOemUpdateRelease(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	raw, err := json.Marshal(cmd.Payload)
	if err != nil {
		return tools.NewErrorResult(fmt.Errorf("invalid oem_update_release payload: %w", err), time.Since(start).Milliseconds())
	}
	req, err := oemupdates.ParseReleaseRequest(raw)
	if err != nil {
		return tools.NewErrorResult(fmt.Errorf("invalid oem_update_release payload: %w", err), time.Since(start).Milliseconds())
	}
	nothing := func(code string) tools.CommandResult {
		return oemReleaseCommandResult(oemupdates.ReleaseResult{Lane: req.Lane, Outcome: oemupdates.ReleaseNothingToRestore, ErrorCode: &code}, time.Since(start).Milliseconds())
	}
	// Off Windows, or a lane this agent does not build: no takeover ever ran.
	if oemGOOS != "windows" {
		return nothing("os_not_supported")
	}
	if !oemElevated() {
		log.Warn("oem_update_release refused: agent is not elevated", "commandId", cmd.ID)
		code := "not_elevated"
		return oemReleaseCommandResult(oemupdates.ReleaseResult{Lane: req.Lane, Outcome: oemupdates.ReleaseFailed, ErrorCode: &code}, time.Since(start).Milliseconds())
	}
	lane, ok := oemLaneFor(req.Lane)
	if !ok {
		return nothing("lane_not_built")
	}
	ctx, cancel := h.oemRunContext()
	defer cancel()
	result := oemRelease(ctx, req, lane, oemDepsFor(h, cmd.ID))
	return oemReleaseCommandResult(result, time.Since(start).Milliseconds())
}

func oemReleaseCommandResult(r oemupdates.ReleaseResult, durationMs int64) tools.CommandResult {
	if err := r.Validate(); err != nil {
		log.Warn("vendor schedule release result failed the contract; reporting failed", "error", err.Error())
		code := "result_invalid"
		r = oemupdates.ReleaseResult{Lane: r.Lane, Outcome: oemupdates.ReleaseFailed, ErrorCode: &code}
		if !oemupdates.IsLane(r.Lane) {
			r.Lane = oemupdates.LaneDell // unreachable: the payload's lane was parsed first
		}
	}
	out := tools.NewSuccessResult(r, durationMs)
	if out.Status == "completed" && !r.Acked() {
		out.Status = "failed"
		out.ExitCode = 1
		out.Error = "vendor schedule release: " + r.Outcome
	}
	return out
}

// handleOemUpdateRun runs one vendor lane. The payload is parsed strictly; a
// payload that does not parse is a plain failure with no run result, since it
// may not even name a lane. Every other answer is a contract-valid run result.
func handleOemUpdateRun(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	raw, err := json.Marshal(cmd.Payload)
	if err != nil {
		return tools.NewErrorResult(fmt.Errorf("invalid oem_update_run payload: %w", err), time.Since(start).Milliseconds())
	}
	req, err := oemupdates.ParseRunRequest(raw)
	if err != nil {
		return tools.NewErrorResult(fmt.Errorf("invalid oem_update_run payload: %w", err), time.Since(start).Milliseconds())
	}
	req.CommandID = cmd.ID

	// Vendor lanes are Windows only in v1. Quiet: the API should not send
	// this, and a non-Windows agent has nothing to warn about.
	if oemGOOS != "windows" {
		log.Debug("oem_update_run on a non-Windows agent", "goos", oemGOOS)
		return oemCommandResult(oemRefusal(req.Lane, oemupdates.OutcomeNotSupported, "os_not_supported"), time.Since(start).Milliseconds())
	}
	// Its own check: the heartbeat's privilege check only warns (§4.4).
	if !oemElevated() {
		log.Warn("oem_update_run refused: agent is not elevated", "commandId", cmd.ID)
		return oemCommandResult(oemRefusal(req.Lane, oemupdates.OutcomeFailed, "not_elevated"), time.Since(start).Milliseconds())
	}
	lane, ok := oemLaneFor(req.Lane)
	if !ok {
		return oemCommandResult(oemRefusal(req.Lane, oemupdates.OutcomeNotSupported, "lane_not_built"), time.Since(start).Milliseconds())
	}
	ctx, cancel := h.oemRunContext()
	defer cancel()
	result := oemRun(ctx, req, lane, oemDepsFor(h, cmd.ID))
	return oemCommandResult(result, time.Since(start).Milliseconds())
}

func oemRefusal(lane string, outcome oemupdates.Outcome, code string) oemupdates.RunResult {
	return oemupdates.RunResult{Lane: lane, Outcome: outcome, ErrorCode: &code, Takeover: oemupdates.TakeoverNotAttempted}
}

// oemCommandResult carries the run result as stdout JSON. The command status
// follows the outcome so the generic command views read it plainly: installed,
// nothing to do, or partly done is "completed"; everything else is "failed".
// The run result is always the authority.
func oemCommandResult(r oemupdates.RunResult, durationMs int64) tools.CommandResult {
	out := tools.NewSuccessResult(r, durationMs)
	if out.Status != "completed" {
		return out
	}
	switch r.Outcome {
	case oemupdates.OutcomeSuccess, oemupdates.OutcomeSuccessRebootRequired, oemupdates.OutcomeNoUpdates, oemupdates.OutcomePartial:
	default:
		out.Status = "failed"
		out.ExitCode = 1
		out.Error = "vendor update outcome: " + string(r.Outcome)
	}
	return out
}

// oemRunContext ends when the agent stops. A firmware install ignores it (the
// runner never kills a flash); everything else stops.
func (h *Heartbeat) oemRunContext() (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(context.Background())
	if h != nil && h.stopChan != nil {
		stop := h.stopChan
		go func() {
			select {
			case <-stop:
				cancel()
			case <-ctx.Done():
			}
		}()
	}
	return ctx, cancel
}

func productionOemDeps(h *Heartbeat, commandID string) oemupdates.Deps {
	var preflight func() error
	if h != nil && h.config != nil {
		opts := patching.PreflightOptionsFromConfig(h.config)
		// Power is the run's own, stricter gate for firmware, and the API
		// owns the window; the shared preflight keeps disk and service health.
		opts.CheckACPower = false
		opts.CheckMaintWindow = false
		preflight = func() error { return patching.RunPreflight(opts).FirstError() }
	}
	var progress func(string)
	if reporter := h.commandProgressReporter(commandID); reporter != nil {
		progress = func(stage string) { reporter(stage) }
	}
	return oemupdates.ProductionDeps(preflight, progress)
}

// oemInterruptedResultBody is the journal's stdout for an oem_update_run whose
// result the previous process never handed off, when the marker belongs to
// that command: its interrupted result if the run never ended, or its recorded
// outcome if it ended and only the delivery was lost.
func oemInterruptedResultBody(commandID string) (string, bool) {
	m, err := oemupdates.ReadMarker(oemStore())
	if err != nil || m.CommandID != commandID {
		return "", false
	}
	result := m.InterruptedResult()
	if m.EndedAt != nil {
		// The run ended; only its hand-off was lost. The outcome stands.
		lost, ok := m.LostResult()
		if !ok {
			return "", false
		}
		result = lost
	}
	body, err := json.Marshal(result)
	if err != nil {
		return "", false
	}
	return string(body), true
}

// recoverOemRuns closes the marker of a run the previous process died in. It
// runs after the journal has read that marker and before any command runs.
func recoverOemRuns() {
	if oemGOOS != "windows" {
		return
	}
	if err := oemupdates.RecoverInterrupted(oemupdates.Deps{Store: oemStore(), Clock: nil}); err != nil {
		log.Warn("could not close an interrupted vendor update run", "error", err.Error())
	}
}

// verifyOemUpdates reports post-reboot BitLocker and BIOS state for firmware
// installs. Background, bounded; anything undelivered waits for the next start.
func (h *Heartbeat) verifyOemUpdates() {
	if oemGOOS != "windows" {
		return
	}
	ctx, cancel := h.oemRunContext()
	defer cancel()
	deps := oemupdates.ProductionDeps(nil, nil)
	// The guard goes first: a volume this agent suspended comes back before anything
	// reports its state.
	watch := &oemBitLockerWatch{}
	watch.pass(ctx, deps)
	if err := oemVerifyPending(ctx, deps, h.putOemVerification); err != nil && !errors.Is(err, context.Canceled) {
		log.Warn("vendor update verification incomplete", "error", err.Error())
	}
	// A suspended volume can wait days for its reboot, and this process may never
	// restart in that time, so the guard keeps checking for as long as it runs.
	ticker := time.NewTicker(oemBitLockerTick)
	defer ticker.Stop()
	watch.run(ctx, deps, ticker.C, func() {
		if err := oemVerifyPending(ctx, deps, h.putOemVerification); err != nil && !errors.Is(err, context.Canceled) {
			log.Warn("vendor update verification incomplete", "error", err.Error())
		}
	})
}

// oemBitLockerTick is how often the BitLocker guard looks at its record. Without
// a record that is one small file read.
const oemBitLockerTick = 10 * time.Minute

// Seams, so the watch tests on any OS without a volume.
var (
	oemResumeBitLocker = oemupdates.ResumeBitLocker
	oemGuardDeps       = oemupdates.ProductionGuardDeps
	oemVerifyPending   = oemupdates.VerifyPending
)

// oemBitLockerWatch drives the guard's resume pass.
type oemBitLockerWatch struct {
	lastFailure string
}

// pass runs once and says whether a record closed, which is when a verification
// held back for it can go. A failure warns once per distinct message.
func (w *oemBitLockerWatch) pass(ctx context.Context, deps oemupdates.Deps) (closed bool) {
	res, err := oemResumeBitLocker(ctx, deps, oemGuardDeps())
	if err != nil {
		if msg := err.Error(); msg != w.lastFailure && !errors.Is(err, context.Canceled) {
			w.lastFailure = msg
			log.Warn("BitLocker guard pass failed; it keeps trying", "error", msg)
		}
		return false
	}
	w.lastFailure = ""
	return res.Action == bitlockerguard.ActionResumed || res.Action == bitlockerguard.ActionCleared
}

func (w *oemBitLockerWatch) run(ctx context.Context, deps oemupdates.Deps, tick <-chan time.Time, verify func()) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick:
			if w.pass(ctx, deps) {
				verify()
			}
		}
	}
}

func (h *Heartbeat) putOemVerification(v oemupdates.Verification) error {
	body, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("%w: %v", oemupdates.ErrVerificationRejected, err)
	}
	url := h.agentRouteURL("oem-updates/verification")
	if !h.loopReady(http.MethodPut, url) {
		// Deferred by a server Retry-After: transient, kept for a later try.
		return errors.New("verification route deferred by server Retry-After")
	}
	headers := http.Header{
		"Content-Type":  {"application/json"},
		"Authorization": {h.authHeader()},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	resp, err := httputil.Do(ctx, h.httpClient(), http.MethodPut, url, body, headers, h.retryCfg)
	if err != nil {
		h.noteLoopAnswer(http.MethodPut, url, err)
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return nil
	case resp.StatusCode == http.StatusNotFound:
		return oemupdates.ErrVerificationNotFound
	case resp.StatusCode == http.StatusBadRequest, resp.StatusCode == http.StatusForbidden,
		resp.StatusCode == http.StatusConflict, resp.StatusCode == http.StatusUnprocessableEntity:
		return fmt.Errorf("%w: http %d", oemupdates.ErrVerificationRejected, resp.StatusCode)
	default:
		return fmt.Errorf("verification: http %d", resp.StatusCode)
	}
}
