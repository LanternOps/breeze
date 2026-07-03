//go:build darwin

package collectors

// vpnServiceSignals reports which VPN providers have a loaded launchd job.
// Best-effort: a failed launchctl just yields no service signals — the
// interface + process detection in vpn.go still works.
func vpnServiceSignals() map[string]bool {
	out, err := runCollectorOutput(collectorShortCommandTimeout, "launchctl", "list")
	if err != nil {
		return nil
	}
	return matchVPNServiceTokens(string(out))
}
