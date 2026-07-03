package collectors

import (
	"encoding/json"
	"net"
	"strings"

	psnet "github.com/shirou/gopsutil/v3/net"
	"github.com/shirou/gopsutil/v3/process"
)

// VPN-client presence telemetry (#2139). Read-only current state: detect which
// VPN overlay clients have an active tunnel from local interface/adapter
// heuristics plus per-OS service/process signals, then report normalized
// metadata. NO secrets, peer lists, keys, or VPN management — this only
// surfaces provider / active state / interface / overlay IPs / DNS name so
// operators can see at a glance which devices are reachable over a VPN.

// Normalized provider ids. Keep in sync with VpnProvider in packages/shared.
const (
	vpnWireGuard      = "wireguard"
	vpnTailscale      = "tailscale"
	vpnNetBird        = "netbird"
	vpnZeroTier       = "zerotier"
	vpnOpenVPN        = "openvpn"
	vpnCloudflareWARP = "cloudflare-warp"
	vpnGeneric        = "generic"
)

// Detection sources. Keep in sync with VpnDetectionSource in packages/shared.
const (
	vpnSourceInterface = "interface"
	vpnSourceService   = "service"
	vpnSourceProcess   = "process"
	vpnSourceAdapter   = "adapter"
)

// VpnPresence is the agent-sent wire shape for one detected VPN. The API stamps
// reportedAt on ingest, so it is intentionally absent here. Mirrors VpnPresence
// in packages/shared minus reportedAt.
type VpnPresence struct {
	Provider        string `json:"provider"`
	Active          bool   `json:"active"`
	InterfaceName   string `json:"interfaceName"`
	IPv4            string `json:"ipv4,omitempty"`
	IPv6            string `json:"ipv6,omitempty"`
	DNSName         string `json:"dnsName,omitempty"`
	DetectionSource string `json:"detectionSource"`
}

type VPNCollector struct{}

func NewVPNCollector() *VPNCollector {
	return &VPNCollector{}
}

// Collect returns the set of VPN overlay clients with an active tunnel. It is
// interface-driven (the reliable cross-platform signal that a tunnel is truly
// up with an overlay IP), with per-OS service/process signals used only to
// disambiguate a generic tunnel adapter to a specific provider and to record
// the detection source.
func (c *VPNCollector) Collect() ([]VpnPresence, error) {
	ifaces, err := psnet.Interfaces()
	if err != nil {
		return nil, err
	}
	return assembleVPNs(ifaces, runningVPNSignals(), tailscaleDNSName), nil
}

// assembleVPNs is the pure detection assembly: given the interface list, the
// provider->source signal map, and a lazy Tailscale-DNS resolver, it produces
// the reported VPN set. Split out from Collect (which owns the impure OS calls)
// so the branch logic — no-IP skip, generic promotion, source corroboration,
// per-provider DNS attachment — is table-testable. dnsFn is invoked at most
// once, only when a Tailscale tunnel is present.
func assembleVPNs(ifaces []psnet.InterfaceStat, signals map[string]string, dnsFn func() string) []VpnPresence {
	var (
		vpns             []VpnPresence
		tailscaleName    string
		tailscaleFetched bool
	)

	for _, iface := range ifaces {
		provider, isTunnel := classifyVPNInterface(iface.Name)
		if !isTunnel || !interfaceIsUp(iface.Flags) {
			continue
		}

		ipv4, ipv6 := extractVPNIPs(iface.Addrs)
		if ipv4 == "" && ipv6 == "" {
			// An up tunnel adapter with no overlay IP is not actually
			// connected — skip it so we don't report phantom VPNs.
			continue
		}

		source := vpnSourceInterface
		if provider == vpnGeneric {
			// Generic tunnel (e.g. utun3 on macOS, tun0): promote to a
			// specific provider only when exactly one known VPN
			// service/process is running, so we never guess wrong.
			if p, src, ok := soleVPNSignal(signals); ok {
				provider, source = p, src
			}
		} else if src, ok := signals[provider]; ok {
			// A matching service/process corroborates the interface guess.
			source = src
		}

		vpn := VpnPresence{
			Provider:        provider,
			Active:          true,
			InterfaceName:   iface.Name,
			IPv4:            ipv4,
			IPv6:            ipv6,
			DetectionSource: source,
		}

		if provider == vpnTailscale {
			if !tailscaleFetched {
				tailscaleName = dnsFn()
				tailscaleFetched = true
			}
			vpn.DNSName = tailscaleName
		}

		vpns = append(vpns, vpn)
	}

	return vpns
}

// classifyVPNInterface maps an interface/adapter name to a VPN provider. It
// returns (provider, true) for anything that looks like a tunnel adapter —
// specific provider when the name is distinctive, else "generic". On Windows,
// gopsutil returns the friendly adapter name (e.g. "Tailscale", "OpenVPN
// TAP-Windows Adapter V9") so the same name-based rules classify those too.
func classifyVPNInterface(name string) (string, bool) {
	n := strings.ToLower(name)
	switch {
	case strings.Contains(n, "tailscale"):
		return vpnTailscale, true
	case strings.Contains(n, "netbird"):
		return vpnNetBird, true
	case strings.Contains(n, "zerotier") || strings.HasPrefix(n, "zt"):
		return vpnZeroTier, true
	case strings.Contains(n, "wireguard") || strings.HasPrefix(n, "wg"):
		return vpnWireGuard, true
	case strings.Contains(n, "warp") || strings.Contains(n, "cloudflare"):
		return vpnCloudflareWARP, true
	case strings.Contains(n, "openvpn") || strings.Contains(n, "tap-windows") || strings.Contains(n, "tap-win"):
		return vpnOpenVPN, true
	case strings.HasPrefix(n, "utun") ||
		strings.HasPrefix(n, "tun") ||
		strings.HasPrefix(n, "tap") ||
		strings.HasPrefix(n, "ppp") ||
		strings.HasPrefix(n, "wt"):
		return vpnGeneric, true
	default:
		return "", false
	}
}

