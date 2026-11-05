//go:build linux

package isolation

import (
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/isolation/cgroup"
)

func nftFixture() (ResolvedSpec, cgroup.Layout, Baseline) {
	spec := ResolvedSpec{
		IsolationID: "11111111-2222-4333-8444-000000000001",
		Generation:  1,
		RemoteRelay: true,
		Entries: []ResolvedEntry{
			{
				AllowEntry: AllowEntry{Kind: KindHost, Host: "control.example.test", Proto: ProtoTCP, Ports: []uint16{443}, Scope: ScopeBreeze},
				Addrs:      []netip.Prefix{netip.MustParsePrefix("192.0.2.10/32"), netip.MustParsePrefix("2001:db8::10/128")},
			},
			{
				AllowEntry: AllowEntry{Kind: KindHost, Host: "relay.example.test", Proto: ProtoUDPTCP, Ports: []uint16{5349, 3478}, Scope: ScopeBreeze},
				Addrs:      []netip.Prefix{netip.MustParsePrefix("198.51.100.5/32")},
			},
			{
				AllowEntry: AllowEntry{Kind: KindCIDR, CIDR: "203.0.113.0/24", Proto: ProtoTCP, Ports: []uint16{443}, Scope: ScopeAny},
				Addrs:      []netip.Prefix{netip.MustParsePrefix("203.0.113.0/24")},
			},
			{
				// The transport's effective proxy: Breeze processes only.
				AllowEntry: AllowEntry{Kind: KindHost, Host: "proxy.example.test", Proto: ProtoTCP, Ports: []uint16{3128}, Scope: ScopeBreeze},
				Addrs:      []netip.Prefix{netip.MustParsePrefix("203.0.113.7/32")},
				Proxy:      true,
			},
		},
	}
	layout := cgroup.Layout{
		AgentPath:    "system.slice/breeze-agent.service/agent",
		ChildrenPath: "system.slice/breeze-agent.service/children",
		Level:        3,
	}
	baseline := Baseline{Resolvers: []netip.Addr{
		netip.MustParseAddr("192.0.2.53"),
		netip.MustParseAddr("2001:db8::53"),
	}}
	return spec, layout, baseline
}

func compareGolden(t *testing.T, name, got string) {
	t.Helper()
	path := filepath.Join("testdata", name)
	if os.Getenv("UPDATE_GOLDEN") == "1" {
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	if got != string(want) {
		t.Fatalf("%s differs.\n--- got\n%s\n--- want\n%s", name, got, want)
	}
}

func TestNftRulesetGolden(t *testing.T) {
	spec, layout, baseline := nftFixture()
	compareGolden(t, "nft_ruleset.golden", buildNftRuleset(spec, layout, baseline))
}

func TestNftBootRulesetGolden(t *testing.T) {
	spec, _, baseline := nftFixture()
	compareGolden(t, "nft_boot_ruleset.golden", buildNftBootRuleset(spec, baseline))
}

func nftLines(ruleset string) []string {
	var out []string
	for _, line := range strings.Split(ruleset, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			out = append(out, line)
		}
	}
	return out
}

func TestNftRulesetStructure(t *testing.T) {
	spec, layout, baseline := nftFixture()
	ruleset := buildNftRuleset(spec, layout, baseline)
	if !strings.HasPrefix(ruleset, "table inet breeze_isolation {") {
		t.Fatalf("ruleset must be one inet table:\n%s", ruleset)
	}
	for _, hook := range []string{"input", "output", "forward"} {
		want := "type filter hook " + hook + " priority filter - 10; policy drop;"
		if !strings.Contains(ruleset, want) {
			t.Errorf("missing base chain %q", want)
		}
	}
	permit := `socket cgroupv2 level 3 "system.slice/breeze-agent.service/agent"`
	established := "ct state established,related ct mark 0x42424242 accept"
	if strings.Count(ruleset, established) != 2 {
		t.Errorf("want the marked established rule in input and output:\n%s", ruleset)
	}
	for _, line := range nftLines(ruleset) {
		// No blanket established accept: every ct-state rule needs our mark.
		if strings.Contains(line, "ct state") && !strings.Contains(line, "ct mark 0x42424242") {
			t.Errorf("blanket established rule: %q", line)
		}
		// A Breeze destination never gets a destination-only permit.
		for _, dest := range []string{"192.0.2.10", "2001:db8::10", "198.51.100.5", "203.0.113.7"} {
			if strings.Contains(line, dest) && !strings.HasPrefix(line, permit) {
				t.Errorf("destination-only permit for a scope:breeze address: %q", line)
			}
		}
		// Children's cgroup never appears in a permit.
		if strings.Contains(line, "children") {
			t.Errorf("permit names the children cgroup: %q", line)
		}
		// A permitted flow must carry the mark its return traffic needs.
		if strings.HasPrefix(line, permit) && !strings.HasSuffix(line, "ct mark set 0x42424242 accept") {
			t.Errorf("permit does not mark its flow: %q", line)
		}
		if strings.Contains(line, "reject") {
			t.Errorf("drop, never reject: %q", line)
		}
	}
	// scope:any is destination-only.
	if !strings.Contains(ruleset, "\t\tip daddr { 203.0.113.0/24 } tcp dport { 443 } ct mark set 0x42424242 accept\n") {
		t.Errorf("scope:any permit missing:\n%s", ruleset)
	}
	// The drop that attributes the negative probe is on output only: inbound
	// noise must not look like an observed drop.
	if strings.Count(ruleset, `counter name "breeze_drop" drop`) != 1 ||
		!strings.Contains(chainBody(t, ruleset, "output"), `counter name "breeze_drop" drop`) {
		t.Errorf("breeze_drop must count exactly the output chain's final drop:\n%s", ruleset)
	}
	if !strings.Contains(ruleset, "counter breeze_drop {") {
		t.Error("named counter missing")
	}
	// DNS only to the configured resolvers, on any process (the host resolver
	// answers on the agent's behalf).
	out := chainBody(t, ruleset, "output")
	for _, want := range []string{
		"ip daddr { 192.0.2.53 } udp dport 53 ct mark set 0x42424242 accept",
		"ip daddr { 192.0.2.53 } tcp dport 53 ct mark set 0x42424242 accept",
		"ip6 daddr { 2001:db8::53 } udp dport 53 ct mark set 0x42424242 accept",
		"ip6 daddr { 2001:db8::53 } tcp dport 53 ct mark set 0x42424242 accept",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output chain lacks %q", want)
		}
	}
	if strings.Contains(chainBody(t, ruleset, "forward"), "accept") {
		t.Errorf("forwarded traffic must all drop:\n%s", ruleset)
	}
}

