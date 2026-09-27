package hyperv

// Platform-neutral script builders and orchestration for Hyper-V restores.
// They take the PowerShell runner as a parameter so the exact scripts can be
// asserted in tests on any OS; the Windows entry points pass runPS.

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"
)

// psRunner executes a PowerShell script and returns its stdout.
type psRunner func(script string) (string, error)

// escapePSString escapes a value for use inside a PowerShell single-quoted
// string literal. PowerShell treats the typographic single quotes
// (U+2018..U+201B) as quote characters too, so every one of them is doubled,
// not just the ASCII apostrophe.
func escapePSString(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		b.WriteRune(r)
		switch r {
		case '\'', '‘', '’', '‚', '‛':
			b.WriteRune(r)
		}
	}
	return b.String()
}

// psQuote returns s as a complete PowerShell single-quoted string literal.
func psQuote(s string) string {
	return "'" + escapePSString(s) + "'"
}

var vmIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func validVMID(id string) bool { return vmIDPattern.MatchString(id) }

// vmByID returns a PowerShell expression selecting exactly one VM by GUID.
func vmByID(id string) (string, error) {
	if !validVMID(id) {
		return "", fmt.Errorf("invalid VM id %q", id)
	}
	return "Get-VM -Id '" + id + "'", nil
}

// safeFileStem reduces a VM name to a single, traversal-free path element.
func safeFileStem(name string) string {
	var b strings.Builder
	lastDash := false
	for _, r := range name {
		ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-'
		if !ok || r == '-' {
			if !lastDash {
				b.WriteByte('-')
			}
			lastDash = true
			continue
		}
		b.WriteRune(r)
		lastDash = false
	}
	stem := strings.Trim(b.String(), "-.")
	if stem == "" {
		return "vm"
	}
	if len(stem) > 64 {
		stem = strings.TrimRight(stem[:64], "-.")
	}
	return stem
}

// isSafePathElement reports whether s is a non-empty single path element made
// only of [A-Za-z0-9._-] that is not "." or "..".
func isSafePathElement(s string) bool {
	if s == "" || s == "." || s == ".." {
		return false
	}
	for _, r := range s {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '.' && r != '_' && r != '-' {
			return false
		}
	}
	return true
}

// restoreDirName builds the leaf directory an imported VM is copied into.
func restoreDirName(vmName string, now time.Time, suffix string) string {
	return fmt.Sprintf("breeze-restore-%s-%s-%s",
		strings.ToLower(safeFileStem(vmName)), now.UTC().Format("20060102T150405Z"), safeFileStem(suffix))
}

// importVMParams describes one Import-VM restore.
type importVMParams struct {
	ConfigPath  string // .vmcx/.xml inside the staged export
	VMName      string // name the restored VM must end up with; must not exist yet
	RestoreRoot string // parent directory; empty uses the host's default VM path
	DirName     string // leaf directory created under RestoreRoot (must not exist)
}

// buildImportVMScript returns a script that refuses an existing VM name,
// imports the export as a copy with a new ID into a fresh directory, renames
// the VM returned by Import-VM (bound by its ID) and prints
// {"Id","Name","Path"} as JSON.
func buildImportVMScript(p importVMParams) (string, error) {
	if strings.TrimSpace(p.ConfigPath) == "" {
		return "", fmt.Errorf("VM configuration path is required")
	}
	if strings.TrimSpace(p.VMName) == "" {
		return "", fmt.Errorf("restored VM name is required")
	}
	if !isSafePathElement(p.DirName) {
		return "", fmt.Errorf("invalid restore directory name %q", p.DirName)
	}

	var sb strings.Builder
	sb.WriteString("$ErrorActionPreference = 'Stop'\n")
	fmt.Fprintf(&sb, "$name = %s\n", psQuote(p.VMName))
	fmt.Fprintf(&sb, "$config = %s\n", psQuote(p.ConfigPath))
	fmt.Fprintf(&sb, "$root = %s\n", psQuote(p.RestoreRoot))
	fmt.Fprintf(&sb, "$dirName = %s\n", psQuote(p.DirName))
	sb.WriteString(psRequireVMNameFree)
	sb.WriteString(psCreateRestoreDir)
	sb.WriteString(`$vhdDest = Join-Path -Path $dest -ChildPath 'Virtual Hard Disks'
try {
  $imported = @(Import-VM -Path $config -Copy -GenerateNewId -VirtualMachinePath $dest -SnapshotFilePath $dest -SmartPagingFilePath $dest -VhdDestinationPath $vhdDest)
} catch {
  Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue
  throw
}
if ($imported.Count -ne 1) { throw ("Import-VM returned " + $imported.Count + " VMs; expected exactly one") }
$vmId = $imported[0].Id
try {
  Get-VM -Id $vmId | Rename-VM -NewName $name
} catch {
  throw ("Imported VM " + $vmId.Guid + " but could not rename it: " + $_.Exception.Message)
}
$vm = Get-VM -Id $vmId
[pscustomobject]@{ Id = $vm.Id.Guid; Name = $vm.Name; Path = $dest } | ConvertTo-Json -Compress
`)
	return sb.String(), nil
}

