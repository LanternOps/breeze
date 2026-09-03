package heartbeat

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/breeze-rmm/agent/internal/patching"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// Accepted bounds for the schedule_reboot deferral budget (#3207). They mirror
// the API-side CHECK constraints and zod validator exactly
// (apps/api/src/services/patchRebootHandler.ts: MAX_REBOOT_DEFERRALS,
// MIN/MAX_REBOOT_DEFERRAL_MINUTES). Duplicated rather than derived because the
// agent must reject a payload the API could not have produced, whatever version
// of the API sent it.
const (
	minPayloadDeferrals       = 1
	maxPayloadDeferrals       = 10
	minPayloadDeferralMinutes = 5
	maxPayloadDeferralMinutes = 1440
)

func init() {
	handlerRegistry[tools.CmdPatchScan] = handlePatchScan
	handlerRegistry[tools.CmdInstallPatches] = handleInstallPatches
	handlerRegistry[tools.CmdRollbackPatches] = handleRollbackPatches
	handlerRegistry[tools.CmdDownloadPatches] = handleDownloadPatches
	handlerRegistry[tools.CmdScheduleReboot] = handleScheduleReboot
	handlerRegistry[tools.CmdCancelReboot] = handleCancelReboot
	handlerRegistry[tools.CmdGetRebootStatus] = handleGetRebootStatus
}

