//go:build windows

package collectors

// windowsVPNServiceQuery lists running services as "Name<TAB>DisplayName" lines.
// The DisplayName column is what identifies Zscaler's drivers (#8763): zapprd
// and zsawdrv only say "Zscaler" in their display names. Those two drivers are
// also fetched by name, since a bare Get-Service enumeration is not guaranteed
// to include kernel drivers; a name that doesn't exist is silently skipped and
// a duplicate is harmless. [char]9 (tab) avoids embedding double quotes in the
// -Command argument.
const windowsVPNServiceQuery = "@(Get-Service) + @(Get-Service -Name 'zapprd','zsawdrv' -ErrorAction SilentlyContinue) | " +
	"Where-Object {$_.Status -eq 'Running'} | ForEach-Object { $_.Name + [char]9 + $_.DisplayName }"

// vpnServiceSignals reports which VPN providers have a running Windows service.
// Best-effort: a failed PowerShell call just yields no service signals — the
// interface + process detection in vpn.go still works.
func vpnServiceSignals() map[string]bool {
	out, err := runCollectorOutput(collectorShortCommandTimeout,
		"powershell", "-NoProfile", "-NonInteractive", "-Command",
		utf8PowerShellCommand(windowsVPNServiceQuery))
	if err != nil {
		return nil
	}
	return matchVPNServiceTokens(string(out))
}

// vpnInterfaceAttributions is unnecessary on Windows: gopsutil reports the
// friendly adapter name (e.g. "Tailscale", "OpenVPN TAP-Windows Adapter V9"),
// so per-interface attribution already happens by name in classifyVPNInterface.
func vpnInterfaceAttributions() map[string]string {
	return nil
}
