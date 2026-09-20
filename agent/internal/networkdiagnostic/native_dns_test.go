package networkdiagnostic

import (
	"context"
	"errors"
	nc "github.com/breeze-rmm/agent/internal/collectors/networkcontext"
	"golang.org/x/net/dns/dnsmessage"
	"net/netip"
	"testing"
)

type dnsTestReader struct{ nc.Reader }

func (dnsTestReader) LookupRoute(_ context.Context, r nc.RouteLookupRequest) (nc.RouteSelection, error) {
	return nc.RouteSelection{ContextKey: "ctx", InterfaceKey: "if1", SourceAddress: "192.0.2.10", Attribution: "observed"}, nil
}
func (dnsTestReader) Interfaces(context.Context, nc.Context) (nc.Section[nc.InterfaceRow], error) {
	return nc.Section[nc.InterfaceRow]{Outcome: nc.Complete, Rows: []nc.InterfaceRow{{InterfaceKey: "if1", OSIndex: 1}}}, nil
}
func TestNativeDNSAttributesActualSuccessfulResolver(t *testing.T) {
	n := NativeIO{Reader: dnsTestReader{}, Origin: Origin{ContextKey: "ctx", InterfaceKey: ptr("if1")}}
	calls := 0
	n.queryDNSOverride = func(_ context.Context, _ dnsmessage.Name, _ dnsmessage.Type, resolver nc.ResolverRow, _ nc.RouteSelection) ([]netip.Addr, error) {
		calls++
		if resolver.Address == "192.0.2.53" {
			return nil, errors.New("timeout")
		}
		return []netip.Addr{netip.MustParseAddr("192.0.2.20")}, nil
	}
	result, err := n.Resolve(context.Background(), "status.example.test", "A", []nc.ResolverRow{{Address: "192.0.2.53", Port: 53}, {Address: "192.0.2.54", Port: 53}}, nc.RouteSelection{}, 0)
	if err != nil || calls != 2 || result.Resolver.Address != "192.0.2.54" || result.Route.Attribution != "observed" || result.Route.SourceAddress != "192.0.2.10" {
		t.Fatal(result, err, calls)
	}
}
