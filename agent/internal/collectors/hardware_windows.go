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

func powershellWmiPropertyValues(className, property string) []string {
	script := fmt.Sprintf(`
$ErrorActionPreference = 'Stop'
$items = $null
if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) {
  try {
    $items = Get-CimInstance -ClassName '%s' -ErrorAction Stop
  } catch {
    $items = $null
  }
}
if ($null -eq $items -and (Get-Command Get-WmiObject -ErrorAction SilentlyContinue)) {
  $items = Get-WmiObject -Class '%s' -ErrorAction Stop
}
$values = $items |
  Where-Object { $_.%s } |
  Select-Object -ExpandProperty '%s'
foreach ($entry in $values) {
  if ($null -ne $entry) {
    [Console]::WriteLine(([string]$entry).Trim())
  }
}
`, className, className, property, property)

	out, err := runCollectorOutput(wmicTimeout, "powershell", "-NoProfile", "-NonInteractive", "-Command", utf8PowerShellCommand(script))
	if err != nil {
		slog.Debug("powershell WMI query failed", "class", className, "property", property, "error", err.Error())
		return nil
	}

	seen := make(map[string]struct{})
	values := make([]string, 0)
	for _, line := range strings.Split(string(out), "\n") {
		value := strings.TrimSpace(line)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		values = append(values, value)
	}
	return values
}

func powershellWmiFirstProperty(className, property string) string {
	values := powershellWmiPropertyValues(className, property)
	if len(values) == 0 {
		return ""
	}
	return truncateCollectorString(values[0])
}

func powershellWmiJoinedProperties(className, property string) string {
	values := powershellWmiPropertyValues(className, property)
	if len(values) == 0 {
		return ""
	}
	return truncateCollectorString(strings.Join(values, "; "))
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

func collectPlatformHardware(hw *HardwareInfo) {
	hw.SerialNumber = firstCleanHardwareIdentityValue(
		powershellWmiFirstProperty("Win32_BIOS", "SerialNumber"),
		powershellWmiFirstProperty("Win32_BaseBoard", "SerialNumber"),
	)
	hw.Manufacturer = cleanHardwareIdentityValue(powershellWmiFirstProperty("Win32_ComputerSystem", "Manufacturer"))
	hw.Model = cleanHardwareIdentityValue(powershellWmiFirstProperty("Win32_ComputerSystem", "Model"))
	hw.MotherboardManufacturer = cleanHardwareIdentityValue(powershellWmiFirstProperty("Win32_BaseBoard", "Manufacturer"))
	hw.MotherboardProduct = cleanHardwareIdentityValue(powershellWmiFirstProperty("Win32_BaseBoard", "Product"))
	hw.MotherboardVersion = cleanHardwareIdentityValue(powershellWmiFirstProperty("Win32_BaseBoard", "Version"))
	hw.BIOSVersion = powershellWmiFirstProperty("Win32_BIOS", "SMBIOSBIOSVersion")
	hw.GPUModel = powershellWmiJoinedProperties("Win32_VideoController", "Name")
}