func chainBody(t *testing.T, ruleset, name string) string {
	t.Helper()
	start := strings.Index(ruleset, "chain "+name+" {")
	if start < 0 {
		t.Fatalf("no chain %s", name)
	}
	end := strings.Index(ruleset[start:], "\n\t}")
	return ruleset[start : start+end]
}

// Boot rules load before the agent's cgroup exists, so they cannot carry the
// process-scoped permit, and a destination-only copy would hand Breeze's
// addresses to every process.
func TestNftBootRulesetHasNoBreezePermits(t *testing.T) {
	spec, _, baseline := nftFixture()
	ruleset := buildNftBootRuleset(spec, baseline)
	if strings.Contains(ruleset, "socket cgroupv2") {
		t.Errorf("boot rules name a cgroup that does not exist yet:\n%s", ruleset)
	}
	for _, dest := range []string{"192.0.2.10", "2001:db8::10", "198.51.100.5", "203.0.113.7"} {
		if strings.Contains(ruleset, dest) {
			t.Errorf("boot rules permit scope:breeze address %s:\n%s", dest, ruleset)
		}
	}
	if !strings.Contains(ruleset, "203.0.113.0/24") {
		t.Errorf("boot rules must keep the scope:any permit:\n%s", ruleset)
	}
	if !strings.Contains(ruleset, `counter name "breeze_drop" drop`) || !strings.Contains(ruleset, "policy drop;") {
		t.Errorf("boot rules must still drop everything else:\n%s", ruleset)
	}
}

func TestNftRulesetSkipsUnusableInput(t *testing.T) {
	spec, layout, _ := nftFixture()
	spec.Entries = []ResolvedEntry{
		{AllowEntry: AllowEntry{Proto: ProtoTCP, Ports: []uint16{0, 443}, Scope: ScopeBreeze}, Addrs: []netip.Prefix{netip.MustParsePrefix("192.0.2.10/32"), {}}},
		{AllowEntry: AllowEntry{Proto: ProtoTCP, Ports: []uint16{443}, Scope: "bogus"}, Addrs: []netip.Prefix{netip.MustParsePrefix("192.0.2.11/32")}},
		{AllowEntry: AllowEntry{Proto: "bogus", Ports: []uint16{443}, Scope: ScopeBreeze}, Addrs: []netip.Prefix{netip.MustParsePrefix("192.0.2.12/32")}},
		{AllowEntry: AllowEntry{Proto: ProtoTCP, Ports: []uint16{443}, Scope: ScopeBreeze}, Addrs: []netip.Prefix{netip.PrefixFrom(netip.MustParseAddr("::ffff:192.0.2.13"), 128)}},
	}
	baseline := Baseline{
		Resolvers: []netip.Addr{
			netip.MustParseAddr("127.0.0.53"), netip.MustParseAddr("::1"), netip.MustParseAddr("0.0.0.0"),
			netip.MustParseAddr("224.0.0.1"), netip.MustParseAddr("fe80::1"), netip.MustParseAddr("fe80::2%eth0"),
		},
		ScopedResolvers: []ScopedResolver{{Address: netip.MustParseAddr("fe80::3"), Interface: 7}},
	}
	ruleset := buildNftRuleset(spec, layout, baseline)
	for _, bad := range []string{"192.0.2.11", "192.0.2.12", "192.0.2.13", "dport { 0", "127.0.0.53", "::1 ", "0.0.0.0", "224.0.0.1", "fe80::"} {
		if strings.Contains(ruleset, bad) {
			t.Errorf("ruleset contains %q:\n%s", bad, ruleset)
		}
	}
	if !strings.Contains(ruleset, "ip daddr { 192.0.2.10 } tcp dport { 443 }") {
		t.Errorf("the usable permit was lost:\n%s", ruleset)
	}
}

func TestNftRulesetIsDeterministic(t *testing.T) {
	spec, layout, baseline := nftFixture()
	first := buildNftRuleset(spec, layout, baseline)
	// Reversed input order renders identically.
	for i, j := 0, len(spec.Entries)-1; i < j; i, j = i+1, j-1 {
		spec.Entries[i], spec.Entries[j] = spec.Entries[j], spec.Entries[i]
	}
	baseline.Resolvers[0], baseline.Resolvers[1] = baseline.Resolvers[1], baseline.Resolvers[0]
	if second := buildNftRuleset(spec, layout, baseline); first != second {
		t.Fatalf("not deterministic:\n%s\n---\n%s", first, second)
	}
}

func TestParseResolvConf(t *testing.T) {
	got := parseResolvConf(`# comment
search example.test
nameserver 192.0.2.53
nameserver   2001:db8::53
nameserver fe80::1%eth0
nameserver not-an-address
options edns0
`)
	want := []string{"192.0.2.53", "2001:db8::53", "fe80::1%eth0"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i].String() != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}
