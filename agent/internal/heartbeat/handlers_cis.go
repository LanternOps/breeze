package heartbeat

import (
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/cis"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// cisRemediate is a seam over cis.Remediate so handler tests can drive both
// the success and failure branches on any host OS.
var cisRemediate = cis.Remediate

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

	result := cisRemediate(checkID, action, cmd.Payload)
	cmdResult := tools.NewSuccessResult(result, time.Since(start).Milliseconds())
	if result.Success || cmdResult.Status != "completed" {
		return cmdResult
	}

	// #9604: a remediation that was not applied (unimplemented check, failed
	// write) is a FAILED command. Before this, the only failure signal was
	// `success:false` inside stdout, and the server recorded the action as
	// completed. The remediation JSON stays on Stdout so the server still gets
	// the before-state of a partially applied change.
	errMsg := result.Error
	if errMsg == "" {
		errMsg = fmt.Sprintf("CIS remediation for check %s did not succeed", checkID)
	}
	cmdResult.Status = "failed"
	cmdResult.ExitCode = 1
	cmdResult.Error = errMsg
	return cmdResult
}
