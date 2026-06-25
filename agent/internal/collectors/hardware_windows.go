//go:build windows

package collectors

import (
	"fmt"
	"log/slog"
	"strings"
	"time"

	"golang.org/x/sys/windows/registry"
)

const wmicTimeout = 15 * time.Second

// wmicGet runs a wmic query and returns the trimmed output value.
func wmicGet(args []string, property string) string {
	cmdArgs := append(args, "get", property, "/format:list")
	out, err := runCollectorOutput(wmicTimeout, "wmic", cmdArgs...)
	if err != nil {
		slog.Debug("wmic query failed", "args", strings.Join(args, " "), "error", err.Error())
		return ""
	}
	// Output format: "Property=Value\r\n"
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, property+"=") {
			return truncateCollectorString(strings.TrimSpace(strings.TrimPrefix(line, property+"=")))
		}
	}
	return ""
}

// enrichOSInfo refines the OS version/build on Windows using the authoritative
// registry source (HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion):
//
//   - DisplayVersion (e.g. "25H2") is appended to the product name so the
//     version reads "Microsoft Windows 11 Pro 25H2" — the feature-update label
//     admins actually track, mirroring how Linux shows "debian 12.12".
//   - OSBuild is set to "<CurrentBuildNumber>.<UBR>" (e.g. "26200.8457"), the
//     canonical build string.
//
// It is strictly best-effort: any missing key or read error leaves the
// gopsutil-derived values (already correct after normalizeOSVersionBuild) in
// place. We deliberately do NOT read ProductName here — on Windows 11 it still
// reports "Windows 10", whereas gopsutil's Platform correctly resolves "11".
func enrichOSInfo(info *SystemInfo) {
	if info == nil {
		return
	}
	k, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`SOFTWARE\Microsoft\Windows NT\CurrentVersion`, registry.QUERY_VALUE)
	if err != nil {
		slog.Debug("os enrich: open CurrentVersion failed", "error", err.Error())
		return
	}
	defer k.Close()

	if display, _, derr := k.GetStringValue("DisplayVersion"); derr == nil {
		if display = strings.TrimSpace(display); display != "" &&
			info.OSVersion != "" && !strings.Contains(info.OSVersion, display) {
			info.OSVersion = info.OSVersion + " " + display
		}
	}

	if build, _, berr := k.GetStringValue("CurrentBuildNumber"); berr == nil {
		if build = strings.TrimSpace(build); build != "" {
			if ubr, _, uerr := k.GetIntegerValue("UBR"); uerr == nil {
				info.OSBuild = fmt.Sprintf("%s.%d", build, ubr)
			} else {
				info.OSBuild = build
			}
		}
	}
}

// collectPlatformHardware queries Win32_BIOS, Win32_BaseBoard,
// Win32_ComputerSystem, and Win32_VideoController in a single PowerShell
// invocation (one process spawn instead of ~9) and populates hw with the
// results. Graceful degradation: a failed or unparseable response leaves the
// affected fields empty.
func collectPlatformHardware(hw *HardwareInfo) {
	// One batched PowerShell invocation fetches all WMI properties at once,
	// cutting ~9 cold-start process spawns per collection cycle down to one.
	// Each WMI class tries Get-CimInstance first (preferred, modern) and falls
	// back to Get-WmiObject for older hosts where CIM is unavailable.
	script := `
$ErrorActionPreference = 'SilentlyContinue'
function Get-WmiSafe($ClassName) {
  $r = $null
  if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) {
    try { $r = Get-CimInstance -ClassName $ClassName -ErrorAction Stop } catch {}
  }
  if ($null -eq $r -and (Get-Command Get-WmiObject -ErrorAction SilentlyContinue)) {
    try { $r = Get-WmiObject -Class $ClassName -ErrorAction Stop } catch {}
  }
  $r
}
$bios  = @(Get-WmiSafe 'Win32_BIOS')          | Select-Object -First 1
$board = @(Get-WmiSafe 'Win32_BaseBoard')      | Select-Object -First 1
$sys   = @(Get-WmiSafe 'Win32_ComputerSystem') | Select-Object -First 1
$gpus  = @(@(Get-WmiSafe 'Win32_VideoController') |
  Where-Object { $_ -and $_.Name } |
  Select-Object -ExpandProperty Name |
  ForEach-Object { ([string]$_).Trim() } |
  Where-Object { $_ -ne '' } |
  Select-Object -Unique)
[PSCustomObject]@{
  BiosSerial        = if ($bios)  { ([string]$bios.SerialNumber).Trim() }      else { '' }
  BiosVersion       = if ($bios)  { ([string]$bios.SMBIOSBIOSVersion).Trim() } else { '' }
  BoardSerial       = if ($board) { ([string]$board.SerialNumber).Trim() }     else { '' }
  BoardManufacturer = if ($board) { ([string]$board.Manufacturer).Trim() }     else { '' }
  BoardProduct      = if ($board) { ([string]$board.Product).Trim() }          else { '' }
  BoardVersion      = if ($board) { ([string]$board.Version).Trim() }          else { '' }
  SysManufacturer   = if ($sys)   { ([string]$sys.Manufacturer).Trim() }       else { '' }
  SysModel          = if ($sys)   { ([string]$sys.Model).Trim() }              else { '' }
  GPUNames          = $gpus
} | ConvertTo-Json -Compress
`

	out, err := runCollectorOutput(wmicTimeout, "powershell", "-NoProfile", "-NonInteractive", "-Command", utf8PowerShellCommand(script))
	if err != nil {
		// Whole-scan failure (powershell blocked by WDAC/AppLocker, WMI repository
		// corruption, timeout, …) leaves every WMI-derived field empty this cycle,
		// so log at Warn — Debug is suppressed at the default "info" level.
		slog.Warn("hardware WMI batch query failed; WMI-derived hardware fields empty this cycle", "error", err.Error())
		return
	}

	parsed, err := parseHardwareJSON(out)
	if err != nil {
		slog.Warn("hardware WMI batch query JSON parse failed; WMI-derived hardware fields empty this cycle", "error", err.Error(), "bytes", len(out))
		return
	}

	hw.SerialNumber = firstCleanHardwareIdentityValue(parsed.BiosSerial, parsed.BoardSerial)
	hw.Manufacturer = cleanHardwareIdentityValue(parsed.SysManufacturer)
	hw.Model = cleanHardwareIdentityValue(parsed.SysModel)
	hw.MotherboardManufacturer = cleanHardwareIdentityValue(parsed.BoardManufacturer)
	hw.MotherboardProduct = cleanHardwareIdentityValue(parsed.BoardProduct)
	hw.MotherboardVersion = cleanHardwareIdentityValue(parsed.BoardVersion)
	hw.BIOSVersion = truncateCollectorString(strings.TrimSpace(parsed.BiosVersion))

	// Join GPU names in the same shape as before: unique, non-empty, "; "-joined.
	// De-duplication is handled in PowerShell (Select-Object -Unique, which is
	// case-insensitive); here we just trim stray whitespace and drop empties.
	gpuParts := make([]string, 0, len(parsed.GPUNames))
	for _, name := range parsed.GPUNames {
		if name = strings.TrimSpace(name); name != "" {
			gpuParts = append(gpuParts, name)
		}
	}
	if len(gpuParts) > 0 {
		hw.GPUModel = truncateCollectorString(strings.Join(gpuParts, "; "))
	}
}
