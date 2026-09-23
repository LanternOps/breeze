//go:build windows

package layout

import (
	"context"
	"fmt"
	"os/exec"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/wingpt"
	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("layout")

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

// Collect captures the Windows disk layout through one PowerShell invocation,
// then a second, best-effort pass (fillGPTDetails) to add the disk GUID and
// per-partition GPT attributes Get-Disk/Get-Partition don't expose. A
// failure in the second pass never fails Collect — see fillGPTDetails.
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
	fillGPTDetails(m)
	return m, nil
}

// fillGPTDetails adds Disk.GUID and Partition.Attributes via
// wingpt.ReadLayout — data Get-Disk/Get-Partition never expose (see
// windowsLayoutScript's comment: no -Guid on Get-Disk, no GPT attribute
// property on Get-Partition at all). Best-effort, GPT disks only — see
// fillGPTDetailsWith for the skip and Incomplete rules. Assess never consults
// Incomplete, so a failure here is diagnostic only; layout.Assess's own
// PartUUID check (guard.go) is what gates on missing per-partition identity.
func fillGPTDetails(m *Manifest) {
	if err := fillGPTDetailsWith(m, wingpt.ReadLayout); err != nil {
		log.Warn("GPT disk GUID/partition attributes not captured for at least one disk", "error", err.Error())
	}
}
