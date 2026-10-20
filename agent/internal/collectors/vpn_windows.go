//go:build windows

package collectors

// windowsVPNServiceQuery lists running services as "Name<TAB>DisplayName" lines.
// The DisplayName column is what identifies Zscaler's drivers (#8763): zapprd
// and zsawdrv only say "Zscaler" in their display names. A bare Get-Service
// does not enumerate kernel drivers — only a lookup by exact -Name finds them —
// so those two are fetched by name. Each lookup runs inside try/catch so the
// usual case (no Zscaler, name not found) leaves no failed statement behind:
// a failed last statement makes powershell -Command exit 1, and
// vpnServiceSignals discards the whole listing on a non-zero exit, which would
// silently drop every provider's service signal. [char]9 (tab) avoids
// embedding double quotes in the -Command argument.
const windowsVPNServiceQuery = "$s = @(Get-Service); " +
	"foreach ($n in 'zapprd','zsawdrv') { try { $s += Get-Service -Name $n -ErrorAction Stop } catch {} }; " +
	"$s | Where-Object {$_.Status -eq 'Running'} | ForEach-Object { $_.Name + [char]9 + $_.DisplayName }"

// windowsVPNServiceListing runs windowsVPNServiceQuery.
func windowsVPNServiceListing() ([]byte, error) {
	return runCollectorOutput(collectorShortCommandTimeout,
		"powershell", "-NoProfile", "-NonInteractive", "-Command",
		utf8PowerShellCommand(windowsVPNServiceQuery))
}

// vpnServiceSignals reports which VPN providers have a running Windows service.
// Best-effort: a failed PowerShell call just yields no service signals — the
// interface + process detection in vpn.go still works.
func vpnServiceSignals() map[string]bool {
	out, err := windowsVPNServiceListing()
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
