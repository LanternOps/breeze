package heartbeat

import (
	"reflect"
	"strconv"
	"testing"
	"time"

	nc "github.com/breeze-rmm/agent/internal/collectors/networkcontext"
)

func TestNetworkContextLegacyGatewayRequiresUnambiguousCompleteScope(t *testing.T) {
	iface, gateway, table := "if-a", "192.0.2.1", "254"
	snapshot := nc.Snapshot{ContextManifest: nc.Manifest{Outcome: nc.Complete, Contexts: []nc.Context{{ContextKey: "ctx"}}},
		Interfaces: []nc.Section[nc.InterfaceRow]{{Outcome: nc.Complete, Rows: []nc.InterfaceRow{{Name: "eth0", InterfaceKey: iface}}}},
		Routes:     []nc.Section[nc.RouteRow]{{Outcome: nc.Complete, AddressFamily: "ipv4", Rows: []nc.RouteRow{{DestinationPrefix: "0.0.0.0/0", TableKey: table, NextHops: []nc.NextHop{{InterfaceKey: &iface, Address: &gateway}}}}}},
		Rules:      []nc.Section[nc.RuleRow]{{Outcome: nc.Complete, AddressFamily: "ipv4", Rows: []nc.RuleRow{{Action: "lookup", TableKey: &table, SelectorCoverage: "complete"}}}}}
	if got := unambiguousLegacyGateway(snapshot, "eth0", "ipv4"); got != gateway {
		t.Fatal(got)
	}
	snapshot.Routes[0].Rows = append(snapshot.Routes[0].Rows, snapshot.Routes[0].Rows[0])
	if got := unambiguousLegacyGateway(snapshot, "eth0", "ipv4"); got != "" {
		t.Fatal("ambiguous", got)
	}
	snapshot.Routes[0].Rows = snapshot.Routes[0].Rows[:1]
	snapshot.Routes[0].Outcome = nc.Partial
	if got := unambiguousLegacyGateway(snapshot, "eth0", "ipv4"); got != "" {
		t.Fatal("incomplete", got)
	}
}

func strPtr(s string) *string { return &s }

// resolverFixtureSnapshot mirrors what the Windows ip_helper reader emits:
// every resolver row is scoped to the adapter it was configured on.
func resolverFixtureSnapshot() nc.Snapshot {
	return nc.Snapshot{ContextManifest: nc.Manifest{Outcome: nc.Complete, Contexts: []nc.Context{{ContextKey: "ctx"}}},
		Interfaces: []nc.Section[nc.InterfaceRow]{{Outcome: nc.Complete, Rows: []nc.InterfaceRow{
			{Name: "Ethernet", InterfaceKey: "if-eth0"},
			{Name: "Wi-Fi", InterfaceKey: "if-wifi"},
		}}},
		Resolvers: []nc.Section[nc.ResolverRow]{{Outcome: nc.Complete, Rows: []nc.ResolverRow{
			{Address: "10.0.0.53", InterfaceKey: strPtr("if-eth0"), Mechanism: "ip_helper"},
			{Address: "10.0.0.54", InterfaceKey: strPtr("if-eth0"), Mechanism: "ip_helper"},
			{Address: "192.168.1.1", InterfaceKey: strPtr("if-wifi"), Mechanism: "ip_helper"},
		}}},
	}
}

