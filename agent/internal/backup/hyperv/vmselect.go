package hyperv

// Exact, unambiguous VM selection. Hyper-V's -Name/-VMName parameters accept
// wildcards and act on every match, so a name is only ever compared with -eq
// and the operation is refused unless exactly one VM matches.

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

// psSelectVMByName assigns the single VM whose name equals $name to $vm.
const psSelectVMByName = `$found = @(Get-VM | Where-Object { $_.Name -eq $name })
if ($found.Count -eq 0) { throw ("No VM named '" + $name + "' exists on this host") }
if ($found.Count -gt 1) { throw ("" + $found.Count + " VMs are named '" + $name + "' on this host; refusing to act on an ambiguous name") }
$vm = $found[0]
`

// psRequireVMNameFree throws if any VM is already named $name.
const psRequireVMNameFree = `if (@(Get-VM | Where-Object { $_.Name -eq $name }).Count -gt 0) {
  throw ("A VM named '" + $name + "' already exists on this host; choose a different name for the restored VM")
}
`

// psCreateRestoreDir creates $dest = $root\$dirName (root defaulting to the
// host's default virtual machine path) and refuses an existing directory.
const psCreateRestoreDir = `if ([string]::IsNullOrWhiteSpace($root)) { $root = (Get-VMHost).VirtualMachinePath }
$dest = Join-Path -Path $root -ChildPath $dirName
if (Test-Path -LiteralPath $dest) { throw ("Restore directory already exists: " + $dest) }
[void][System.IO.Directory]::CreateDirectory($dest)
`

// buildSelectVMByNameScript resolves vmName to exactly one VM ($vm) and then
// runs body.
func buildSelectVMByNameScript(vmName, body string) (string, error) {
	if strings.TrimSpace(vmName) == "" {
		return "", fmt.Errorf("vmName is required")
	}
	var sb strings.Builder
	sb.WriteString("$ErrorActionPreference = 'Stop'\n")
	fmt.Fprintf(&sb, "$name = %s\n", psQuote(vmName))
	sb.WriteString(psSelectVMByName)
	sb.WriteString(body)
	sb.WriteString("\n")
	return sb.String(), nil
}

// resolveVMIDWith returns the ID of the single VM named exactly vmName.
func resolveVMIDWith(run psRunner, vmName string) (string, error) {
	script, err := buildSelectVMByNameScript(vmName, "$vm.Id.Guid")
	if err != nil {
		return "", err
	}
	out, err := run(script)
	if err != nil {
		return "", err
	}
	id := lastLine(out)
	if !validVMID(id) {
		return "", fmt.Errorf("could not resolve VM %q: unexpected id %q", vmName, id)
	}
	return id, nil
}

// crashExportPlan is how a crash-consistent export treats a VM in a given
// power state.
type crashExportPlan struct {
	// save runs Save-VM before the export to freeze memory and disk together.
	save bool
	// restart runs Start-VM after the export (or after a failed export) to
	// return a saved VM to the Running state it was found in.
	restart bool
	// warning, when set, is reported once the export succeeds.
	warning string
}

// planCrashExport maps a VM's power state (a Microsoft.HyperV.PowerShell.VMState
// name) to the crash-consistent export steps. Save-VM is only valid on a
// Running or Paused VM; an Off or Saved VM is already consistent on disk and is
// exported as-is, and is not started afterwards (#7623). Every other state is
// transitional or critical (storage inaccessible) and is refused rather than
// guessed at.
func planCrashExport(vmName, state string) (crashExportPlan, error) {
	switch state {
	case "Running":
		return crashExportPlan{save: true, restart: true}, nil
	case "Off", "Saved":
		return crashExportPlan{}, nil
	case "Paused":
		// Start-VM would resume the guest, which a VM paused by its operator
		// must not do behind their back; Saved keeps it frozen until they
		// start it.
		return crashExportPlan{
			save:    true,
			warning: fmt.Sprintf("VM %q was Paused; it was saved for the crash-consistent export and left in the Saved state (Start-VM resumes it)", vmName),
		}, nil
	default:
		return crashExportPlan{}, fmt.Errorf("cannot take a crash-consistent backup of VM %q in state %q; retry when it is Running, Off, Saved or Paused", vmName, state)
	}
}

// exportVMWith resolves vmName once and runs save/export/start against that
// VM's ID only. It returns the VM ID and any non-fatal warnings.
func exportVMWith(run psRunner, vmName, exportPath, consistencyType string) (string, []string, error) {
	id, err := resolveVMIDWith(run, vmName)
	if err != nil {
		return "", nil, err
	}
	sel, err := vmByID(id)
	if err != nil {
		return "", nil, err
	}
	var plan crashExportPlan
	if consistencyType == "crash" {
		out, err := run("(" + sel + ").State.ToString()")
		if err != nil {
			return id, nil, fmt.Errorf("failed to read VM state: %w", err)
		}
		if plan, err = planCrashExport(vmName, lastLine(out)); err != nil {
			return id, nil, err
		}
	}
	if plan.save {
		if _, err := run(sel + " | Save-VM"); err != nil {
			return id, nil, fmt.Errorf("failed to save VM state: %w", err)
		}
	}
	if _, err := run(sel + " | Export-VM -Path " + psQuote(exportPath)); err != nil {
		// A Running VM was saved by this backup: bring it back even though the
		// export failed, or the backup leaves it down.
		if plan.restart {
			if _, startErr := run(sel + " | Start-VM"); startErr != nil {
				return id, nil, fmt.Errorf("%w; additionally failed to restart VM %q after the failed export: %v", err, vmName, startErr)
			}
		}
		return id, nil, err
	}
	var warnings []string
	if plan.restart {
		if _, err := run(sel + " | Start-VM"); err != nil {
			warnings = append(warnings, fmt.Sprintf("failed to restart VM %q after export: %s", vmName, err.Error()))
		}
	}
	if plan.warning != "" {
		warnings = append(warnings, plan.warning)
	}
	return id, warnings, nil
}

