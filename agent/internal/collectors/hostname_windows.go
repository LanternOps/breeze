//go:build windows

package collectors

import "os"

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
func platformHostnameFallbacks() []hostnameSource {
	return []hostnameSource{
		func() string { return os.Getenv("COMPUTERNAME") },
		wmicComputerName,
	}
}

// wmicComputerName queries WMI for Win32_ComputerSystem.Name via the
// existing wmicGet helper (see hardware_windows.go). Returns "" on any
// error so the resolver moves on.
func wmicComputerName() string {
	return wmicGet([]string{"computersystem"}, "Name")
}
