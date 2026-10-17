package heartbeat

import (
	"context"
	"errors"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdPamReconcileV2] = handlePamReconcileV2
}

// Recovery re-runs independent cleanup proof, including durable observation
// delivery. It cannot erase an unreadable ledger or a quarantined outbox.
func handlePamReconcileV2(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	var payload struct {
		ProtocolVersion int    `json:"protocolVersion"`
		DeviceID        string `json:"deviceId"`
		OrgID           string `json:"orgId"`
	}
	if err := decodePamLifetimePayload(cmd.Payload, &payload); err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	if payload.ProtocolVersion != 1 {
		return tools.NewErrorResult(errors.New("unsupported PAM reconciliation reset protocol"), time.Since(start).Milliseconds())
	}
	if err := validatePamLifetimeLocalIdentity(h, payload.DeviceID, payload.OrgID); err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	if h.pamLifetimeManager == nil {
		return tools.NewErrorResult(errors.New("PAM lifetime manager unavailable"), time.Since(start).Milliseconds())
	}
	// Atomically admit recovery against startup reconciliation, another reset,
	// and policy updates. Reading the running flag alone is a check-then-act
	// race: startup could begin its scan immediately after the check.
	if !h.pamPolicyMu.TryLock() {
		return tools.NewErrorResult(errors.New("PAM lifetime reconciliation in progress"), time.Since(start).Milliseconds())
	}
	defer h.finishPAMPolicyOperation()
	ctx, cancel := context.WithTimeout(context.Background(), pamLifecycleOperationTimeout)
	defer cancel()
	results := h.reconcileAndReapplyPAMPolicyLocked(ctx)
	data := map[string]any{
		"verificationAvailable":     h.pamVerificationAvailable.Load(),
		"reconciliationReady":       h.pamReconciled.Load(),
		"observationTransportReady": h.pamReceivedObservationReady.Load(),
		"observationCount":          len(results),
	}
	if !h.pamVerificationAvailable.Load() || !h.pamReconciled.Load() || !h.pamReceivedObservationReady.Load() {
		result := tools.NewErrorResult(errors.New("PAM reconciliation remains unavailable; unresolved ledger or pending/quarantined evidence"), time.Since(start).Milliseconds())
		result.Result = data
		return result
	}
	return tools.NewSuccessResult(data, time.Since(start).Milliseconds())
}
