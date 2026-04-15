//go:build windows

package collectors

import (
	"log/slog"
	"os"
)

// HostnameSourcesDescription returns a human-readable description of
// the hostname sources tried on this platform. Used in error messages
// so operators know exactly what was attempted.
func HostnameSourcesDescription() string {
	return "os.Hostname(), COMPUTERNAME env var, and WMI (win32_computersystem.Name)"
}

// platformHostnameFallbacks is the Windows-specific tail of the
// hostname resolver chain. Appended to os.Hostname() by
// hostnameSourceChain. Ordered cheapest → slowest:
//
//  1. COMPUTERNAME environment variable — always set by the Windows
//     session, including SYSTEM/Session 0 where the agent runs as a
//     service. Free.
//  2. wmic computersystem.Name — subprocess call, ~1s, but authoritative
//     even when the local session is too early in boot for
//     GetComputerNameExW to return anything useful.
//
// gopsutil's host.Info().Hostname just calls os.Hostname() (which in
// turn calls GetComputerNameExW), so these fallbacks are the ONLY
// protection if that syscall returns an empty string without an error
// — a known Windows service-startup edge case.
//
// Caveat: wmic.exe is deprecated and removed by default on Windows 11
// 24H2 / Server 2025. On those images the wmic leg silently degrades
// to a no-op and hostname resolution collapses to [os.Hostname,
// COMPUTERNAME]. Replacing this with a native GetComputerNameExW call
// or a PowerShell Get-CimInstance probe is tracked separately.
func platformHostnameFallbacks() []hostnameSource {
	return []hostnameSource{
		func() string { return os.Getenv("COMPUTERNAME") },
		wmicComputerName,
	}
}

// wmicComputerName queries WMI for Win32_ComputerSystem.Name via the
// existing wmicGet helper (see hardware_windows.go). Returns "" on any
// error so the resolver moves on. wmicGet logs subprocess errors at
// Debug; we additionally log a Warn here when the result is empty so
// operators hunting a future #439 regression see which link of the
// chain gave out — this source only runs when COMPUTERNAME was also
// empty, so by the time we reach it the chain is on its last legs.
func wmicComputerName() string {
	name := wmicGet([]string{"computersystem"}, "Name")
	if name == "" {
		slog.Warn("wmic win32_computersystem.Name returned empty",
			"hint", "wmic.exe may be missing on Windows 11 24H2+/Server 2025")
	}
	return name
}
