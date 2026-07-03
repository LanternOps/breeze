//go:build linux

package collectors

// vpnServiceSignals reports which VPN providers have a running systemd service.
// Best-effort: a failed/absent systemctl just yields no service signals — the
// interface + process detection in vpn.go still works.
func vpnServiceSignals() map[string]bool {
	out, err := runCollectorOutput(collectorShortCommandTimeout,
		"systemctl", "list-units", "--type=service", "--state=running", "--no-legend", "--plain")
	if err != nil {
		return nil
	}
	return matchVPNServiceTokens(string(out))
}
