//go:build darwin

package isolation

import (
	"fmt"
	"net/netip"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// pfBaseline is a snapshot of the host's configured resolvers. An empty list
// permits no off-host DNS; it never substitutes a public fallback.
type pfBaseline struct {
	Resolvers []netip.Addr
	Scoped    []pfScopedResolver
}

// pfScopedResolver binds a link-local resolver to its interface. The address
// alone could name a different host on another link.
type pfScopedResolver struct {
	Address   netip.Addr
	Interface string
}

// pfICMP6Baseline is spec §3.4: Packet Too Big, echo replies, and NDP/RA/MLD.
const pfICMP6Baseline = "{ 2 129 130 131 132 133 134 135 136 137 }"

// buildDarwinRules renders the anchor's ruleset. pf cannot identify a process,
// so both scopes install a destination permit (OD2 b): this is the macOS
// ceiling the spec documents, and why any process may reach an allowed address.
//
// Every rule is quick, so nothing later in the main ruleset can override it.
// Permits create state, which is the only way return traffic gets in: the drop
// rule catches everything else, both ways. Drop, never reject.
func buildDarwinRules(spec ResolvedSpec, baseline pfBaseline) string {
	var permits []string
	for _, entry := range spec.Entries {
		if entry.Scope != ScopeAny && entry.Scope != ScopeBreeze {
			continue
		}
		ports := pfPortList(entry.Ports)
		if ports == "" {
			continue
		}
		for _, addr := range entry.Addrs {
			if !addr.IsValid() || addr.Addr().Is4In6() {
				continue
			}
			for _, proto := range pfProtocols(entry.Proto) {
				permits = append(permits, pfPermit("", addr.Addr().Is4(), proto, addr.Masked().String(), ports))
			}
		}
	}
	slices.Sort(permits)

	rules := slices.Compact(permits)
	rules = append(rules,
		"pass quick on lo0 all no state",
		"pass out quick inet proto udp from any port 68 to any port 67 no state",
		"pass in quick inet proto udp from any port 67 to any port 68 no state",
		"pass out quick inet6 proto udp from any port 546 to any port 547 no state",
		"pass in quick inet6 proto udp from any port 547 to any port 546 no state",
		"pass quick inet proto icmp icmp-type 3 code 4 no state",
		"pass quick inet proto icmp icmp-type 0 no state",
		"pass quick inet6 proto icmp6 icmp6-type "+pfICMP6Baseline+" no state",
	)
	resolvers := slices.Clone(baseline.Resolvers)
	slices.SortFunc(resolvers, func(a, b netip.Addr) int { return a.Compare(b) })
	for _, resolver := range slices.Compact(resolvers) {
		if !pfUsableResolver(resolver) || resolver.Zone() != "" || resolver.IsLinkLocalUnicast() {
			continue
		}
		for _, proto := range []string{"tcp", "udp"} {
			rules = append(rules, pfPermit("", resolver.Is4(), proto, resolver.String(), "53"))
		}
	}
	scoped := slices.Clone(baseline.Scoped)
	slices.SortFunc(scoped, func(a, b pfScopedResolver) int {
		if c := a.Address.Compare(b.Address); c != 0 {
			return c
		}
		return strings.Compare(a.Interface, b.Interface)
	})
	for _, resolver := range slices.Compact(scoped) {
		if resolver.Interface == "" || !pfUsableResolver(resolver.Address) {
			continue
		}
		destination := resolver.Address.WithZone("").String() + "%" + resolver.Interface
		for _, proto := range []string{"tcp", "udp"} {
			rules = append(rules, pfPermit(resolver.Interface, resolver.Address.Is4(), proto, destination, "53"))
		}
	}
	rules = append(rules, `block drop quick all label "`+pfDropLabel+`"`)
	return strings.Join(rules, "\n") + "\n"
}

func pfUsableResolver(addr netip.Addr) bool {
	return addr.IsValid() && !addr.IsUnspecified() && !addr.IsMulticast()
}

func pfPermit(iface string, v4 bool, proto, destination, ports string) string {
	on := ""
	if iface != "" {
		on = "on " + iface + " "
	}
	family := "inet6"
	if v4 {
		family = "inet"
	}
	state := "keep state"
	if proto == "tcp" {
		state = "flags S/SA keep state"
	}
	return fmt.Sprintf("pass out quick %s%s proto %s from any to %s port %s %s", on, family, proto, destination, ports, state)
}

func pfProtocols(proto string) []string {
	switch proto {
	case ProtoTCP:
		return []string{"tcp"}
	case ProtoUDP:
		return []string{"udp"}
	case ProtoUDPTCP:
		return []string{"tcp", "udp"}
	}
	return nil
}

func pfPortList(ports []uint16) string {
	usable := slices.DeleteFunc(slices.Clone(ports), func(p uint16) bool { return p == 0 })
	slices.Sort(usable)
	usable = slices.Compact(usable)
	if len(usable) == 0 {
		return ""
	}
	names := make([]string, len(usable))
	for i, p := range usable {
		names[i] = strconv.Itoa(int(p))
	}
	if len(names) == 1 {
		return names[0]
	}
	return "{ " + strings.Join(names, " ") + " }"
}

// parseScutilDNS reads `scutil --dns`: the host's configured resolvers in both
// its default and scoped sections. A link-local resolver is kept only with an
// interface, from its own zone or its block's `if_index : N (en0)` line.
func parseScutilDNS(stdout string) pfBaseline {
	var baseline pfBaseline
	var pending []netip.Addr
	blockInterface := ""
	flush := func() {
		for _, addr := range pending {
			switch {
			case addr.Is6() && addr.IsLinkLocalUnicast():
				iface := addr.Zone()
				if iface == "" {
					iface = blockInterface
				}
				if iface != "" {
					baseline.Scoped = append(baseline.Scoped, pfScopedResolver{Address: addr.WithZone(""), Interface: iface})
				}
			case pfUsableResolver(addr):
				baseline.Resolvers = append(baseline.Resolvers, addr.Unmap())
			}
		}
		pending, blockInterface = nil, ""
	}
	for _, line := range strings.Split(stdout, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "resolver #"), strings.HasPrefix(line, "DNS configuration"):
			flush()
		case strings.HasPrefix(line, "nameserver["):
			if _, value, ok := strings.Cut(line, " : "); ok {
				if addr, err := netip.ParseAddr(strings.TrimSpace(value)); err == nil {
					pending = append(pending, addr)
				}
			}
		case strings.HasPrefix(line, "if_index"):
			if m := pfScutilInterface.FindStringSubmatch(line); m != nil {
				blockInterface = m[1]
			}
		}
	}
	flush()
	slices.SortFunc(baseline.Resolvers, func(a, b netip.Addr) int { return a.Compare(b) })
	baseline.Resolvers = slices.Compact(baseline.Resolvers)
	slices.SortFunc(baseline.Scoped, func(a, b pfScopedResolver) int {
		if c := a.Address.Compare(b.Address); c != 0 {
			return c
		}
		return strings.Compare(a.Interface, b.Interface)
	})
	baseline.Scoped = slices.Compact(baseline.Scoped)
	return baseline
}

