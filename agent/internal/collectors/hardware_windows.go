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

func collectPlatformHardware(hw *HardwareInfo) {
	hw.SerialNumber = wmicGet([]string{"bios"}, "SerialNumber")
	hw.Manufacturer = wmicGet([]string{"computersystem"}, "Manufacturer")
	hw.Model = wmicGet([]string{"computersystem"}, "Model")
	hw.BIOSVersion = wmicGet([]string{"bios"}, "SMBIOSBIOSVersion")
	hw.GPUModel = wmicGet([]string{"path", "win32_videocontroller"}, "Name")
}
