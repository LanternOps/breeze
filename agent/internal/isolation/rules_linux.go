//go:build linux

package isolation

import (
	"bufio"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"slices"
	"strconv"
	"strings"

	"github.com/breeze-rmm/agent/internal/isolation/cgroup"
)

const (
	nftFamily  = "inet"
	nftTable   = "breeze_isolation"
	nftCounter = "breeze_drop"
	// nftFlowMark tags a flow a permit let out. Return traffic is accepted only
	// with this mark, so isolation never grandfathers an attacker's flow
	// through a blanket "established" rule (spec §3.4).
	nftFlowMark = "0x42424242"
)

// nftResolvConfPaths are where a Linux host records its resolvers: the
// configured file, then the upstreams behind a local stub (systemd-resolved,
// NetworkManager), whose address is loopback and so says nothing about where
// queries really go.
var nftResolvConfPaths = []string{
	"/etc/resolv.conf",
	"/run/systemd/resolve/resolv.conf",
	"/run/NetworkManager/no-stub-resolv.conf",
}

// buildNftRuleset renders the running ruleset. It is pure: the addresses, the
// cgroup and the resolvers are all inputs, so a golden file pins every rule.
//
// A scope:"breeze" permit is `socket cgroupv2` AND destination/port, never a
// destination-only rule: only sockets created in the agent's own cgroup can use
// the control plane's (possibly shared CDN) addresses. It has no `ct state new`
// clause on purpose. A flow the agent opened before this rule set loaded has
// no mark yet, and matching its next outbound packet is what adopts it; an
// attacker's flow to the same address has no permit because it is not in the
// agent's cgroup.
func buildNftRuleset(rs ResolvedSpec, layout cgroup.Layout, baseline Baseline) string {
	return renderNftTable(nftPermits(rs, &layout), baseline)
}

// buildNftBootRuleset renders the rules loaded before the network comes up.
// The agent's cgroup does not exist yet, so scope:"breeze" permits cannot be
// expressed, and a destination-only copy would open the management addresses
// to every process. They are simply absent until the agent starts and re-applies.
func buildNftBootRuleset(rs ResolvedSpec, baseline Baseline) string {
	return renderNftTable(nftPermits(rs, nil), baseline)
}

// nftBatch is the atomic replacement: the batch creates the table if absent so
// the delete always has a target, and nft commits all of it or none of it.
func nftBatch(ruleset string) string {
	return fmt.Sprintf("table %[1]s %[2]s\ndelete table %[1]s %[2]s\n", nftFamily, nftTable) + ruleset
}

// nftPermits returns the sorted, deduplicated permit lines. A nil layout
// leaves out every process-scoped permit.
func nftPermits(rs ResolvedSpec, layout *cgroup.Layout) []string {
	set := map[string]bool{}
	for _, entry := range rs.Entries {
		scoped := ""
		switch entry.Scope {
		case ScopeAny:
		case ScopeBreeze:
			if layout == nil {
				continue
			}
			scoped = fmt.Sprintf("socket cgroupv2 level %d %q ", layout.Level, layout.AgentPath)
		default:
			continue
		}
		ports := nftPortSet(entry.Ports)
		if ports == "" {
			continue
		}
		var v4, v6 []string
		for _, addr := range entry.Addrs {
			if !addr.IsValid() || addr.Addr().Is4In6() {
				continue
			}
			if addr.Addr().Is4() {
				v4 = append(v4, nftPrefix(addr))
			} else {
				v6 = append(v6, nftPrefix(addr))
			}
		}
		for _, proto := range nftProtocols(entry.Proto) {
			if len(v4) > 0 {
				set[fmt.Sprintf("%sip daddr %s %s dport %s ct mark set %s accept", scoped, nftSet(v4), proto, ports, nftFlowMark)] = true
			}
			if len(v6) > 0 {
				set[fmt.Sprintf("%sip6 daddr %s %s dport %s ct mark set %s accept", scoped, nftSet(v6), proto, ports, nftFlowMark)] = true
			}
		}
	}
	lines := make([]string, 0, len(set))
	for line := range set {
		lines = append(lines, line)
	}
	slices.Sort(lines)
	return lines
}

func nftPrefix(p netip.Prefix) string {
	p = p.Masked()
	if p.IsSingleIP() {
		return p.Addr().String()
	}
	return p.String()
}

func nftSet(members []string) string {
	members = slices.Clone(members)
	slices.Sort(members)
	return "{ " + strings.Join(slices.Compact(members), ", ") + " }"
}

func nftPortSet(ports []uint16) string {
	sorted := slices.Clone(ports)
	slices.Sort(sorted)
	sorted = slices.Compact(sorted)
	members := make([]string, 0, len(sorted))
	for _, port := range sorted {
		if port != 0 {
			members = append(members, strconv.Itoa(int(port)))
		}
	}
	if len(members) == 0 {
		return ""
	}
	return "{ " + strings.Join(members, ", ") + " }"
}