func handlePatchScan(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	source := tools.GetPayloadString(cmd.Payload, "source", "")

	if source != "" {
		log.Info("patch scan requested", "source", source)
	}

	pendingItems, installedItems, coveredSources, err := h.collectPatchInventory()
	if err != nil && len(pendingItems) == 0 && len(installedItems) == 0 {
		log.Error("patch scan failed", "source", source, "error", err.Error())
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	if err != nil {
		// Partial success: at least one provider produced items but another
		// scan errored. The failed provider is excluded from coveredSources, so
		// its bucket won't be swept — surface the error so that tombstoning
		// change is explainable rather than silently swallowed (#2217).
		log.Warn("patch scan partial failure; some providers did not scan",
			"source", source, "error", err.Error())
	}
	if source != "" {
		// A targeted upload sweeps the source's pending rows before re-upserting.
		// If this source's provider didn't actually scan (skipped or failed),
		// uploading the filtered-empty result would tombstone rows the scan never
		// looked at (#2217) — fail the command instead.
		if coveredSources != nil && !slices.Contains(coveredSources, source) {
			err := fmt.Errorf("patch source %q could not be scanned (provider skipped or failed)", source)
			log.Warn("patch scan did not cover requested source", "source", source)
			return tools.NewErrorResult(err, time.Since(start).Milliseconds())
		}
		pendingItems = filterPatchInventoryItemsBySource(pendingItems, source)
		installedItems = filterPatchInventoryItemsBySource(installedItems, source)
	}
	installedItems = installedPatchStateItems(installedItems)

	pendingErr, installedErr := h.sendPatchInventoryData(pendingItems, installedItems, source, source == "", coveredSources)
	if pendingErr != nil {
		err = fmt.Errorf("pending patch inventory send failed: %w", pendingErr)
		log.Error("patch scan inventory send failed",
			"source", source,
			"pendingCount", len(pendingItems),
			"installedCount", len(installedItems),
			"error", err.Error(),
		)
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	if err != nil || installedErr != nil {
		warning := errorString(err)
		if installedErr != nil {
			if warning != "" {
				warning += "; "
			}
			warning += "installed patch inventory send failed: " + installedErr.Error()
		}
		log.Warn("patch scan completed with warning",
			"source", source,
			"pendingCount", len(pendingItems),
			"installedCount", len(installedItems),
			"error", warning,
		)
		err = errors.New(warning)
	} else {
		log.Info("patch scan completed",
			"source", source,
			"pendingCount", len(pendingItems),
			"installedCount", len(installedItems),
		)
	}

	result := map[string]any{
		"pendingCount":   len(pendingItems),
		"installedCount": len(installedItems),
		"warning":        errorString(err),
	}
	// Report the per-user winget coverage axis explicitly. Without it a device
	// where nobody was logged in is indistinguishable from one with no per-user
	// updates, and the UI would under-report rather than say "per-user apps not
	// scanned" (#2727). Only present on devices with a winget provider.
	if userScan, present := h.wingetUserScopeStatus(); present {
		result["userScopeScanned"] = userScan.Scanned
		if !userScan.Scanned && userScan.Reason != "" {
			result["userScopeSkipReason"] = userScan.Reason
		}
	}
	return tools.NewSuccessResult(result, time.Since(start).Milliseconds())
}

func filterPatchInventoryItemsBySource(items []map[string]any, source string) []map[string]any {
	filtered := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if itemSource, ok := item["source"].(string); ok && itemSource == source {
			filtered = append(filtered, item)
		}
	}
	return filtered
}

func handleInstallPatches(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	// Run pre-flight checks before install
	opts := patching.PreflightOptionsFromConfig(h.config)
	pfResult := patching.RunPreflight(opts)
	for _, check := range pfResult.Checks {
		if check.Passed {
			log.Debug("preflight passed", "check", check.Name, "message", check.Message)
		} else {
			log.Warn("preflight failed", "check", check.Name, "message", check.Message)
		}
	}
	if !pfResult.OK {
		return tools.NewErrorResult(pfResult.FirstError(), time.Since(start).Milliseconds())
	}

	return h.executePatchInstallCommand(cmd.Payload, false)
}

func handleRollbackPatches(h *Heartbeat, cmd Command) tools.CommandResult {
	return h.executePatchInstallCommand(cmd.Payload, true)
}

func handleDownloadPatches(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	// Run pre-flight for downloads (disk + service health only, skip battery/maintenance)
	opts := patching.PreflightOptionsFromConfig(h.config)
	opts.CheckACPower = false
	opts.CheckMaintWindow = false
	pfResult := patching.RunPreflight(opts)
	for _, check := range pfResult.Checks {
		if !check.Passed {
			log.Warn("download preflight failed", "check", check.Name, "message", check.Message)
		}
	}
	if !pfResult.OK {
		return tools.NewErrorResult(pfResult.FirstError(), time.Since(start).Milliseconds())
	}

	if h.patchMgr == nil || len(h.patchMgr.ProviderIDs()) == 0 {
		return tools.NewErrorResult(fmt.Errorf("no patch providers available"), time.Since(start).Milliseconds())
	}

	patchIDs := tools.GetPayloadStringSlice(cmd.Payload, "patchIds")
	if len(patchIDs) == 0 {
		return tools.NewErrorResult(fmt.Errorf("no patchIds provided"), time.Since(start).Milliseconds())
	}

	// Progress callback sends events via WebSocket
	var progressFn patching.ProgressCallback
	if h.wsClient != nil {
		progressFn = func(event patching.ProgressEvent) {
			_ = h.wsClient.SendPatchProgress(cmd.ID, event)
		}
	}

	results, err := h.patchMgr.DownloadPatches(patchIDs, progressFn)
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	successCount := 0
	failedCount := 0
	downloadResults := make([]map[string]any, len(results))
	for i, r := range results {
		downloadResults[i] = map[string]any{
			"patchId": r.PatchID,
			"success": r.Success,
			"message": r.Message,
		}
		if r.Success {
			successCount++
		} else {
			failedCount++
		}
	}

	return tools.NewSuccessResult(map[string]any{
		"downloadedCount": successCount,
		"failedCount":     failedCount,
		"results":         downloadResults,
	}, time.Since(start).Milliseconds())
}

func handleScheduleReboot(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	if h.rebootMgr == nil {
		return tools.NewErrorResult(fmt.Errorf("reboot manager not available"), time.Since(start).Milliseconds())
	}

	// Strict parse: the 1-10080 range check below would happily pass the
	// silent 60-minute default, so a malformed delayMinutes used to schedule a
	// reboot an hour out instead of when the operator asked (issue #3373).
	delayMinutes, err := tools.ParsePayloadInt(cmd.Payload, "delayMinutes", 60)
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	if delayMinutes < 1 || delayMinutes > 10080 { // 1 min to 7 days
		return tools.NewErrorResult(fmt.Errorf("delayMinutes must be 1-10080, got %d", delayMinutes), time.Since(start).Milliseconds())
	}
	reason := tools.GetPayloadString(cmd.Payload, "reason", "Scheduled by administrator")
	source := tools.GetPayloadString(cmd.Payload, "source", "manual")

	delay := time.Duration(delayMinutes) * time.Minute
	deadline := time.Now().Add(delay)

	// Allow overriding deadline via payload. Strict since #3207: a malformed
	// deadline used to be swallowed, leaving deadline = now+delay, which now
	// silently collapses the deferral budget to nothing. Fail the command
	// instead of quietly delivering a different policy than the API asked for.
	if deadlineStr := tools.GetPayloadString(cmd.Payload, "deadline", ""); deadlineStr != "" {
		parsed, err := time.Parse(time.RFC3339, deadlineStr)
		if err != nil {
			return tools.NewErrorResult(fmt.Errorf("invalid deadline %q: %w", deadlineStr, err), time.Since(start).Milliseconds())
		}
		deadline = parsed
	}

	// Deferral budget (#3207). Absent keys mean OFF: an old API never sends
	// them, and "not mentioned" must never widen what the agent will do.
	// Ranges mirror the API-side CHECK constraints so a forged or corrupted
	// payload is REJECTED rather than clamped — a silent clamp is how #3373
	// turned a malformed delayMinutes into a 60-minute reboot.
	opts := patching.RebootOptions{}
	if tools.GetPayloadBool(cmd.Payload, "allowDeferral", false) {
		maxDeferrals, err := tools.ParsePayloadInt(cmd.Payload, "maxDeferrals", 0)
		if err != nil {
			return tools.NewErrorResult(err, time.Since(start).Milliseconds())
		}
		deferralMinutes, err := tools.ParsePayloadInt(cmd.Payload, "deferralMinutes", 0)
		if err != nil {
			return tools.NewErrorResult(err, time.Since(start).Milliseconds())
		}
		if maxDeferrals < minPayloadDeferrals || maxDeferrals > maxPayloadDeferrals {
			return tools.NewErrorResult(
				fmt.Errorf("maxDeferrals must be %d-%d, got %d", minPayloadDeferrals, maxPayloadDeferrals, maxDeferrals),
				time.Since(start).Milliseconds())
		}
		if deferralMinutes < minPayloadDeferralMinutes || deferralMinutes > maxPayloadDeferralMinutes {
			return tools.NewErrorResult(
				fmt.Errorf("deferralMinutes must be %d-%d, got %d", minPayloadDeferralMinutes, maxPayloadDeferralMinutes, deferralMinutes),
				time.Since(start).Milliseconds())
		}
		opts.Deferral = patching.DeferralPolicy{
			Allowed:         true,
			MaxDeferrals:    maxDeferrals,
			DeferralMinutes: deferralMinutes,
		}
	}

	if err := h.rebootMgr.ScheduleWithOptions(delay, deadline, reason, source, opts); err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	state := h.rebootMgr.State()
	stateMap := rebootStateToMap(state)

	return tools.NewSuccessResult(stateMap, time.Since(start).Milliseconds())
}

func handleCancelReboot(h *Heartbeat, _ Command) tools.CommandResult {
	start := time.Now()
	if h.rebootMgr == nil {
		return tools.NewErrorResult(fmt.Errorf("reboot manager not available"), time.Since(start).Milliseconds())
	}

	if err := h.rebootMgr.Cancel(); err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	return tools.NewSuccessResult(map[string]any{"cancelled": true}, time.Since(start).Milliseconds())
}

func handleGetRebootStatus(h *Heartbeat, _ Command) tools.CommandResult {
	start := time.Now()
	if h.rebootMgr == nil {
		return tools.NewErrorResult(fmt.Errorf("reboot manager not available"), time.Since(start).Milliseconds())
	}

	state := h.rebootMgr.State()
	stateMap := rebootStateToMap(state)

	return tools.NewSuccessResult(stateMap, time.Since(start).Milliseconds())
}

func rebootStateToMap(state patching.RebootState) map[string]any {
	stateJSON, err := json.Marshal(state)
	if err != nil {
		return map[string]any{"error": err.Error()}
	}
	var stateMap map[string]any
	if err := json.Unmarshal(stateJSON, &stateMap); err != nil {
		return map[string]any{"error": err.Error()}
	}
	return stateMap
}
