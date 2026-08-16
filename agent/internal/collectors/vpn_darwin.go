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

// vpnInterfaceAttributions maps a macOS tunnel interface (utunN) to the VPN
// provider that owns it, read from the network-extension agent description in
// `ifconfig -v`. This is what lets a Mac running several VPN clients at once
// name each tunnel — the global running-client signal can only name a tunnel
// when exactly one client is running (#2139).
//
// Limitation: only network-extension-backed clients (Tailscale, WireGuard,
// Cloudflare WARP, and other App Store / NE tunnels) advertise an agent
// description. Clients that create a plain utun from a daemon — NetBird and
// OpenVPN among them — expose no owner here and still fall back to the
// single-running-client rule. Best-effort and unprivileged: a failed ifconfig
// just yields no attributions.
func vpnInterfaceAttributions() map[string]string {
	out, err := runCollectorOutput(collectorShortCommandTimeout, "ifconfig", "-v")
	if err != nil {
		return nil
	}
	return parseIfconfigVPNAgents(string(out))
}
