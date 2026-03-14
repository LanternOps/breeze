package heartbeat

import (
	"time"

	"github.com/breeze-rmm/agent/internal/cis"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdCisBenchmark] = handleCisBenchmark
	handlerRegistry[tools.CmdApplyCisRemediation] = handleApplyCisRemediation
}

// handleCisBenchmark runs all CIS benchmark checks and returns findings.
func handleCisBenchmark(_ *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	level := tools.GetPayloadString(cmd.Payload, "level", "l1")
	exclusions := tools.GetPayloadStringSlice(cmd.Payload, "customExclusions")
	benchmarkVersion := tools.GetPayloadString(cmd.Payload, "benchmarkVersion", "")

	output := cis.RunBenchmark(level, exclusions)
	output.Summary["benchmarkVersion"] = benchmarkVersion
	output.Summary["level"] = level

	return tools.NewSuccessResult(output, time.Since(start).Milliseconds())
}

// handleApplyCisRemediation applies a remediation action for a specific CIS check.
func handleApplyCisRemediation(_ *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	checkID, errResult := tools.RequirePayloadString(cmd.Payload, "checkId")
	if errResult != nil {
		return *errResult
	}

	action := tools.GetPayloadString(cmd.Payload, "action", "apply")

	result := cis.Remediate(checkID, action, cmd.Payload)
	return tools.NewSuccessResult(result, time.Since(start).Milliseconds())
}
