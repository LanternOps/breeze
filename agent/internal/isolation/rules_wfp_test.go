package isolation

import (
	"bytes"
	"encoding/json"
	"flag"
	"net/netip"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/isolation/wfp"
)

var updateWFPGolden = flag.Bool("update-wfp-golden", false, "regenerate testdata/windows_rules.json")

func windowsRuleFixture() (ResolvedSpec, []string, Baseline) {
	return ResolvedSpec{Entries: []ResolvedEntry{
		{AllowEntry: AllowEntry{Kind: KindHost, Host: "control.example.test", Proto: ProtoUDPTCP, Ports: []uint16{443, 8443}, Scope: ScopeBreeze}, Addrs: []netip.Prefix{netip.MustParsePrefix("192.0.2.10/32"), netip.MustParsePrefix("2001:db8::10/128")}},
		{AllowEntry: AllowEntry{Kind: KindHost, Host: "relay.example.test", Proto: ProtoTCP, Ports: []uint16{3128}, Scope: ScopeBreeze}, Addrs: []netip.Prefix{netip.MustParsePrefix("198.51.100.10/32")}, Proxy: true},
		{AllowEntry: AllowEntry{Kind: KindCIDR, CIDR: "203.0.113.0/24", Proto: ProtoUDP, Ports: []uint16{443}, Scope: ScopeAny}, Addrs: []netip.Prefix{netip.MustParsePrefix("203.0.113.0/24")}},
	}}, []string{`C:\Program Files\Breeze\breeze-agent.exe`}, Baseline{Resolvers: []netip.Addr{netip.MustParseAddr("192.0.2.53"), netip.MustParseAddr("2001:db8::53")}}
}

