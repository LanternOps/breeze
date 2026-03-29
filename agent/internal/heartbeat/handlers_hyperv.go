//go:build windows

package heartbeat

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/hyperv"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdHypervDiscover] = handleHypervDiscover
	handlerRegistry[tools.CmdHypervBackup] = handleHypervBackup
	handlerRegistry[tools.CmdHypervRestore] = handleHypervRestore
	handlerRegistry[tools.CmdHypervCheckpoint] = handleHypervCheckpoint
	handlerRegistry[tools.CmdHypervVMState] = handleHypervVMState
}

func handleHypervDiscover(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	vms, err := hyperv.DiscoverVMs()
	if err != nil {
		slog.Warn("hyperv discover failed", "error", err.Error())
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	data, _ := json.Marshal(vms)
	return tools.NewSuccessResult(string(data), time.Since(start).Milliseconds())
}

func handleHypervBackup(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	vmName := tools.GetPayloadString(cmd.Payload, "vmName", "")
	if vmName == "" {
		return tools.NewErrorResult(fmt.Errorf("missing required field: vmName"), time.Since(start).Milliseconds())
	}

	exportPath := tools.GetPayloadString(cmd.Payload, "exportPath", "")
	if exportPath == "" {
		return tools.NewErrorResult(fmt.Errorf("missing required field: exportPath"), time.Since(start).Milliseconds())
	}

	consistencyType := tools.GetPayloadString(cmd.Payload, "consistencyType", "application")

	result, err := hyperv.ExportVM(vmName, exportPath, consistencyType)
	if err != nil {
		slog.Warn("hyperv backup failed", "vm", vmName, "error", err.Error())
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	data, _ := json.Marshal(result)
	return tools.NewSuccessResult(string(data), time.Since(start).Milliseconds())
}

func handleHypervRestore(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	exportPath := tools.GetPayloadString(cmd.Payload, "exportPath", "")
	if exportPath == "" {
		return tools.NewErrorResult(fmt.Errorf("missing required field: exportPath"), time.Since(start).Milliseconds())
	}

	vmName := tools.GetPayloadString(cmd.Payload, "vmName", "")
	generateNewID := tools.GetPayloadBool(cmd.Payload, "generateNewId", true)

	result, err := hyperv.ImportVM(exportPath, vmName, generateNewID)
	if err != nil {
		slog.Warn("hyperv restore failed", "exportPath", exportPath, "error", err.Error())
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	data, _ := json.Marshal(result)
	return tools.NewSuccessResult(string(data), time.Since(start).Milliseconds())
}

func handleHypervCheckpoint(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	vmName := tools.GetPayloadString(cmd.Payload, "vmName", "")
	if vmName == "" {
		return tools.NewErrorResult(fmt.Errorf("missing required field: vmName"), time.Since(start).Milliseconds())
	}

	action := tools.GetPayloadString(cmd.Payload, "action", "")
	if action == "" {
		return tools.NewErrorResult(fmt.Errorf("missing required field: action"), time.Since(start).Milliseconds())
	}

	checkpointName := tools.GetPayloadString(cmd.Payload, "checkpointName", "")

	result, err := hyperv.ManageCheckpoint(vmName, action, checkpointName)
	if err != nil {
		slog.Warn("hyperv checkpoint failed", "vm", vmName, "action", action, "error", err.Error())
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	data, _ := json.Marshal(result)
	return tools.NewSuccessResult(string(data), time.Since(start).Milliseconds())
}

func handleHypervVMState(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	vmName := tools.GetPayloadString(cmd.Payload, "vmName", "")
	if vmName == "" {
		return tools.NewErrorResult(fmt.Errorf("missing required field: vmName"), time.Since(start).Milliseconds())
	}

	targetState := tools.GetPayloadString(cmd.Payload, "state", "")
	if targetState == "" {
		return tools.NewErrorResult(fmt.Errorf("missing required field: state"), time.Since(start).Milliseconds())
	}

	result, err := hyperv.ChangeVMState(vmName, targetState)
	if err != nil {
		slog.Warn("hyperv vm state change failed", "vm", vmName, "state", targetState, "error", err.Error())
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	data, _ := json.Marshal(result)
	return tools.NewSuccessResult(string(data), time.Since(start).Milliseconds())
}
