package collectors

import (
	"encoding/json"
	"net"
	"sort"
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

	// Enterprise VPN / SSE clients (#8763). Zscaler Client Connector steers
	// traffic through a filter driver rather than its own adapter on Windows
	// (Netskope may do the same), so for it the interface-driven "active"
	// signal usually cannot fire there — see the note on assembleVPNs.
	vpnZscaler           = "zscaler"
	vpnGlobalProtect     = "globalprotect"
	vpnCiscoSecureClient = "cisco-secure-client"
	vpnFortiClient       = "forticlient"
	vpnNetskope          = "netskope"
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

// Collect returns the VPN overlay clients present on this device: the ones with
// an active tunnel (interface-driven — the reliable cross-platform signal that a
// tunnel is truly up with an overlay IP), plus the ones whose client is running
// with no tunnel up, reported as inactive. Per-OS service/process signals
// disambiguate a generic tunnel adapter to a specific provider, record the
// detection source, and drive the inactive set.
func (c *VPNCollector) Collect() ([]VpnPresence, error) {
	ifaces, err := psnet.Interfaces()
	if err != nil {
		return nil, err
	}
	return assembleVPNs(ifaces, runningVPNSignals(), tailscaleDNSName, vpnInterfaceAttributions), nil
}

// assembleVPNs is the pure detection assembly: given the interface list, the
// provider->source signal map, a lazy Tailscale-DNS resolver, and a lazy
// per-interface attribution map, it produces the reported VPN set. Split out
// from Collect (which owns the impure OS calls) so the branch logic — no-IP
// skip, generic promotion, source corroboration, per-provider DNS attachment,
// inactive reporting — is table-testable. dnsFn is invoked at most once, only
// when a Tailscale tunnel is present; attrFn at most once, only when a generic
// tunnel is present.
//
// Clients with no tunnel adapter (#8763): Zscaler Client Connector on Windows
// binds the "Zscaler LightWeight Filter" NDIS filter to the existing Ethernet
// and Wi-Fi adapters and creates no NIC of its own (it ships wintun/wireguard
// DLLs, but no such adapter appears while the tunnel runs). With no interface
// there is no evidence the tunnel is up, so a running Zscaler service/process
// is reported only as inactive — "client running" — never as active. On macOS
// its tunnel is a plain utun with no network-extension description, so it is
// named only through the sole-running-client fallback below.
func assembleVPNs(
	ifaces []psnet.InterfaceStat,
	signals map[string]string,
	dnsFn func() string,
	attrFn func() map[string]string,
) []VpnPresence {
	var (
		vpns             []VpnPresence
		tailscaleName    string
		tailscaleFetched bool
		attributions     map[string]string
		attrFetched      bool
	)
	activeProviders := make(map[string]bool)
	// An up tunnel we could not attribute to a provider could belong to ANY of
	// the running clients, so its presence makes "this provider is
	// disconnected" unprovable — see the inactive pass below.
	unattributedTunnel := false

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
			// Generic tunnel (e.g. utun3 on macOS, tun0). Prefer concrete
			// per-interface evidence (macOS reports the owning network
			// extension's description per utun); fall back to promoting only
			// when exactly one known VPN client is running. Either way we
			// never guess a name onto an interface without evidence tying
			// the two together.
			if !attrFetched {
				attributions = attrFn()
				attrFetched = true
			}
			if p, ok := attributions[iface.Name]; ok {
				provider, source = p, vpnSourceAdapter
			} else if p, src, ok := soleVPNSignal(signals); ok {
				provider, source = p, src
			} else {
				unattributedTunnel = true
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

		activeProviders[provider] = true
		vpns = append(vpns, vpn)
	}

	return append(vpns, inactiveVPNs(signals, activeProviders, unattributedTunnel)...)
}

// inactiveVPNs reports the known VPN clients that are running but have no
// tunnel up, so a disconnected VPN shows as inactive instead of vanishing from
// the list (#2139). Entries carry no interface or IPs — there is no tunnel to
// describe — only the provider and the service/process signal that proves the
// client is installed and running. Never a guess: a provider with no concrete
// running signal is not reported at all.
//
// When an up tunnel could not be attributed to a provider, the whole inactive
// pass is suppressed: that tunnel may well belong to one of the running
// clients, and calling it disconnected would be worse than saying nothing.
func inactiveVPNs(signals map[string]string, activeProviders map[string]bool, unattributedTunnel bool) []VpnPresence {
	if unattributedTunnel {
		return nil
	}

	providers := make([]string, 0, len(signals))
	for provider := range signals {
		if provider == vpnGeneric || activeProviders[provider] {
			continue
		}
		providers = append(providers, provider)
	}
	// Map iteration order is random; sort so the reported set is stable across
	// collections and doesn't churn stored inventory.
	sort.Strings(providers)

	inactive := make([]VpnPresence, 0, len(providers))
	for _, provider := range providers {
		inactive = append(inactive, VpnPresence{
			Provider:        provider,
			Active:          false,
			DetectionSource: signals[provider],
		})
	}
	return inactive
}

// classifyVPNInterface maps an interface/adapter name to a VPN provider. It
// returns (provider, true) for anything that looks like a tunnel adapter —
// specific provider when the name is distinctive, else "generic". On Windows,
// gopsutil returns the friendly adapter name (e.g. "Tailscale", "OpenVPN
// TAP-Windows Adapter V9") so the same name-based rules classify those too.
func classifyVPNInterface(name string) (string, bool) {
	n := strings.ToLower(name)
	switch {
	// Enterprise clients first, so a vendor adapter that happens to mention
	// another provider's keyword (or start with "tap"/"tun") keeps its vendor.
	case strings.Contains(n, "zscaler"):
		return vpnZscaler, true
	case strings.Contains(n, "pangp") || strings.Contains(n, "globalprotect") || strings.HasPrefix(n, "gpd"):
		return vpnGlobalProtect, true
	case strings.Contains(n, "anyconnect") || strings.Contains(n, "cisco secure client") || strings.HasPrefix(n, "cscotun"):
		return vpnCiscoSecureClient, true
	case strings.Contains(n, "fortinet") || strings.Contains(n, "forticlient") || strings.Contains(n, "fortissl"):
		return vpnFortiClient, true
	case strings.Contains(n, "netskope"):
		return vpnNetskope, true
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

// parseIfconfigVPNAgents maps interface name -> provider from `ifconfig -v`
// output on macOS. Each network-extension-backed tunnel carries an indented
// line of the form:
//
//	agent domain:NetworkExtension type:VPN flags:0x3 desc:"VPN: Tailscale 3"
//
// which is concrete per-interface evidence of the owning VPN client — the one
// thing a global "is this client running" signal can't give us when several
// clients run at once (#2139). Only NetworkExtension/VPN agents are read, and
// only when the description matches exactly one known provider; an unknown or
// ambiguous description yields no attribution rather than a guess. Pure and
// OS-agnostic so it can be unit-tested with canned command output.
func parseIfconfigVPNAgents(text string) map[string]string {
	attributions := make(map[string]string)
	current := ""
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		// Interface header lines start at column 0: "utun6: flags=8051<...".
		if line[0] != ' ' && line[0] != '\t' {
			current = ""
			if name, _, ok := strings.Cut(trimmed, ":"); ok && strings.Contains(trimmed, "flags=") {
				current = name
			}
			continue
		}
		if current == "" || !strings.HasPrefix(trimmed, "agent ") {
			continue
		}
		if !strings.Contains(trimmed, "domain:NetworkExtension") || !strings.Contains(trimmed, "type:VPN") {
			continue
		}
		_, desc, ok := strings.Cut(trimmed, `desc:"`)
		if !ok {
			continue
		}
		desc, _, ok = strings.Cut(desc, `"`)
		if !ok {
			continue
		}
		if matched := matchVPNAgentDescription(desc); len(matched) == 1 {
			for provider := range matched {
				attributions[current] = provider
			}
		}
	}
	return attributions
}

// vpnAgentDescriptionSignatures adds vendor names that are too broad for a
// services listing but safe in a network-extension VPN description: that line
// only exists on a VPN-type tunnel, so "Cisco Secure Client" there names the
// VPN module, not Umbrella or another module of the same client.
var vpnAgentDescriptionSignatures = map[string][]string{
	vpnCiscoSecureClient: {"cisco secure client", "anyconnect"},
	vpnFortiClient:       {"forticlient", "fortinet"},
}

// matchVPNAgentDescription matches a macOS network-extension VPN description
// against the service tokens plus vpnAgentDescriptionSignatures.
func matchVPNAgentDescription(desc string) map[string]bool {
	found := matchVPNServiceTokens(desc)
	lower := strings.ToLower(desc)
	for provider, sigs := range vpnAgentDescriptionSignatures {
		for _, sig := range sigs {
			if strings.Contains(lower, sig) {
				found[provider] = true
				break
			}
		}
	}
	return found
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

// vpnProcessSignatures maps a provider to lowercase process-name tokens matched
// as a SUBSTRING of the process base name (.exe stripped). Only vendor-branded
// tokens belong here; short or generic names go in vpnProcessExactNames.
var vpnProcessSignatures = map[string][]string{
	vpnWireGuard:      {"wireguard", "wg-quick"},
	vpnTailscale:      {"tailscaled", "tailscale"},
	vpnNetBird:        {"netbird"},
	vpnZeroTier:       {"zerotier-one", "zerotier_one", "zerotier"},
	vpnOpenVPN:        {"openvpn"},
	vpnCloudflareWARP: {"warp-svc", "cloudflarewarp"},
	vpnGlobalProtect:  {"globalprotect"},
	vpnNetskope:       {"netskope client"},
}

// vpnProcessExactNames maps a provider to lowercase process base names (.exe
// stripped) that must match EXACTLY. Used where a substring would be unsafe:
// a "zscaler" or "zsa" substring would also catch ZscalerPreLogin (the
// login-window UI, not the client) or any unrelated zsa* binary, and
// "vpnagent" is generic enough to sit inside another vendor's binary name.
//
// Cisco and Fortinet ship multi-module clients, so only their VPN component
// counts: a shared UI (vpnui, csc_ui, the "Cisco Secure Client" app,
// FortiClient/FortiTray) or a non-VPN module (Umbrella, FortiClient antivirus)
// runs on installs that never use the VPN, and claiming it would also stop
// soleVPNSignal from leaving an unrelated tunnel generic. Cisco's core VPN
// agent does run on Umbrella-only installs too; that residual is accepted.
//
// Zscaler names are field-captured (#8763): Windows ZSATunnel, ZSAService,
// ZSATray (user tray, not a service), ZSATrayManager, ZSAUpm; macOS Zscaler
// (tray), ZscalerService, the TRPTunnel system extension and
// UPMServiceController. ZscalerTunnel is installed on macOS but launched on
// demand. The other vendors' names come from vendor documentation and are
// not yet field-verified.
var vpnProcessExactNames = map[string][]string{
	vpnZscaler: {
		"zsatunnel", "zsaservice", "zsatray", "zsatraymanager", "zsaupm",
		"zscaler", "zscalerservice", "zscalertunnel",
		"com.zscaler.zscaler.trptunnel", "upmservicecontroller",
	},
	vpnGlobalProtect:     {"pangpa", "pangps"},
	vpnCiscoSecureClient: {"vpnagent", "vpnagentd"},
	vpnFortiClient:       {"fortisslvpndaemon"},
	vpnNetskope:          {"stagentsvc", "stagentui", "stagentsvcmon"},
}

// kernelCommNameLen is the shortest length at which a process name may have
// been truncated by the kernel: Linux comm holds 15 characters and macOS p_comm
// 16. gopsutil replaces a 15+ character name with argv[0]'s base name, so a
// truncated name reaches us only when argv reads back empty or (Linux) argv[0]
// was rewritten; when argv can't be read at all, Name() errors and the
// process is skipped.
const kernelCommNameLen = 15

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
		for provider := range matchVPNProcessName(name) {
			found[provider] = true
		}
	}
	return found
}

// matchVPNProcessName returns the providers a single process name belongs to.
// Pure so the token tables can be tested without a process list.
func matchVPNProcessName(name string) map[string]bool {
	found := make(map[string]bool)
	ln := strings.TrimSuffix(strings.ToLower(name), ".exe")
	if ln == "" {
		return found
	}
	for provider, sigs := range vpnProcessSignatures {
		for _, sig := range sigs {
			if strings.Contains(ln, sig) {
				found[provider] = true
				break
			}
		}
	}
	for provider, names := range vpnProcessExactNames {
		for _, exact := range names {
			if processNameIs(ln, exact) {
				found[provider] = true
				break
			}
		}
	}
	return found
}

// processNameIs reports whether a lowercased process base name is the given
// exact name, also accepting a kernel-truncated form (e.g. "com.zscaler.zsca"
// for the TRPTunnel extension, macOS p_comm). Defensive: see kernelCommNameLen
// for when gopsutil can hand back a truncated name. A truncated name is never
// shorter than kernelCommNameLen, so a short name that merely starts the same
// way does not match.
func processNameIs(name, exact string) bool {
	if name == exact {
		return true
	}
	return len(name) >= kernelCommNameLen && len(name) < len(exact) && strings.HasPrefix(exact, name)
}

// vpnServiceSignatures maps a provider to lowercase tokens matched against a
// running-services listing (per-OS command output: Windows Name + DisplayName,
// launchd labels, systemd unit + description). Kept broad because service
// names vary (e.g. "WireGuardTunnel$home", "OpenVPNServiceInteractive").
//
// Enterprise tokens are deliberately narrow (#8763). There is no bare
// "zscaler" token: Zscaler's ZDP data-protection services also say "Zscaler"
// and are not the tunnel client. The two Zscaler drivers are matched on their
// DisplayName ("Zscaler LightWeight Filter" for zapprd, "Zscaler Filtering
// Platform (WFP)" for zsawdrv), since the driver names don't say Zscaler.
// Cisco and Fortinet match only their VPN component (see vpnProcessExactNames):
// no bare "anyconnect", "cisco secure client" or "forticlient", which also
// name the Umbrella/ISE/NAM modules and FortiClient's antivirus scheduler.
// Non-Zscaler enterprise tokens come from vendor documentation and are not
// yet field-verified.
var vpnServiceSignatures = map[string][]string{
	vpnWireGuard:      {"wireguard", "wg-quick"},
	vpnTailscale:      {"tailscale"},
	vpnNetBird:        {"netbird"},
	vpnZeroTier:       {"zerotier"},
	vpnOpenVPN:        {"openvpn"},
	vpnCloudflareWARP: {"warp", "cloudflare"},
	vpnZscaler: {
		"zsatunnel", "zsaservice", "zsaupm", "zsatraymanager",
		"zscaler lightweight filter", "zscaler filtering platform",
		"com.zscaler.service", "com.zscaler.tray", "com.zscaler.upmservicecontroller",
	},
	vpnGlobalProtect: {"pangps", "pangpa", "globalprotect"},
	vpnCiscoSecureClient: {
		"csc_vpnagent", "anyconnect vpn agent", "anyconnect secure mobility agent",
		"com.cisco.secureclient.vpnagentd", "com.cisco.anyconnect.vpnagentd",
	},
	vpnFortiClient: {"fortisslvpn"},
	vpnNetskope:    {"stagentsvc", "netskope client"},
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
