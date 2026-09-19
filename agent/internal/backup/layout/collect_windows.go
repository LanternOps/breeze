//go:build windows

package layout

import (
	"context"
	"fmt"
	"os/exec"
	"time"
)

var runCommand = func(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).Output()
}

const collectTimeout = 60 * time.Second

// windowsLayoutScript is run by the Windows collector through
// `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`.
// Get-BitLockerVolume is absent on editions without the BitLocker module, so
// it is best-effort and reported as Incomplete "bitlocker". Lives in this
// windows-tagged file (not windows_parse.go, which has no build tag) so it
// is never flagged "unused" when this package is compiled for a non-Windows
// GOOS — only collect_windows.go references it.
const windowsLayoutScript = `$ErrorActionPreference='Stop'
$disks = @(Get-Disk | Select-Object Number,FriendlyName,SerialNumber,Size,PartitionStyle,IsSystem,IsBoot,LogicalSectorSize,BusType)
$parts = @(Get-Partition | Select-Object DiskNumber,PartitionNumber,Guid,GptType,Offset,Size,DriveLetter,IsSystem,IsBoot,IsActive,IsHidden,Type,AccessPaths)
$vols  = @(Get-Volume | Select-Object DriveLetter,Path,UniqueId,FileSystem,FileSystemLabel,Size,SizeRemaining)
$bl = $null
try { $bl = @(Get-BitLockerVolume | Select-Object MountPoint,ProtectionStatus) } catch { $bl = $null }
[pscustomobject]@{
  firmware = [string]$env:firmware_type
  os       = (Get-CimInstance Win32_OperatingSystem).Caption
  hostname = $env:COMPUTERNAME
  disks = $disks; partitions = $parts; volumes = $vols; bitlocker = $bl
} | ConvertTo-Json -Depth 6 -Compress`

// Collect captures the Windows disk layout through one PowerShell invocation.
func Collect(ctx context.Context) (*Manifest, error) {
	ctx, cancel := context.WithTimeout(ctx, collectTimeout)
	defer cancel()
	out, err := runCommand(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", windowsLayoutScript)
	if err != nil {
		return nil, fmt.Errorf("powershell disk layout: %w", err)
	}
	m, err := parseWindowsLayout(out)
	if err != nil {
		return nil, err
	}
	m.CollectedAt = time.Now().UTC()
	return m, nil
}
