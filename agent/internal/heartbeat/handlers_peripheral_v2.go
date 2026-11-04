package heartbeat

import (
	"bytes"
	"encoding/json"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/peripheral"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

var applyPeripheralPolicyV2 = peripheral.ApplyPeripheralPolicyV2WithEvents
var newPeripheralPolicyV2Store = peripheral.NewStore
var detectPeripheralsV2 = peripheral.DetectPeripherals
var newPeripheralPolicyV2Enforcer = peripheral.NewEnforcer
var submitPeripheralEventsV2 = func(h *Heartbeat, events []peripheral.PeripheralEvent) error {
	return h.submitPeripheralEvents(events)
}

func init() {
	handlerRegistry[tools.CmdPeripheralPolicySyncV2] = handlePeripheralPolicySyncV2
}

func handlePeripheralPolicySyncV2(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	raw, err := json.Marshal(cmd.Payload)
	if err != nil {
		return tools.NewErrorResult(fmt.Errorf("marshal peripheral v2 payload: %w", err), time.Since(start).Milliseconds())
	}
	var envelope peripheral.PeripheralPolicyEnvelopeV2
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		return tools.NewErrorResult(fmt.Errorf("decode peripheral v2 payload: %w", err), time.Since(start).Milliseconds())
	}
	if h == nil || h.config == nil {
		return tools.NewErrorResult(fmt.Errorf("peripheral v2 local identity unavailable"), time.Since(start).Milliseconds())
	}

	local := peripheral.PeripheralPolicyIdentityV2{
		DeviceID: h.config.DeviceID,
		OrgID:    h.config.OrgID,
		SiteID:   h.config.SiteID,
	}
	result, events := applyPeripheralPolicyV2(envelope, local, newPeripheralPolicyV2Store(), peripheral.PolicyV2Dependencies{
		Detect:   detectPeripheralsV2,
		Enforcer: newPeripheralPolicyV2Enforcer(),
		Classes:  peripheral.EnforceableClasses(),
	})
	// #9618: report the scan this apply enforced. The Activity Log, the
	// device Peripherals tab and the peripheral.blocked alert all read
	// peripheral_events, which only this submission writes. The policy is
	// already applied and persisted, so a reporting failure is logged and
	// never changes the delivery result the controller reconciles on.
	if len(events) > 0 {
		cmdLog := log.With("commandId", cmd.ID, "commandType", cmd.Type)
		if err := submitPeripheralEventsV2(h, events); err != nil {
			cmdLog.Warn("failed to submit peripheral events", "count", len(events), "error", err.Error())
		} else {
			cmdLog.Info("peripheral events submitted", "count", len(events))
		}
	}
	commandResult := tools.NewSuccessResult(result, time.Since(start).Milliseconds())
	commandResult.Result = result
	return commandResult
}
