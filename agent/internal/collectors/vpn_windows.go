//go:build windows

package collectors

// vpnServiceSignals reports which VPN providers have a running Windows service.
// Best-effort: a failed PowerShell call just yields no service signals — the
// interface + process detection in vpn.go still works.
func vpnServiceSignals() map[string]bool {
	out, err := runCollectorOutput(collectorShortCommandTimeout,
		"powershell", "-NoProfile", "-NonInteractive", "-Command",
		utf8PowerShellCommand("Get-Service | Where-Object {$_.Status -eq 'Running'} | Select-Object -ExpandProperty Name"))
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
