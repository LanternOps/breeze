package heartbeat

import (
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// handleCollectAuditPolicy gathers the current OS audit-policy state and returns it as JSON.
func handleCollectAuditPolicy(_ *Heartbeat, _ Command) tools.CommandResult {
	start := time.Now()
	snapshot, err := collectors.CollectAuditPolicyState()
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	return tools.NewSuccessResult(snapshot, time.Since(start).Milliseconds())
}

// handleApplyAuditPolicyBaseline applies audit-policy baseline settings on the endpoint.
func handleApplyAuditPolicyBaseline(_ *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	rawSettings, ok := cmd.Payload["settings"]
	if !ok {
		return tools.NewErrorResult(fmt.Errorf("missing settings payload"), time.Since(start).Milliseconds())
	}

	settings, ok := rawSettings.(map[string]any)
	if !ok {
		return tools.NewErrorResult(fmt.Errorf("settings payload must be an object"), time.Since(start).Milliseconds())
	}

	if len(settings) == 0 {
		return tools.NewErrorResult(fmt.Errorf("settings payload is empty"), time.Since(start).Milliseconds())
	}

	result, err := collectors.ApplyAuditPolicyBaseline(settings)
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	return tools.NewSuccessResult(result, time.Since(start).Milliseconds())
}
