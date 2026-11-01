package isolation

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"slices"
	"sort"
	"strings"

	"github.com/breeze-rmm/agent/internal/isolation/wfp"
)

// Baseline is a snapshot of the host's configured resolvers. An empty list
// permits no off-host DNS; it never substitutes a public fallback resolver.
type Baseline struct {
	Resolvers       []netip.Addr
	ScopedResolvers []ScopedResolver
}

// ScopedResolver binds a resolver address to its Windows interface LUID. A
// link-local IPv6 address alone could permit a different peer on each link.
type ScopedResolver struct {
	Address   netip.Addr
	Interface uint64
}

const (
	windowsPermitWeight uint64 = 100
	windowsBlockWeight  uint64 = 1
)

var windowsBinaryNames = []string{
	"breeze-agent.exe", "breeze-watchdog.exe", "breeze-desktop-helper.exe",
	"breeze-user-helper.exe", "breeze-backup.exe",
}

// buildWindowsRules is deliberately portable: no filesystem access, name
// resolution or native app-ID conversion can change a policy in this builder.
// Boot-time policy contains only the system baseline, never a destination-only
// copy of a Breeze management permit. BFE installs the per-app permits at start.
func buildWindowsRules(rs ResolvedSpec, bins []string, prevBins []string, baseline Baseline) []wfp.Filter {
	byKey := make(map[wfp.GUID]wfp.Filter)
	add := func(name string, layer wfp.Layer, conditions []wfp.Condition, boot bool, action wfp.Action) {
		weight := windowsPermitWeight
		if action == wfp.Block {
			weight = windowsBlockWeight
		}
		f := wfp.Filter{Name: name, Layer: layer, Sublayer: wfp.SublayerKey, Weight: weight,
			Action: action, Conditions: conditions, Persistent: !boot, BootTime: boot}
		// Include every predicate, lifetime and layer in identity. The key does
		// not depend on input order, resolver answer order, or the episode ID.
		identity, err := json.Marshal(f)
		if err != nil {
			// Keys would collapse onto one identity; never build such a policy.
			panic(fmt.Sprintf("marshal WFP filter identity: %v", err))
		}
		f.Key = wfp.FilterKey(string(identity))
		byKey[f.Key] = f
	}
	paths := canonicalWindowsPaths(append(slices.Clone(bins), prevBins...))
	for _, entry := range rs.Entries {
		if entry.Scope != ScopeAny && entry.Scope != ScopeBreeze {
			continue
		}
		apps := paths
		if entry.Scope == ScopeAny {
			apps = []string{""}
		}
		for _, addr := range entry.Addrs {
			if !addr.IsValid() || addr.Addr().Is4In6() {
				continue
			}
			for _, layer := range windowsLayers(addr.Addr().Is4()) {
				for _, proto := range windowsProtocols(entry.Proto) {
					for _, port := range entry.Ports {
						if port == 0 {
							continue
						}
						for _, path := range apps {
							conditions := []wfp.Condition{
								{Field: wfp.RemoteAddress, Address: addr.Masked()},
								{Field: wfp.RemotePort, Uint: uint32(port)},
								{Field: wfp.Protocol, Uint: proto},
							}
							if path != "" {
								conditions = append(conditions, wfp.Condition{Field: wfp.AppID, AppPath: path})
							}
							add("allow/"+entry.Scope, layer, conditions, false, wfp.Permit)
						}
					}
				}
			}
		}
	}
	for _, boot := range []bool{false, true} {
		for _, v4 := range []bool{true, false} {
			for _, layer := range windowsLayers(v4) {
				add("baseline/loopback", layer, []wfp.Condition{{Field: wfp.Flags, Uint: 1, Match: wfp.MatchFlagsAllSet}}, boot, wfp.Permit)
				client, server := uint32(546), uint32(547)
				if v4 {
					client, server = 68, 67
				}
				for _, pair := range [][2]uint32{{client, server}, {server, client}} {
					add("baseline/dhcp", layer, []wfp.Condition{{Field: wfp.Protocol, Uint: 17}, {Field: wfp.LocalPort, Uint: pair[0]}, {Field: wfp.RemotePort, Uint: pair[1]}}, boot, wfp.Permit)
				}
				// ALE aliases IP_LOCAL_PORT to ICMP type, IP_REMOTE_PORT to code.
				// These are not TCP/UDP ports; constrain IP_PROTOCOL as well.
				// Echo replies are in spec §3.4, but echo requests remain blocked.
				if v4 {
					add("baseline/icmp-fragmentation-needed", layer, []wfp.Condition{{Field: wfp.Protocol, Uint: 1}, {Field: wfp.LocalPort, Uint: 3}, {Field: wfp.RemotePort, Uint: 4}}, boot, wfp.Permit)
					add("baseline/icmp-echo-reply", layer, []wfp.Condition{{Field: wfp.Protocol, Uint: 1}, {Field: wfp.LocalPort, Uint: 0}}, boot, wfp.Permit)
				} else {
					for _, typ := range []uint32{2, 129, 130, 131, 132, 133, 134, 135, 136, 137} {
						add("baseline/icmpv6", layer, []wfp.Condition{{Field: wfp.Protocol, Uint: 58}, {Field: wfp.LocalPort, Uint: typ}}, boot, wfp.Permit)
					}
				}
				add("block-all", layer, nil, boot, wfp.Block)
			}
		}
		resolvers := make([]ScopedResolver, 0, len(baseline.Resolvers)+len(baseline.ScopedResolvers))
		for _, scoped := range baseline.ScopedResolvers {
			if scoped.Interface != 0 {
				resolvers = append(resolvers, scoped)
			}
		}
		for _, addr := range baseline.Resolvers {
			// A scoped address without an interface cannot be permitted safely.
			if (addr.Is6() && addr.IsLinkLocalUnicast()) || addr.Zone() != "" {
				continue
			}
			resolvers = append(resolvers, ScopedResolver{Address: addr})
		}
		for _, configured := range resolvers {
			resolver := configured.Address.Unmap().WithZone("")
			if !resolver.IsValid() || resolver.IsUnspecified() || resolver.IsMulticast() {
				continue
			}
			layer := windowsLayers(resolver.Is4())[0] // DNS clients only; replies are stateful.
			for _, proto := range []uint32{6, 17} {
				conditions := []wfp.Condition{
					{Field: wfp.RemoteAddress, Address: netip.PrefixFrom(resolver, resolver.BitLen())},
					{Field: wfp.RemotePort, Uint: 53}, {Field: wfp.Protocol, Uint: proto},
				}
				if configured.Interface != 0 {
					conditions = append(conditions, wfp.Condition{Field: wfp.LocalInterface, Uint64: configured.Interface})
				}
				add("baseline/dns/"+resolver.String(), layer, conditions, boot, wfp.Permit)
			}
		}
	}
	rules := make([]wfp.Filter, 0, len(byKey))
	for _, f := range byKey {
		rules = append(rules, f)
	}
	sort.Slice(rules, func(i, j int) bool { return rules[i].Key.String() < rules[j].Key.String() })
	return rules
}