// Regenerate after reviewing semantic assertions with:
// go test ./internal/isolation -run TestWindowsRulesGolden -update-wfp-golden
func TestWindowsRulesGolden(t *testing.T) {
	rs, bins, baseline := windowsRuleFixture()
	rules := buildWindowsRules(rs, bins, nil, baseline)
	var buf bytes.Buffer
	buf.WriteString("[\n")
	for i, f := range rules {
		b, err := json.Marshal(f)
		if err != nil {
			t.Fatal(err)
		}
		buf.WriteString("  ")
		buf.Write(b)
		if i < len(rules)-1 {
			buf.WriteByte(',')
		}
		buf.WriteByte('\n')
	}
	buf.WriteString("]\n")
	path := "testdata/windows_rules.json"
	if *updateWFPGolden {
		if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(want, buf.Bytes()) {
		t.Fatal("Windows rules differ from golden; review then regenerate with -update-wfp-golden")
	}
}

func conditionOf(f wfp.Filter, field wfp.ConditionField) (wfp.Condition, bool) {
	for _, c := range f.Conditions {
		if c.Field == field {
			return c, true
		}
	}
	return wfp.Condition{}, false
}

func TestWindowsRulesSafetyInvariants(t *testing.T) {
	rs, bins, baseline := windowsRuleFixture()
	rules := buildWindowsRules(rs, bins, nil, baseline)
	keys := map[wfp.GUID]bool{}
	appCount, anyCount, bootCount, blocks := 0, 0, 0, 0
	for _, f := range rules {
		if err := f.Validate(); err != nil {
			t.Fatalf("%s: %v", f.Name, err)
		}
		if keys[f.Key] {
			t.Fatalf("duplicate key: %v", f.Key)
		}
		keys[f.Key] = true
		if f.Sublayer != wfp.SublayerKey {
			t.Fatalf("foreign sublayer: %s", f.Name)
		}
		_, app := conditionOf(f, wfp.AppID)
		addr, dest := conditionOf(f, wfp.RemoteAddress)
		_, port := conditionOf(f, wfp.RemotePort)
		_, proto := conditionOf(f, wfp.Protocol)
		if app {
			appCount++
			if !dest || !port || !proto || !f.Persistent || f.BootTime {
				t.Fatalf("unscoped app permit: %+v", f)
			}
		}
		if dest && (addr.Address.Addr().Is4() != strings.HasSuffix(string(f.Layer), "v4")) {
			t.Fatalf("wrong address family: %+v", f)
		}
		if f.BootTime {
			bootCount++
			if app || f.Persistent {
				t.Fatalf("invalid boot filter: %+v", f)
			}
		}
		if f.Action == wfp.Block {
			blocks++
			if len(f.Conditions) != 0 {
				t.Fatal("block-all has conditions")
			}
			if f.Weight >= windowsPermitWeight {
				t.Fatal("block outweighs permit")
			}
		}
		if strings.HasPrefix(f.Name, "allow/") && !app {
			anyCount++
			if !dest || !port || !proto || addr.Address.String() != "203.0.113.0/24" {
				t.Fatalf("Breeze destination-only escape: %+v", f)
			}
		}
	}
	// Two protocols × two ports × two families × both ALE layers, plus proxy.
	if appCount != 18 || anyCount != 2 || blocks != 8 || bootCount == 0 {
		t.Fatalf("app=%d any=%d blocks=%d boot=%d", appCount, anyCount, blocks, bootCount)
	}
	if wfp.SublayerWeight != 0xffff {
		t.Fatal("sublayer must use the maximum weight")
	}
	// W4a is the first server producer of scope:any; absent an explicit entry
	// the builder must never invent a destination-only policy permit.
	rs.Entries = rs.Entries[:2]
	for _, f := range buildWindowsRules(rs, bins, nil, baseline) {
		if strings.HasPrefix(f.Name, "allow/") {
			if _, ok := conditionOf(f, wfp.AppID); !ok {
				t.Fatalf("unscoped Breeze permit: %s", f.Name)
			}
		}
	}
}

func TestWindowsBaseline(t *testing.T) {
	_, _, baseline := windowsRuleFixture()
	rules := buildWindowsRules(ResolvedSpec{}, nil, nil, baseline)
	for _, boot := range []bool{false, true} {
		loopback, dhcp, dns, icmp4, icmp6 := 0, 0, 0, 0, 0
		v6types := map[uint32]int{}
		for _, f := range rules {
			if f.BootTime != boot || f.Action != wfp.Permit {
				continue
			}
			if flag, ok := conditionOf(f, wfp.Flags); ok {
				loopback++
				if flag.Uint != 1 || flag.Match != wfp.MatchFlagsAllSet {
					t.Fatalf("loopback must test IS_LOOPBACK: %+v", flag)
				}
				continue
			}
			p, ok := conditionOf(f, wfp.Protocol)
			if !ok {
				t.Fatalf("unrestricted baseline: %+v", f)
			}
			local, hasLocal := conditionOf(f, wfp.LocalPort)
			remote, hasRemote := conditionOf(f, wfp.RemotePort)
			switch p.Uint {
			case 1:
				if !hasLocal {
					t.Fatal("ICMPv4 missing type")
				}
				if local.Uint == 3 {
					icmp4++
					if !hasRemote || remote.Uint != 4 {
						t.Fatal("ICMPv4 must restrict code to 4")
					}
				} else if local.Uint != 0 {
					t.Fatalf("unexpected ICMPv4 type %d", local.Uint)
				}
			case 58:
				if !hasLocal {
					t.Fatal("ICMPv6 missing type")
				}
				icmp6++
				v6types[local.Uint]++
				if local.Uint != 2 && (local.Uint < 129 || local.Uint > 137) {
					t.Fatalf("unexpected ICMPv6 type %d", local.Uint)
				}
			case 6, 17:
				if hasRemote && remote.Uint == 53 {
					dns++
					addr, ok := conditionOf(f, wfp.RemoteAddress)
					if !ok || !slices.Contains(baseline.Resolvers, addr.Address.Addr()) || !strings.Contains(string(f.Layer), "connect") {
						t.Fatalf("unrestricted DNS: %+v", f)
					}
				} else {
					dhcp++
					if p.Uint != 17 || !hasLocal || !hasRemote {
						t.Fatalf("invalid DHCP: %+v", f)
					}
					if !((local.Uint == 68 && remote.Uint == 67) || (local.Uint == 67 && remote.Uint == 68) || (local.Uint == 546 && remote.Uint == 547) || (local.Uint == 547 && remote.Uint == 546)) {
						t.Fatalf("invalid DHCP port pair: %+v", f)
					}
				}
			default:
				t.Fatalf("unexpected baseline protocol %d", p.Uint)
			}
		}
		if loopback != 4 || dhcp != 8 || dns != 4 || icmp4 != 2 || icmp6 != 20 {
			t.Fatalf("boot=%v loopback=%d dhcp=%d dns=%d icmp4=%d icmp6=%d", boot, loopback, dhcp, dns, icmp4, icmp6)
		}
		for _, typ := range []uint32{2, 130, 131, 132, 133, 134, 135, 136, 137} {
			if v6types[typ] != 2 {
				t.Fatalf("type %d missing one direction", typ)
			}
		}
	}
	for _, f := range buildWindowsRules(ResolvedSpec{}, nil, nil, Baseline{}) {
		if strings.Contains(f.Name, "dns/") {
			t.Fatal("DNS with no configured resolver")
		}
	}
}

func TestWindowsRulesDeterminismAndUpgrade(t *testing.T) {
	rs, bins, baseline := windowsRuleFixture()
	want := buildWindowsRules(rs, bins, nil, baseline)
	slices.Reverse(rs.Entries)
	slices.Reverse(rs.Entries[2].Ports)
	slices.Reverse(rs.Entries[2].Addrs)
	slices.Reverse(baseline.Resolvers)
	rs.Entries = append(rs.Entries, rs.Entries[0])
	if got := buildWindowsRules(rs, append(bins, bins...), nil, baseline); !reflect.DeepEqual(got, want) {
		t.Fatal("ordering or duplicate inputs changed rules")
	}
	countApps := func(fs []wfp.Filter) int {
		n := 0
		for _, f := range fs {
			if _, ok := conditionOf(f, wfp.AppID); ok {
				n++
			}
		}
		return n
	}
	withOld := buildWindowsRules(rs, bins, []string{`C:\Program Files\Breeze-old\breeze-agent.exe`}, baseline)
	if countApps(withOld) != countApps(want)*2 {
		t.Fatal("upgrade must retain both binary paths")
	}
	if len(buildWindowsRules(ResolvedSpec{}, nil, nil, Baseline{})) == 0 {
		t.Fatal("empty specification must still have baseline and block-all")
	}
}

func TestWindowsReadbackAllowsOnlyBootDeactivation(t *testing.T) {
	rules := buildWindowsRules(ResolvedSpec{}, nil, nil, Baseline{})
	installed := make([]wfp.FilterInfo, len(rules))
	for n, f := range rules {
		installed[n] = wfp.FilterInfo{Filter: f, ID: uint64(n + 1)}
		installed[n].Disabled = f.BootTime
	}
	if err := validateWindowsReadback(rules, installed); err != nil {
		t.Fatalf("boot-time deactivation is expected after BFE starts: %v", err)
	}
	for n := range installed {
		if installed[n].Persistent {
			installed[n].Disabled = true
			break
		}
	}
	if err := validateWindowsReadback(rules, installed); err == nil {
		t.Fatal("disabled runtime enforcement accepted")
	}
	if err := validateWindowsReadback(rules, installed[:len(installed)-1]); err == nil {
		t.Fatal("missing filter accepted")
	}
}

func TestWindowsScopedDNSStaysOnConfiguredInterface(t *testing.T) {
	resolver := netip.MustParseAddr("2001:db8::53")
	baseline := Baseline{ScopedResolvers: []ScopedResolver{{Address: resolver, Interface: 0x123456789}}}
	count := 0
	for _, f := range buildWindowsRules(ResolvedSpec{}, nil, nil, baseline) {
		if !strings.HasPrefix(f.Name, "baseline/dns/") {
			continue
		}
		count++
		address, ok := conditionOf(f, wfp.RemoteAddress)
		if !ok || address.Address.Addr() != resolver {
			t.Fatal("lost resolver address")
		}
		iface, ok := conditionOf(f, wfp.LocalInterface)
		if !ok || iface.Uint64 != 0x123456789 {
			t.Fatalf("lost resolver interface: %+v", f)
		}
	}
	if count != 4 {
		t.Fatalf("expected TCP/UDP persistent and boot DNS rules, got %d", count)
	}
	baseline.ScopedResolvers[0].Interface = 0
	for _, f := range buildWindowsRules(ResolvedSpec{}, nil, nil, baseline) {
		if strings.HasPrefix(f.Name, "baseline/dns/") {
			t.Fatal("unknown interface became unrestricted DNS permit")
		}
	}
}