func TestLegacyResolverAddresses(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*nc.Snapshot)
		iface  string
		want   []string
	}{
		{name: "scoped resolvers only for their adapter, OS order kept", iface: "Ethernet", want: []string{"10.0.0.53", "10.0.0.54"}},
		{name: "other adapter gets its own resolvers", iface: "Wi-Fi", want: []string{"192.168.1.1"}},
		{name: "adapter with no resolvers reports empty, not unknown", iface: "Ethernet",
			mutate: func(s *nc.Snapshot) { s.Resolvers[0].Rows = s.Resolvers[0].Rows[2:] }, want: []string{}},
		{name: "unscoped resolv.conf resolvers apply to every adapter despite Partial outcome", iface: "Wi-Fi",
			mutate: func(s *nc.Snapshot) {
				s.Resolvers[0] = nc.Section[nc.ResolverRow]{Outcome: nc.Partial, ReasonCode: "split_dns_unavailable", Rows: []nc.ResolverRow{
					{Address: "127.0.0.53", IsLocalStub: true, Mechanism: "resolv_conf"},
					{Address: "1.1.1.1", Mechanism: "resolv_conf"},
				}}
			}, want: []string{"127.0.0.53", "1.1.1.1"}},
		{name: "scoped and global mixed in OS order", iface: "Ethernet",
			mutate: func(s *nc.Snapshot) {
				s.Resolvers[0].Rows = append([]nc.ResolverRow{{Address: "9.9.9.9"}}, s.Resolvers[0].Rows...)
			}, want: []string{"9.9.9.9", "10.0.0.53", "10.0.0.54"}},
		{name: "duplicates removed", iface: "Ethernet",
			mutate: func(s *nc.Snapshot) {
				s.Resolvers[0].Rows = append(s.Resolvers[0].Rows, nc.ResolverRow{Address: "10.0.0.53"})
			}, want: []string{"10.0.0.53", "10.0.0.54"}},
		{name: "windows fec0:0:0:ffff placeholders are not resolvers", iface: "Ethernet",
			mutate: func(s *nc.Snapshot) {
				s.Resolvers[0].Rows = []nc.ResolverRow{
					{Address: "fec0:0:0:ffff::1", InterfaceKey: strPtr("if-eth0")},
					{Address: "fec0:0:0:ffff::2", InterfaceKey: strPtr("if-eth0")},
					{Address: "fec0:0:0:ffff::3", InterfaceKey: strPtr("if-eth0")},
				}
			}, want: []string{}},
		{name: "capped at 8 (API schema max)", iface: "Ethernet",
			mutate: func(s *nc.Snapshot) {
				rows := []nc.ResolverRow{}
				for i := 1; i <= 10; i++ {
					rows = append(rows, nc.ResolverRow{Address: "10.1.0." + strconv.Itoa(i), InterfaceKey: strPtr("if-eth0")})
				}
				s.Resolvers[0].Rows = rows
			}, want: []string{"10.1.0.1", "10.1.0.2", "10.1.0.3", "10.1.0.4", "10.1.0.5", "10.1.0.6", "10.1.0.7", "10.1.0.8"}},
		{name: "failed resolver read is unknown", iface: "Ethernet",
			mutate: func(s *nc.Snapshot) {
				s.Resolvers[0] = nc.Section[nc.ResolverRow]{Outcome: nc.Failed, ReasonCode: "resolver_read_failed", Rows: []nc.ResolverRow{}}
			}, want: nil},
		{name: "missing resolver section is unknown", iface: "Ethernet",
			mutate: func(s *nc.Snapshot) { s.Resolvers = nil }, want: nil},
		{name: "adapter absent from snapshot is unknown", iface: "eth9", want: nil},
		{name: "ambiguous adapter name is unknown", iface: "Ethernet",
			mutate: func(s *nc.Snapshot) {
				s.Interfaces[0].Rows = append(s.Interfaces[0].Rows, nc.InterfaceRow{Name: "Ethernet", InterfaceKey: "if-other"})
			}, want: nil},
		{name: "multiple contexts are unknown", iface: "Ethernet",
			mutate: func(s *nc.Snapshot) {
				s.ContextManifest.Contexts = append(s.ContextManifest.Contexts, nc.Context{ContextKey: "ns2"})
			}, want: nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			snapshot := resolverFixtureSnapshot()
			if tt.mutate != nil {
				tt.mutate(&snapshot)
			}
			got := legacyResolverAddresses(snapshot, tt.iface)
			if (got == nil) != (tt.want == nil) {
				t.Fatalf("nil mismatch: got %#v, want %#v", got, tt.want)
			}
			if len(got) != 0 || len(tt.want) != 0 {
				if !reflect.DeepEqual(got, tt.want) {
					t.Fatalf("got %v, want %v", got, tt.want)
				}
			}
		})
	}
}

func TestLegacyContextDNSServersHonorsManagerState(t *testing.T) {
	snapshot := resolverFixtureSnapshot()
	h := &Heartbeat{}
	if got := h.legacyContextDNSServers("Ethernet"); got != nil {
		t.Fatalf("no manager: got %v, want nil", got)
	}

	manager := &networkContextManager{enabled: true, latestSnapshot: &snapshot, captured: time.Now()}
	h.networkContext = manager
	if got := h.legacyContextDNSServers("Ethernet"); !reflect.DeepEqual(got, []string{"10.0.0.53", "10.0.0.54"}) {
		t.Fatalf("fresh snapshot: got %v", got)
	}

	manager.captured = time.Now().Add(-11 * time.Minute)
	if got := h.legacyContextDNSServers("Ethernet"); got != nil {
		t.Fatalf("stale snapshot: got %v, want nil", got)
	}

	manager.captured = time.Now()
	manager.enabled = false
	if got := h.legacyContextDNSServers("Ethernet"); got != nil {
		t.Fatalf("disabled manager: got %v, want nil", got)
	}
}
