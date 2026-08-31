package heartbeat

import (
	"bytes"
	"encoding/json"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/peripheral"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

var applyPeripheralPolicyV2 = peripheral.ApplyPeripheralPolicyV2
var newPeripheralPolicyV2Store = peripheral.NewStore
var detectPeripheralsV2 = peripheral.DetectPeripherals
var newPeripheralPolicyV2Enforcer = peripheral.NewEnforcer

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
	result := applyPeripheralPolicyV2(envelope, local, newPeripheralPolicyV2Store(), peripheral.PolicyV2Dependencies{
		Detect:   detectPeripheralsV2,
		Enforcer: newPeripheralPolicyV2Enforcer(),
		Classes:  peripheral.EnforceableClasses(),
	})
	commandResult := tools.NewSuccessResult(result, time.Since(start).Milliseconds())
	commandResult.Result = result
	return commandResult
}
