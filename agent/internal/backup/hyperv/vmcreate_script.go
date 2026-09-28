package hyperv

// Platform-neutral half of CreateVMFromVHDX (vmcreate.go / vmcreate_stub.go):
// request validation and the single PowerShell script, built here so both are
// asserted on every OS (the restore_identity.go convention).

import (
	"context"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// CreateVMRequest is the input to CreateVMFromVHDX. It intentionally has NO
// default-switch fallback (unlike createAndConfigureVMWith): a same-host VM
// created from an original-identity rebuild image must not get a NIC unless
// the caller explicitly names a switch — a default NIC would let the VM renew
// the still-live source machine's computer-account password out from under
// it. The field bounds mirror apps/api/src/services/bareMetalRebuildSchemas.ts
// hypervOptionsSchema.
type CreateVMRequest struct {
	VMName     string
	VHDXPath   string
	SwitchName string // "" → the VM has no network adapter
	MemoryMB   int64  // 0 → defaultCreateVMMemoryMB
	CPUCount   int    // 0 → defaultCreateVMCPUCount
}

const (
	defaultCreateVMMemoryMB = 4096
	defaultCreateVMCPUCount = 2
	minCreateVMMemoryMB     = 512
	maxCreateVMMemoryMB     = 12 << 20 // 12 TiB, the Hyper-V Gen2 ceiling; also keeps MB→bytes far from int64 overflow
	maxCreateVMCPUCount     = 240      // Hyper-V Gen2 ceiling
	maxCreateVMNameRunes    = 100
	maxCreateVMSwitchRunes  = 200

	// createVMTimeout bounds the one PowerShell process that creates and
	// configures the VM (Global "Server contract": runPSContext, 10 min).
	createVMTimeout = 10 * time.Minute
)

// psContextRunner executes a PowerShell script under ctx and timeout and
// returns its stdout; runPSContext on Windows.
type psContextRunner func(ctx context.Context, script string, timeout time.Duration) (string, error)

// refuseControlChars rejects a value that is not UTF-8 or that carries a
// control character (NUL, CR/LF, tab, DEL, C1). Every value is also escaped
// into a single-quoted literal, so this is defense in depth: a newline cannot
// end a statement inside a literal, but no legitimate VM name, switch name or
// path contains one, and refusing it keeps the rendered script one value per
// line.
func refuseControlChars(field, v string) error {
	if !utf8.ValidString(v) {
		return fmt.Errorf("%s is not valid UTF-8", field)
	}
	for _, r := range v {
		if unicode.IsControl(r) {
			return fmt.Errorf("%s contains a control character (%U)", field, r)
		}
	}
	return nil
}

// ValidateCreateVMRequest refuses a request CreateVMFromVHDX would not run.
// Exported so the command handler refuses a bad payload before it starts a
// rebuild, rather than after hours of restore.
func ValidateCreateVMRequest(req CreateVMRequest) error {
	if strings.TrimSpace(req.VMName) == "" {
		return fmt.Errorf("hyperv.vmName is required")
	}
	if err := refuseControlChars("hyperv.vmName", req.VMName); err != nil {
		return err
	}
	if utf8.RuneCountInString(req.VMName) > maxCreateVMNameRunes {
		return fmt.Errorf("hyperv.vmName must be at most %d characters", maxCreateVMNameRunes)
	}
	if req.SwitchName != "" {
		if strings.TrimSpace(req.SwitchName) == "" {
			return fmt.Errorf("hyperv.switchName must not be blank")
		}
		if err := refuseControlChars("hyperv.switchName", req.SwitchName); err != nil {
			return err
		}
		if utf8.RuneCountInString(req.SwitchName) > maxCreateVMSwitchRunes {
			return fmt.Errorf("hyperv.switchName must be at most %d characters", maxCreateVMSwitchRunes)
		}
	}
	if req.MemoryMB != 0 && (req.MemoryMB < minCreateVMMemoryMB || req.MemoryMB > maxCreateVMMemoryMB) {
		return fmt.Errorf("hyperv.memoryMb must be between %d and %d, got %d", minCreateVMMemoryMB, maxCreateVMMemoryMB, req.MemoryMB)
	}
	if req.CPUCount != 0 && (req.CPUCount < 1 || req.CPUCount > maxCreateVMCPUCount) {
		return fmt.Errorf("hyperv.cpuCount must be between 1 and %d, got %d", maxCreateVMCPUCount, req.CPUCount)
	}
	if req.VHDXPath == "" {
		return fmt.Errorf("the rebuilt VHDX path is required")
	}
	return refuseControlChars("the rebuilt VHDX path", req.VHDXPath)
}

// buildCreateVMFromVHDXScript renders the whole VM creation as ONE script so
// one PowerShell process (one runPSContext timeout) covers it. Every caller
// value is bound once, as a psQuote'd literal assignment ($name, $vhd,
// $switch); the commands only reference those variables.
//
// Order: resolve the switch (exact -eq match — Get-VMSwitch -Name and
// Connect-VMNetworkAdapter -SwitchName are wildcards) and refuse an existing
// VM name before New-VM, so those failures leave nothing behind. After New-VM
// every step is in a try whose catch removes the half-configured VM and
// rethrows. Remove-VM deletes only the VM's configuration, never its virtual
// hard disks, so the rebuilt VHDX survives any failure here.
func buildCreateVMFromVHDXScript(req CreateVMRequest) (string, error) {
	if err := ValidateCreateVMRequest(req); err != nil {
		return "", err
	}
	memoryMB := req.MemoryMB
	if memoryMB == 0 {
		memoryMB = defaultCreateVMMemoryMB
	}
	cpuCount := req.CPUCount
	if cpuCount == 0 {
		cpuCount = defaultCreateVMCPUCount
	}

	var sb strings.Builder
	sb.WriteString("$ErrorActionPreference = 'Stop'\n")
	fmt.Fprintf(&sb, "$name = %s\n", psQuote(req.VMName))
	fmt.Fprintf(&sb, "$vhd = %s\n", psQuote(req.VHDXPath))
	sb.WriteString("if (-not (Test-Path -LiteralPath $vhd -PathType Leaf)) { throw ('Rebuilt VHDX not found: ' + $vhd) }\n")
	if req.SwitchName != "" {
		fmt.Fprintf(&sb, "$switch = %s\n", psQuote(req.SwitchName))
		sb.WriteString(`$switches = @(Get-VMSwitch | Where-Object { $_.Name -eq $switch })
if ($switches.Count -ne 1) { throw ("Expected exactly one virtual switch named '" + $switch + "', found " + $switches.Count) }
$sw = $switches[0]
`)
	}
	sb.WriteString(psRequireVMNameFree)
	fmt.Fprintf(&sb, "$vm = New-VM -Name $name -Generation 2 -MemoryStartupBytes %d -VHDPath $vhd\n", memoryMB*1024*1024)
	sb.WriteString("try {\n")
	fmt.Fprintf(&sb, "  Set-VM -VM $vm -ProcessorCount %d\n", cpuCount)
	sb.WriteString("  Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows\n")
	if req.SwitchName != "" {
		sb.WriteString("  Get-VMNetworkAdapter -VM $vm | Connect-VMNetworkAdapter -VMSwitch $sw\n")
	} else {
		// New-VM always adds one (unconnected) adapter; remove it.
		sb.WriteString("  Get-VMNetworkAdapter -VM $vm | Remove-VMNetworkAdapter\n")
	}
	sb.WriteString(`} catch {
  Remove-VM -VM $vm -Force -ErrorAction SilentlyContinue
  throw
}
$vm.Id.Guid
`)
	return sb.String(), nil
}

// createVMFromVHDXWith validates req, then creates and configures the VM with
// one script run through run under ctx and createVMTimeout.
func createVMFromVHDXWith(ctx context.Context, run psContextRunner, req CreateVMRequest) error {
	script, err := buildCreateVMFromVHDXScript(req)
	if err != nil {
		return err
	}
	if _, err := run(ctx, script, createVMTimeout); err != nil {
		return fmt.Errorf("create Hyper-V VM %q: %w", req.VMName, err)
	}
	return nil
}