func windowsLayers(v4 bool) []wfp.Layer {
	if v4 {
		return []wfp.Layer{wfp.ALEConnectV4, wfp.ALERecvAcceptV4}
	}
	return []wfp.Layer{wfp.ALEConnectV6, wfp.ALERecvAcceptV6}
}

func windowsProtocols(proto string) []uint32 {
	switch proto {
	case ProtoTCP:
		return []uint32{6}
	case ProtoUDP:
		return []uint32{17}
	case ProtoUDPTCP:
		return []uint32{6, 17}
	default:
		return nil
	}
}

// Paths from Windows are case-insensitive. Normalize without filepath.Clean,
// whose path-separator behavior depends on the OS running the portable tests.
func canonicalWindowsPaths(paths []string) []string {
	set := map[string]bool{}
	for _, path := range paths {
		if path != "" {
			set[strings.ToLower(strings.ReplaceAll(path, "/", `\`))] = true
		}
	}
	result := make([]string, 0, len(set))
	for path := range set {
		result = append(result, path)
	}
	slices.Sort(result)
	return result
}

// Boot-time policy stops enforcing when BFE starts. Permit that read-only
// status on boot rules, but reject disabled persistent policy and any changed
// predicates. The caller still returns the unmodified engine-state digest.
func validateWindowsReadback(requested []wfp.Filter, installed []wfp.FilterInfo) error {
	observed := make([]wfp.Filter, len(installed))
	for n, info := range installed {
		observed[n] = info.Filter
		if observed[n].BootTime {
			observed[n].Disabled = false
		}
	}
	if wfp.Digest(observed) != wfp.Digest(requested) {
		return errors.New("WFP isolation readback differs from requested policy")
	}
	return nil
}
