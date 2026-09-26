//go:build windows

package hyperv

import (
	"fmt"
	"strings"
)

// EstimateExportBytes estimates how many bytes Export-VM will write for vmName:
// the on-disk size of every virtual disk file it copies — the VM's current
// disks, every checkpoint's disks, and each differencing disk's parent chain —
// plus the VM's memory when it is not Off (a running or saved VM's export
// carries its saved state). Export-VM copies VHD/VHDX files as they are, so a
// dynamic disk costs its file size, not its maximum size.
//
// It is an estimate for a free-space preflight (#5460), not an exact figure:
// the small configuration files are left to the caller's headroom.
func EstimateExportBytes(vmName string) (int64, error) {
	if strings.TrimSpace(vmName) == "" {
		return 0, fmt.Errorf("vmName is required")
	}
	script := fmt.Sprintf(`$ErrorActionPreference = 'Stop'
$vm = Get-VM -Name '%s'
$queue = New-Object System.Collections.Queue
Get-VMHardDiskDrive -VM $vm | Where-Object { $_.Path } | ForEach-Object { $queue.Enqueue($_.Path) }
Get-VMSnapshot -VM $vm | ForEach-Object { Get-VMHardDiskDrive -VMSnapshot $_ } | Where-Object { $_.Path } | ForEach-Object { $queue.Enqueue($_.Path) }
$seen = @{}
$vhdBytes = [int64]0
while ($queue.Count -gt 0) {
  $p = [string]$queue.Dequeue()
  if ($seen.ContainsKey($p)) { continue }
  $seen[$p] = $true
  $vhd = Get-VHD -Path $p
  $vhdBytes += [int64]$vhd.FileSize
  if ($vhd.ParentPath) { $queue.Enqueue($vhd.ParentPath) }
}
$memoryBytes = [int64]0
if ($vm.State -ne 'Off') {
  $memoryBytes = [Math]::Max([int64]$vm.MemoryAssigned, [int64]$vm.MemoryStartup)
}
[pscustomobject]@{ vhdBytes = $vhdBytes; memoryBytes = $memoryBytes; state = [string]$vm.State } | ConvertTo-Json -Compress`,
		escapePSString(vmName))
	out, err := runPS(script)
	if err != nil {
		return 0, fmt.Errorf("estimate export size of VM %q: %w", vmName, err)
	}
	return parseExportEstimate(out)
}

// DefaultVirtualHardDiskPath returns the host's default virtual hard disk
// directory — where Import-VM -Copy writes the VHDs when no destination is
// given.
func DefaultVirtualHardDiskPath() (string, error) {
	out, err := runPS(`(Get-VMHost -ErrorAction Stop).VirtualHardDiskPath`)
	if err != nil {
		return "", fmt.Errorf("read Hyper-V host virtual hard disk path: %w", err)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	p := strings.TrimSpace(lines[len(lines)-1])
	if p == "" {
		return "", fmt.Errorf("Hyper-V host reports no virtual hard disk path")
	}
	return p, nil
}