func interfaceIsUp(flags []string) bool {
	for _, f := range flags {
		if strings.EqualFold(f, "up") {
			return true
		}
	}
	return false
}

// extractVPNIPs returns the first IPv4 and first non-link-local IPv6 on the
// interface. Link-local IPv6 (fe80::) is skipped — it's not an overlay address.
func extractVPNIPs(addrs []psnet.InterfaceAddr) (string, string) {
	var ipv4, ipv6 string
	for _, addr := range addrs {
		ip := parseAddrIP(addr.Addr)
		if ip == nil {
			continue
		}
		if ip.To4() != nil {
			if ipv4 == "" {
				ipv4 = ip.String()
			}
		} else if ipv6 == "" && !ip.IsLinkLocalUnicast() {
			ipv6 = ip.String()
		}
	}
	return ipv4, ipv6
}

func parseAddrIP(addr string) net.IP {
	if ip, _, err := net.ParseCIDR(addr); err == nil {
		return ip
	}
	return net.ParseIP(addr)
}

// soleVPNSignal returns the single specific (non-generic) provider that has a
// running service/process, if exactly one exists. When zero or many are
// running we can't safely map a generic tunnel to a provider, so it stays
// generic.
func soleVPNSignal(signals map[string]string) (string, string, bool) {
	var provider, source string
	count := 0
	for p, s := range signals {
		if p == vpnGeneric {
			continue
		}
		provider, source = p, s
		count++
	}
	if count == 1 {
		return provider, source, true
	}
	return "", "", false
}

// runningVPNSignals merges cross-platform process signals with per-OS service
// signals into provider -> detection-source. Service signals take precedence
// for the source label when both fire.
func runningVPNSignals() map[string]string {
	signals := make(map[string]string)
	for provider := range runningVPNProcesses() {
		signals[provider] = vpnSourceProcess
	}
	for provider := range vpnServiceSignals() {
		signals[provider] = vpnSourceService
	}
	return signals
}

// vpnProcessSignatures maps a provider to lowercase process-name tokens. Match
// is exact or substring against the process base name (.exe stripped).
var vpnProcessSignatures = map[string][]string{
	vpnWireGuard:      {"wireguard", "wg-quick"},
	vpnTailscale:      {"tailscaled", "tailscale"},
	vpnNetBird:        {"netbird"},
	vpnZeroTier:       {"zerotier-one", "zerotier_one", "zerotier"},
	vpnOpenVPN:        {"openvpn"},
	vpnCloudflareWARP: {"warp-svc", "cloudflarewarp"},
}

func runningVPNProcesses() map[string]bool {
	found := make(map[string]bool)
	procs, err := process.Processes()
	if err != nil {
		return found
	}
	for _, p := range procs {
		name, err := p.Name()
		if err != nil {
			continue
		}
		ln := strings.TrimSuffix(strings.ToLower(name), ".exe")
		for provider, sigs := range vpnProcessSignatures {
			for _, sig := range sigs {
				if strings.Contains(ln, sig) {
					found[provider] = true
					break
				}
			}
		}
	}
	return found
}

// vpnServiceSignatures maps a provider to lowercase tokens matched against a
// running-services listing (per-OS command output). Kept broad because service
// names vary (e.g. "WireGuardTunnel$home", "OpenVPNServiceInteractive").
var vpnServiceSignatures = map[string][]string{
	vpnWireGuard:      {"wireguard", "wg-quick"},
	vpnTailscale:      {"tailscale"},
	vpnNetBird:        {"netbird"},
	vpnZeroTier:       {"zerotier"},
	vpnOpenVPN:        {"openvpn"},
	vpnCloudflareWARP: {"warp", "cloudflare"},
}

// matchVPNServiceTokens scans a running-services listing for provider tokens.
// Pure and OS-agnostic so it can be unit-tested with canned command output.
func matchVPNServiceTokens(servicesText string) map[string]bool {
	lower := strings.ToLower(servicesText)
	found := make(map[string]bool)
	for provider, sigs := range vpnServiceSignatures {
		for _, sig := range sigs {
			if strings.Contains(lower, sig) {
				found[provider] = true
				break
			}
		}
	}
	return found
}

// tailscaleDNSName best-effort fetches the device's Tailscale MagicDNS name.
// Returns "" if the CLI is absent, times out, or errors — never blocks or
// fails collection. Only the device's own DNS name is read; no peer data.
func tailscaleDNSName() string {
	out, err := runCollectorOutput(collectorShortCommandTimeout, "tailscale", "status", "--json")
	if err != nil {
		return ""
	}
	var status struct {
		Self struct {
			DNSName string `json:"DNSName"`
		} `json:"Self"`
	}
	if err := json.Unmarshal(out, &status); err != nil {
		return ""
	}
	return strings.TrimSuffix(status.Self.DNSName, ".")
}
