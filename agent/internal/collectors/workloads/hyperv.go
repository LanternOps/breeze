package workloads

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"strconv"
	"strings"
	"time"
)

// hypervScript lists the host's VMs with Get-VM only and prints a JSON array of
// exactly the allowlisted fields (spec §5.4). It is fixed text: nothing from
// the host or the server is interpolated. It is a single line with single
// quotes only, because it travels as one argv element through Go's Windows
// command-line quoting and PowerShell's -Command parser.
//
// Calculated properties pin the shape across PowerShell versions: Id as a
// string, State as its enum number, and Uptime as whole seconds (a TimeSpan
// serializes differently in 5.1 and 7). -InputObject @(...) prints an array for
// zero and one VM as well. Exit codes: hypervExitCmdletMissing when the Hyper-V
// module is not installed, hypervExitPermissionDenied when Get-VM is refused,
// 1 for any other failure.
const hypervScript = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; ` +
	`try { $vms = @(Get-VM) } ` +
	`catch [System.Management.Automation.CommandNotFoundException] { exit 3 } ` +
	`catch { if ($_.CategoryInfo.Category -eq 'PermissionDenied') { exit 5 }; exit 1 }; ` +
	`$out = @($vms | ForEach-Object { [pscustomobject]@{ ` +
	`Id = [string]$_.Id; Name = [string]$_.Name; State = [int]$_.State; ` +
	`ProcessorCount = [int]$_.ProcessorCount; MemoryAssigned = [int64]$_.MemoryAssigned; ` +
	`MemoryStartup = [int64]$_.MemoryStartup; UptimeSeconds = [int64]$_.Uptime.TotalSeconds } }); ` +
	`ConvertTo-Json -InputObject $out -Compress -Depth 2`

const (
	hypervExitCmdletMissing    = 3
	hypervExitPermissionDenied = 5
)

// hypervArgs is the complete argv after the PowerShell path; allowedCommand
// accepts PowerShell only with exactly these arguments.
var hypervArgs = []string{"-NoProfile", "-NonInteractive", "-Command", hypervScript}

// hypervDriver inventories Hyper-V VMs. Detect only queries the vmms service
// (no process is started); Collect runs the fixed Get-VM script, and only while
// vmms is already running.
type hypervDriver struct {
	service    func() serviceState
	version    func() string // host build; never runs a command
	powershell string        // absolute path; "" when it cannot be resolved
	run        cmdRunner
	now        func() time.Time
}

func (d *hypervDriver) Runtime() Runtime { return RuntimeHyperV }

// Detect maps the Hyper-V Virtual Machine Management service:
//
//	service missing (role not installed) -> absent
//	service stopped                      -> present, Reason not_running
//	service running                      -> present
//	query failed                         -> unknown
func (d *hypervDriver) Detect(context.Context) Detection {
	switch d.service() {
	case serviceMissing:
		return Detection{State: DetectionAbsent}
	case serviceStopped:
		return Detection{State: DetectionPresent, Version: d.version(), Reason: ReasonNotRunning}
	case serviceRunning:
		return Detection{State: DetectionPresent, Version: d.version()}
	default:
		return Detection{State: DetectionUnknown, Reason: ReasonUnreachable}
	}
}

// psVM is the allowlist the script prints. State is raw so a host whose
// PowerShell prints the enum name instead of the number still maps.
type psVM struct {
	ID             string          `json:"Id"`
	Name           string          `json:"Name"`
	State          json.RawMessage `json:"State"`
	ProcessorCount int64           `json:"ProcessorCount"`
	MemoryAssigned int64           `json:"MemoryAssigned"`
	MemoryStartup  int64           `json:"MemoryStartup"`
	UptimeSeconds  int64           `json:"UptimeSeconds"`
}

func (d *hypervDriver) Collect(ctx context.Context, det Detection) Result {
	switch det.Reason {
	case ReasonNotRunning:
		return Result{Collection: CollectionUnavailable, Error: ReasonNotRunning}
	case ReasonPermissionDenied:
		return Result{Collection: CollectionPermissionDenied, Error: ReasonPermissionDenied}
	}
	if d.powershell == "" {
		return Result{Collection: CollectionUnavailable, Error: "tool_missing"}
	}
	out, err := d.run(ctx, d.powershell, hypervArgs...)
	if err != nil {
		res := execFailure(err)
		slog.Warn("workloads: Get-VM failed", "code", res.Error, "error", err.Error())
		return res
	}
	switch out.ExitCode {
	case 0:
	case hypervExitCmdletMissing:
		return Result{Collection: CollectionUnavailable, Error: "cmdlet_missing"}
	case hypervExitPermissionDenied:
		return Result{Collection: CollectionPermissionDenied, Error: ReasonPermissionDenied}
	default:
		slog.Warn("workloads: Get-VM failed", "exitCode", out.ExitCode, "stderr", clip(string(out.Stderr), 512))
		return Result{Collection: CollectionError, Error: "command_failed"}
	}
	vms, code := decodePSVMs(out.Stdout)
	if code != "" {
		slog.Warn("workloads: Get-VM output not decodable", "code", code, "bytes", len(out.Stdout))
		return Result{Collection: CollectionError, Error: code}
	}
	now := d.now()
	ws := make([]Workload, 0, len(vms))
	for _, vm := range vms {
		ws = append(ws, mapHyperVVM(vm, now))
	}
	observed := len(ws)
	ws, truncated := orderAndCap(ws)
	if truncated {
		return Result{Collection: CollectionOK, Complete: false, Workloads: ws, ObservedCount: observed, Error: "truncated"}
	}
	return Result{Collection: CollectionOK, Complete: true, Workloads: ws, ObservedCount: observed}
}

// decodePSVMs accepts the script's array and, as a fallback, the single object
// ConvertTo-Json prints for one piped item. Empty output is a failure, not an
// empty host: the script always prints "[]" for a host with no VMs, so silence
// means it did not run to the end.
func decodePSVMs(raw []byte) ([]psVM, string) {
	raw = bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf"))
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return nil, "empty_output"
	}
	var vms []psVM
	if raw[0] == '[' {
		if err := json.Unmarshal(raw, &vms); err != nil {
			return nil, "decode_failed"
		}
		return vms, ""
	}
	var one psVM
	if err := json.Unmarshal(raw, &one); err != nil {
		return nil, "decode_failed"
	}
	return []psVM{one}, ""
}

func mapHyperVVM(vm psVM, now time.Time) Workload {
	state, name := hypervState(vm.State)
	mem := vm.MemoryAssigned
	if mem <= 0 {
		// An Off or Saved VM has no assigned memory; report its startup size.
		mem = vm.MemoryStartup
	}
	w := Workload{
		WorkloadID: strings.ToLower(strings.TrimSpace(vm.ID)),
		Kind:       KindVM,
		Name:       vm.Name,
		State:      state,
		RawState:   strp(name),
		CPUCount:   boundedInt(vm.ProcessorCount, maxCPUCount),
		MemoryMB:   boundedInt(mem/(1<<20), maxMemoryMB),
	}
	if state == StateRunning {
		w.StartedAt = startedAtFromUptime(now, vm.UptimeSeconds)
	}
	w.Bound()
	return w
}

// hypervVMStates maps Msvm VM EnabledState values as Get-VM reports them
// (Microsoft.HyperV.PowerShell.VMState) to the normalized state and the name
// shown as rawState. Saved and hibernated VMs hold no running CPU, so they are
// stopped; transitional states are other.
var hypervVMStates = map[int64]struct{ state, name string }{
	1:     {StateOther, "Other"},
	2:     {StateRunning, "Running"},
	3:     {StateStopped, "Off"},
	4:     {StateOther, "Stopping"},
	6:     {StateStopped, "Saved"},
	9:     {StatePaused, "Paused"},
	10:    {StateOther, "Starting"},
	11:    {StateRestarting, "Reset"},
	32773: {StateOther, "Saving"},
	32776: {StateOther, "Pausing"},
	32777: {StateOther, "Resuming"},
	32779: {StateStopped, "FastSaved"},
	32780: {StateOther, "FastSaving"},
	32781: {StateOther, "ForceShutdown"},
	32782: {StateRestarting, "ForceReboot"},
	32783: {StateStopped, "Hibernated"},
	32784: {StateOther, "ComponentServicing"},
	32785: {StateRunning, "RunningCritical"},
	32786: {StateStopped, "OffCritical"},
	32787: {StateOther, "StoppingCritical"},
	32788: {StateStopped, "SavedCritical"},
	32789: {StatePaused, "PausedCritical"},
	32790: {StateOther, "StartingCritical"},
	32791: {StateRestarting, "ResetCritical"},
	32792: {StateOther, "SavingCritical"},
	32793: {StateOther, "PausingCritical"},
	32794: {StateOther, "ResumingCritical"},
	32795: {StateStopped, "FastSavedCritical"},
	32796: {StateOther, "FastSavingCritical"},
}

// hypervState accepts the enum as a number (the script's form) or as its name.
func hypervState(raw json.RawMessage) (state, name string) {
	if t := bytes.TrimSpace(raw); len(t) == 0 || bytes.Equal(t, []byte("null")) {
		return StateOther, ""
	}
	var n int64
	if err := json.Unmarshal(raw, &n); err == nil {
		if s, ok := hypervVMStates[n]; ok {
			return s.state, s.name
		}
		return StateOther, strconv.FormatInt(n, 10)
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil || s == "" {
		return StateOther, ""
	}
	for _, v := range hypervVMStates {
		if strings.EqualFold(v.name, s) {
			return v.state, v.name
		}
	}
	return StateOther, s
}

// Bounds of the ingest schema's cpuCount and memoryMb.
const (
	maxCPUCount = 4096
	maxMemoryMB = 100_000_000
)

// boundedInt returns v when the server would accept it, else null: an absurd
// value means the field is unknown, and one bad field must not reject the
// whole report.
func boundedInt(v int64, limit int64) *int {
	if v <= 0 || v > limit {
		return nil
	}
	i := int(v)
	return &i
}

// startedAtFromUptime turns an uptime into a start time rounded to the minute.
// Rounding keeps it stable between collections: the uptime and the clock are
// read a moment apart, and an unrounded value would differ every collection and
// defeat the change-only send.
func startedAtFromUptime(now time.Time, uptimeSeconds int64) *string {
	const maxUptime = 100 * 365 * 24 * 3600
	if uptimeSeconds <= 0 || uptimeSeconds > maxUptime || uptimeSeconds > math.MaxInt64/int64(time.Second) {
		return nil
	}
	start := now.Add(-time.Duration(uptimeSeconds) * time.Second).Round(time.Minute).UTC()
	return strp(start.Format(time.RFC3339))
}
