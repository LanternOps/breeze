package heartbeat

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/peripheral"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdPeripheralPolicySync] = handlePeripheralPolicySync
}

func handlePeripheralPolicySync(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	cmdLog := log.With("commandId", cmd.ID, "commandType", cmd.Type)

	// Decode the sync payload from the command's generic map.
	raw, err := json.Marshal(cmd.Payload)
	if err != nil {
		return tools.NewErrorResult(fmt.Errorf("marshal payload: %w", err), time.Since(start).Milliseconds())
	}

	var payload peripheral.PolicySyncPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return tools.NewErrorResult(fmt.Errorf("unmarshal policy sync payload: %w", err), time.Since(start).Milliseconds())
	}

	cmdLog.Info("received peripheral policy sync",
		"reason", payload.Reason,
		"policyCount", len(payload.Policies),
		"changedPolicies", len(payload.ChangedPolicyIDs),
	)

	// Persist policies to disk.
	store := peripheral.NewStore()
	if err := store.Save(payload.Policies); err != nil {
		cmdLog.Error("failed to save peripheral policies", "error", err.Error())
		return tools.NewErrorResult(fmt.Errorf("save policies: %w", err), time.Since(start).Milliseconds())
	}

	// Run one-shot peripheral scan.
	detected, err := peripheral.DetectPeripherals()
	if err != nil {
		cmdLog.Warn("peripheral detection failed", "error", err.Error())
		return tools.NewSuccessResult(map[string]any{
			"policiesSaved": len(payload.Policies),
			"scanError":     err.Error(),
		}, time.Since(start).Milliseconds())
	}

	cmdLog.Info("peripheral scan complete", "devicesFound", len(detected))

	// Evaluate detected devices against policies.
	results := peripheral.Evaluate(detected, payload.Policies)
	events := peripheral.ToEvents(results)

	// Submit events to the server.
	if len(events) > 0 {
		if err := h.submitPeripheralEvents(events); err != nil {
			cmdLog.Error("failed to submit peripheral events", "error", err.Error())
			return tools.NewSuccessResult(map[string]any{
				"policiesSaved":  len(payload.Policies),
				"devicesFound":   len(detected),
				"eventsGenerated": len(events),
				"submitError":    err.Error(),
			}, time.Since(start).Milliseconds())
		}
		cmdLog.Info("peripheral events submitted", "count", len(events))
	}

	return tools.NewSuccessResult(map[string]any{
		"policiesSaved":   len(payload.Policies),
		"devicesFound":    len(detected),
		"eventsSubmitted": len(events),
	}, time.Since(start).Milliseconds())
}