func nftProtocols(proto string) []string {
	switch proto {
	case ProtoTCP:
		return []string{"tcp"}
	case ProtoUDP:
		return []string{"udp"}
	case ProtoUDPTCP:
		return []string{"tcp", "udp"}
	default:
		return nil
	}
}

// nftBaselineBoth is spec §3.4's any-process baseline in both directions:
// DHCP (losing the lease strands the agent) and the ICMP that address
// configuration and path-MTU discovery need. Numeric ICMP types read the same
// on every nft version.
var nftBaselineBoth = []string{
	"meta nfproto ipv4 udp sport 67 udp dport 68 accept",
	"meta nfproto ipv4 udp sport 68 udp dport 67 accept",
	"meta nfproto ipv6 udp sport 546 udp dport 547 accept",
	"meta nfproto ipv6 udp sport 547 udp dport 546 accept",
	"icmp type 0 accept",
	"icmp type 3 icmp code 4 accept",
	"icmpv6 type { 2, 129, 130, 131, 132, 133, 134, 135, 136, 137 } accept",
}

// nftDNSPermits allows DNS to the configured resolvers only, for any process:
// the host resolver answers on the agent's behalf, so DNS cannot be scoped.
// Loopback needs no permit, and an unscoped link-local address could mean a
// different peer on each link.
func nftDNSPermits(baseline Baseline) []string {
	var v4, v6 []string
	for _, addr := range baseline.Resolvers {
		addr = addr.Unmap()
		if !addr.IsValid() || addr.IsUnspecified() || addr.IsMulticast() || addr.IsLoopback() ||
			addr.IsLinkLocalUnicast() || addr.Zone() != "" {
			continue
		}
		if addr.Is4() {
			v4 = append(v4, addr.String())
		} else {
			v6 = append(v6, addr.String())
		}
	}
	var lines []string
	for _, proto := range []string{"tcp", "udp"} {
		if len(v4) > 0 {
			lines = append(lines, fmt.Sprintf("ip daddr %s %s dport 53 ct mark set %s accept", nftSet(v4), proto, nftFlowMark))
		}
	}
	for _, proto := range []string{"tcp", "udp"} {
		if len(v6) > 0 {
			lines = append(lines, fmt.Sprintf("ip6 daddr %s %s dport 53 ct mark set %s accept", nftSet(v6), proto, nftFlowMark))
		}
	}
	return lines
}

func renderNftTable(permits []string, baseline Baseline) string {
	established := fmt.Sprintf("ct state established,related ct mark %s accept", nftFlowMark)
	input := []string{`iif "lo" accept`, established}
	input = append(input, nftBaselineBoth...)

	output := []string{`oif "lo" accept`, established}
	output = append(output, nftBaselineBoth...)
	output = append(output, nftDNSPermits(baseline)...)
	output = append(output, permits...)
	// Only outbound drops are counted: the negative probe is an outbound SYN,
	// and inbound noise must not read as our rule having dropped it.
	output = append(output, fmt.Sprintf("counter name %q drop", nftCounter))

	var b strings.Builder
	fmt.Fprintf(&b, "table %s %s {\n\tcounter %s {\n\t}\n", nftFamily, nftTable, nftCounter)
	writeChain := func(hook string, rules []string) {
		fmt.Fprintf(&b, "\n\tchain %s {\n\t\ttype filter hook %s priority filter - 10; policy drop;\n", hook, hook)
		for _, rule := range rules {
			b.WriteString("\t\t" + rule + "\n")
		}
		b.WriteString("\t}\n")
	}
	writeChain("input", input)
	writeChain("output", output)
	// Forwarded traffic (containers, libvirt bridges) is simply dropped.
	writeChain("forward", nil)
	b.WriteString("}\n")
	return b.String()
}

// parseResolvConf returns the nameserver addresses, skipping what cannot be
// parsed: this is a permit list, so an unknown line can only ever permit less.
func parseResolvConf(content string) []netip.Addr {
	var out []netip.Addr
	scanner := bufio.NewScanner(strings.NewReader(content))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 || fields[0] != "nameserver" {
			continue
		}
		if addr, err := netip.ParseAddr(fields[1]); err == nil {
			out = append(out, addr)
		}
	}
	return out
}

// readLinuxBaseline reads the configured resolvers, never a public fallback.
// A missing file is normal (each stub writes its own); any other read error
// stops the apply before the host changes.
func readLinuxBaseline() (Baseline, error) {
	var resolvers []netip.Addr
	for _, path := range nftResolvConfPaths {
		data, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return Baseline{}, fmt.Errorf("read %s: %w", path, err)
		}
		resolvers = append(resolvers, parseResolvConf(string(data))...)
	}
	slices.SortFunc(resolvers, func(a, b netip.Addr) int { return a.Compare(b) })
	return Baseline{Resolvers: slices.Compact(resolvers)}, nil
}