type importVMOutput struct {
	ID   string `json:"Id"`
	Name string `json:"Name"`
	Path string `json:"Path"`
}

// importVMWith runs the import script and reports the VM it created.
func importVMWith(run psRunner, p importVMParams) (*RestoreResult, error) {
	start := time.Now()
	script, err := buildImportVMScript(p)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrImportFailed, err)
	}
	out, err := run(script)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrImportFailed, err)
	}
	parsed, err := parseImportVMOutput(out)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrImportFailed, err)
	}
	if parsed.Name != p.VMName {
		return nil, fmt.Errorf("%w: imported VM %s has name %q, expected %q", ErrImportFailed, parsed.ID, parsed.Name, p.VMName)
	}
	return &RestoreResult{
		VMName:      parsed.Name,
		NewVMID:     parsed.ID,
		RestorePath: parsed.Path,
		Status:      "completed",
		DurationMs:  time.Since(start).Milliseconds(),
	}, nil
}

func parseImportVMOutput(out string) (*importVMOutput, error) {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if !strings.HasPrefix(line, "{") {
			continue
		}
		var parsed importVMOutput
		if err := json.Unmarshal([]byte(line), &parsed); err != nil {
			return nil, fmt.Errorf("decode import result: %w", err)
		}
		if !validVMID(parsed.ID) {
			return nil, fmt.Errorf("import returned invalid VM id %q", parsed.ID)
		}
		return &parsed, nil
	}
	return nil, fmt.Errorf("import produced no result")
}

// buildCreateVMScript refuses an existing VM name, creates a Generation 2 VM
// and prints its GUID.
// When vmPath is set the VM's configuration files are stored there.
func buildCreateVMScript(vmName, vhdxPath string, memoryBytes int64, vmPath string) (string, error) {
	if strings.TrimSpace(vmName) == "" {
		return "", fmt.Errorf("VM name is required")
	}
	var sb strings.Builder
	sb.WriteString("$ErrorActionPreference = 'Stop'\n")
	fmt.Fprintf(&sb, "$name = %s\n", psQuote(vmName))
	fmt.Fprintf(&sb, "$vhd = %s\n", psQuote(vhdxPath))
	pathArg := ""
	if vmPath != "" {
		fmt.Fprintf(&sb, "$vmPath = %s\n", psQuote(vmPath))
		pathArg = " -Path $vmPath"
	}
	// Re-checked here (not only before the download) to guard against a VM of
	// the same name appearing while the restore was running.
	sb.WriteString(psRequireVMNameFree)
	fmt.Fprintf(&sb, "$vm = New-VM -Name $name%s -Generation 2 -MemoryStartupBytes %d -VHDPath $vhd\n", pathArg, memoryBytes)
	sb.WriteString("$vm.Id.Guid\n")
	return sb.String(), nil
}

// startVMByIDScript returns a script that starts exactly the VM with this ID.
func startVMByIDScript(id string) (string, error) {
	sel, err := vmByID(id)
	if err != nil {
		return "", err
	}
	return sel + " | Start-VM", nil
}

// createAndConfigureVMWith creates a Generation 2 VM and applies CPU and
// network settings to that VM only, addressing it by the ID New-VM returned.
// It returns the new VM's ID.
func createAndConfigureVMWith(run psRunner, vmName, vhdxPath, vmPath string, memoryMB int64, cpuCount int, switchName string) (string, error) {
	createScript, err := buildCreateVMScript(vmName, vhdxPath, memoryMB*1024*1024, vmPath)
	if err != nil {
		return "", err
	}
	out, err := run(createScript)
	if err != nil {
		return "", fmt.Errorf("New-VM: %w", err)
	}
	id := lastLine(out)
	sel, err := vmByID(id)
	if err != nil {
		return "", fmt.Errorf("New-VM: %w", err)
	}

	if _, err := run(fmt.Sprintf("%s | Set-VM -ProcessorCount %d", sel, cpuCount)); err != nil {
		slog.Warn("vmrestore: failed to set CPU count", "vmId", id, "error", err.Error())
	}

	target := switchName
	if target == "" {
		if out, err := run(`Get-VMSwitch | Select-Object -First 1 -ExpandProperty Name`); err == nil {
			target = lastLine(out)
		}
	}
	if target != "" {
		netCmd := fmt.Sprintf("Get-VMNetworkAdapter -VM (%s) | Connect-VMNetworkAdapter -SwitchName %s", sel, psQuote(target))
		if _, err := run(netCmd); err != nil {
			slog.Warn("vmrestore: failed to connect network switch", "vmId", id, "switch", target, "error", err.Error())
		}
	}
	return id, nil
}

func lastLine(out string) string {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}
