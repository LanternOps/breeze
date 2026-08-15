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

// vpnInterfaceAttributions has no cheap per-interface owner lookup on Linux:
// tunnel devices carry no owner metadata readable without root, so a generic
// tun0 stays generic unless exactly one known VPN client is running. Returning
// nil keeps that fallback as the only promotion path here.
func vpnInterfaceAttributions() map[string]string {
	return nil
}