var pfScutilInterface = regexp.MustCompile(`\(([^)]+)\)\s*$`)

// pfStateKill is one `pfctl -k <origin> -k <peer>`: pf kills by host pair, not
// by port, so a permitted flow sharing the pair goes too. It reconnects through
// its permit, while an attacker's flow does not.
type pfStateKill struct{ Origin, Peer string }

// statesToKill picks the pf states no permit matches (spec §3.4: existing flows
// are cut, not grandfathered). Any state it cannot read is an error: a state it
// skipped could be the attacker's.
func statesToKill(stdout string, spec ResolvedSpec, baseline pfBaseline) ([]pfStateKill, error) {
	var kills []pfStateKill
	for _, line := range strings.Split(stdout, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		state, err := parsePFState(line)
		if err != nil {
			return nil, err
		}
		if pfStatePermitted(state, spec, baseline) {
			continue
		}
		kill := pfStateKill{Origin: state.Local.Addr().WithZone("").String(), Peer: state.Remote.Addr().WithZone("").String()}
		if state.Inbound {
			kill.Origin, kill.Peer = kill.Peer, kill.Origin
		}
		kills = append(kills, kill)
	}
	slices.SortFunc(kills, func(a, b pfStateKill) int { return strings.Compare(a.Origin+"|"+a.Peer, b.Origin+"|"+b.Peer) })
	return slices.Compact(kills), nil
}

type pfState struct {
	Proto         string
	Local, Remote netip.AddrPort
	Inbound       bool
}

