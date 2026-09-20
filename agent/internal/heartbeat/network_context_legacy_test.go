package heartbeat

import (
	nc "github.com/breeze-rmm/agent/internal/collectors/networkcontext"
	"testing"
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