// buildCheckpointScript returns a script that creates, deletes or applies a
// checkpoint on the single VM named vmName. Delete and apply match the
// checkpoint name exactly and refuse when it is missing or ambiguous.
func buildCheckpointScript(vmName, action, checkpointName string) (string, error) {
	var body strings.Builder
	fmt.Fprintf(&body, "$cpName = %s\n", psQuote(checkpointName))
	switch action {
	case "create":
		if checkpointName == "" {
			return "", fmt.Errorf("checkpointName is required")
		}
		body.WriteString("$vm | Checkpoint-VM -SnapshotName $cpName")
	case "delete", "apply":
		if checkpointName == "" {
			return "", fmt.Errorf("checkpointName is required for %s", action)
		}
		body.WriteString(`$cps = @(Get-VMSnapshot -VM $vm | Where-Object { $_.Name -eq $cpName })
if ($cps.Count -eq 0) { throw ("No checkpoint named '" + $cpName + "' exists on VM '" + $name + "'") }
if ($cps.Count -gt 1) { throw ("" + $cps.Count + " checkpoints are named '" + $cpName + "' on VM '" + $name + "'; refusing to act on an ambiguous name") }
`)
		if action == "delete" {
			body.WriteString("$cps[0] | Remove-VMSnapshot")
		} else {
			body.WriteString("$cps[0] | Restore-VMSnapshot -Confirm:$false")
		}
	default:
		return "", fmt.Errorf("unsupported action %q (must be create, delete, or apply)", action)
	}
	return buildSelectVMByNameScript(vmName, body.String())
}

// buildVMStateScript returns a script that changes the power state of the
// single VM named vmName.
func buildVMStateScript(vmName, targetState string) (string, error) {
	var action string
	switch targetState {
	case "start":
		action = "$vm | Start-VM"
	case "stop":
		action = "$vm | Stop-VM -Force:$false"
	case "force_stop":
		action = "$vm | Stop-VM -Force -TurnOff"
	case "pause":
		action = "$vm | Suspend-VM"
	case "resume":
		action = "$vm | Resume-VM"
	case "save":
		action = "$vm | Save-VM"
	default:
		return "", fmt.Errorf("unsupported target state: %s", targetState)
	}
	return buildSelectVMByNameScript(vmName, action)
}

// prepareVMRestoreWith refuses a VM name that already exists and creates the
// per-restore directory (root\dirName, root defaulting to the host's default
// virtual machine path). It returns the directory's absolute path.
func prepareVMRestoreWith(run psRunner, vmName, root, dirName string) (string, error) {
	if strings.TrimSpace(vmName) == "" {
		return "", fmt.Errorf("vmName is required")
	}
	if !isSafePathElement(dirName) {
		return "", fmt.Errorf("invalid restore directory name %q", dirName)
	}
	var sb strings.Builder
	sb.WriteString("$ErrorActionPreference = 'Stop'\n")
	fmt.Fprintf(&sb, "$name = %s\n", psQuote(vmName))
	fmt.Fprintf(&sb, "$root = %s\n", psQuote(root))
	fmt.Fprintf(&sb, "$dirName = %s\n", psQuote(dirName))
	sb.WriteString(psRequireVMNameFree)
	sb.WriteString(psCreateRestoreDir)
	sb.WriteString("$dest\n")
	out, err := run(sb.String())
	if err != nil {
		return "", err
	}
	dir := lastLine(out)
	if !isAbsWindowsPath(dir) {
		return "", fmt.Errorf("unexpected restore directory %q", dir)
	}
	return dir, nil
}

// isAbsWindowsPath reports whether p is a drive-rooted (C:\...) or UNC path.
func isAbsWindowsPath(p string) bool {
	if len(p) >= 3 && p[1] == ':' && (p[2] == '\\' || p[2] == '/') {
		c := p[0] | 0x20
		return c >= 'a' && c <= 'z'
	}
	return strings.HasPrefix(p, `\\`)
}

// requireVMNameFreeWith fails if a VM named vmName already exists.
func requireVMNameFreeWith(run psRunner, vmName string) error {
	if strings.TrimSpace(vmName) == "" {
		return fmt.Errorf("vmName is required")
	}
	script := "$ErrorActionPreference = 'Stop'\n$name = " + psQuote(vmName) + "\n" + psRequireVMNameFree
	_, err := run(script)
	return err
}

// newRestoreDirName returns a unique per-restore directory name for vmName.
func newRestoreDirName(vmName string) (string, error) {
	suffix := make([]byte, 4)
	if _, err := rand.Read(suffix); err != nil {
		return "", fmt.Errorf("generate restore directory name: %w", err)
	}
	return restoreDirName(vmName, time.Now(), hex.EncodeToString(suffix)), nil
}