// parsePFState reads a `pfctl -ss` line. `->` is a state created outbound and
// `<-` inbound, with the local side printed first either way; a translated
// source adds `(addr:port)` before the arrow. IPv6 prints as addr[port]. This is
// the format pfctl(8) is expected to print: lab leg L3 confirms it.
func parsePFState(line string) (pfState, error) {
	fields := strings.Fields(line)
	arrow := slices.IndexFunc(fields, func(f string) bool { return f == "->" || f == "<-" })
	if arrow < 3 || arrow+1 >= len(fields) {
		return pfState{}, fmt.Errorf("cannot read pf state %q", line)
	}
	local := fields[2]
	remote, err := parsePFEndpoint(fields[arrow+1])
	if err != nil {
		return pfState{}, fmt.Errorf("cannot read pf state %q: %w", line, err)
	}
	localAddr, err := parsePFEndpoint(local)
	if err != nil {
		return pfState{}, fmt.Errorf("cannot read pf state %q: %w", line, err)
	}
	return pfState{Proto: fields[1], Local: localAddr, Remote: remote, Inbound: fields[arrow] == "<-"}, nil
}

func parsePFEndpoint(s string) (netip.AddrPort, error) {
	// A protocol with no ports (ESP, GRE) prints the bare address.
	if addr, err := netip.ParseAddr(s); err == nil {
		return netip.AddrPortFrom(addr.Unmap(), 0), nil
	}
	host, port := "", ""
	if open := strings.IndexByte(s, '['); open > 0 && strings.HasSuffix(s, "]") {
		host, port = s[:open], s[open+1:len(s)-1]
	} else if colon := strings.LastIndexByte(s, ':'); colon > 0 {
		host, port = s[:colon], s[colon+1:]
	} else {
		return netip.AddrPort{}, fmt.Errorf("bad endpoint %q", s)
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return netip.AddrPort{}, err
	}
	number, err := strconv.ParseUint(port, 10, 16)
	if err != nil {
		return netip.AddrPort{}, err
	}
	return netip.AddrPortFrom(addr.Unmap(), uint16(number)), nil
}

func pfStatePermitted(state pfState, spec ResolvedSpec, baseline pfBaseline) bool {
	local, remote := state.Local.Addr(), state.Remote.Addr()
	if local.IsLoopback() || remote.IsLoopback() {
		return true
	}
	if state.Proto == "udp" {
		localPort, remotePort := state.Local.Port(), state.Remote.Port()
		for _, pair := range [][2]uint16{{68, 67}, {67, 68}, {546, 547}, {547, 546}} {
			if localPort == pair[0] && remotePort == pair[1] {
				return true
			}
		}
	}
	// Permits are outbound only. Whatever a state created inbound is doing, no
	// rule in the anchor would allow it to start now.
	if state.Inbound {
		return false
	}
	if (state.Proto == "tcp" || state.Proto == "udp") && state.Remote.Port() == 53 {
		bare := remote.WithZone("")
		if slices.Contains(baseline.Resolvers, bare) || slices.ContainsFunc(baseline.Scoped, func(r pfScopedResolver) bool { return r.Address == bare }) {
			return true
		}
	}
	for _, entry := range spec.Entries {
		if !slices.Contains(pfProtocols(entry.Proto), state.Proto) || !slices.Contains(entry.Ports, state.Remote.Port()) {
			continue
		}
		if slices.ContainsFunc(entry.Addrs, func(p netip.Prefix) bool { return p.Contains(remote.WithZone("")) }) {
			return true
		}
	}
	return false
}

// parsePFDropPackets totals the packet counters of the rules carrying our drop
// label in `pfctl -vsr` output, where each rule is followed by bracketed stat
// lines. A label with no counter is an error and never reads as zero, because
// zero would mean "nothing dropped" and fail the probe for the wrong reason, or
// worse, a later non-zero reading would look like a real drop.
func parsePFDropPackets(stdout string) (uint64, error) {
	var total uint64
	found := false
	label := `label "` + pfDropLabel + `"`
	lines := strings.Split(stdout, "\n")
	for n, line := range lines {
		if !strings.Contains(line, label) {
			continue
		}
		counted := false
		for _, stat := range lines[n+1:] {
			stat = strings.TrimSpace(stat)
			if !strings.HasPrefix(stat, "[") {
				break
			}
			if m := pfPacketCounter.FindStringSubmatch(stat); m != nil {
				packets, err := strconv.ParseUint(m[1], 10, 64)
				if err != nil {
					return 0, fmt.Errorf("read the pf drop counter: %w", err)
				}
				total += packets
				counted = true
				break
			}
		}
		if !counted {
			return 0, fmt.Errorf("the pf rule labelled %s has no packet counter", pfDropLabel)
		}
		found = true
	}
	if !found {
		return 0, fmt.Errorf("no pf rule is labelled %s", pfDropLabel)
	}
	return total, nil
}

var pfPacketCounter = regexp.MustCompile(`Packets:\s*(\d+)`)
