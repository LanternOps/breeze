package netattach

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"reflect"
	"strings"
	"testing"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/breeze-rmm/agent/internal/collectors/networkcontext"
)

const testContextKey = "test:ctx"

type upShape int

const (
	upUnix          upShape = iota // AdminState up, OperState unknown (Linux, macOS)
	upWindows                      // OperState up (Windows)
	down                           // both down
	operDownAdminUp                // OperState down, AdminState up
)

// fixture builds a fake networkcontext.Reader plus the other deps seams.
type fixture struct {
	t        *testing.T
	ifaces   []networkcontext.InterfaceRow
	routes   []networkcontext.RouteRow
	neigh    []networkcontext.NeighborRow
	bridgedK map[string]bool
	resolved map[string][]netip.Addr
	server   *networkcontext.RouteSelection
	fails    map[string]error
	partial  map[string]bool // a failing section still returns its rows
	calls    map[string]int
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	return &fixture{t: t, bridgedK: map[string]bool{}, resolved: map[string][]netip.Addr{}, fails: map[string]error{}, partial: map[string]bool{}, calls: map[string]int{}}
}

func (f *fixture) iface(key, name, kind string, up upShape, cidrs ...string) *fixture {
	row := networkcontext.InterfaceRow{RowKey: key, InterfaceKey: key, OSIndex: uint32(len(f.ifaces) + 1), Name: name, Kind: kind, Addresses: []networkcontext.AddressRow{}}
	switch up {
	case upUnix:
		row.AdminState, row.OperState = "up", "unknown"
	case upWindows:
		row.AdminState, row.OperState = "unknown", "up"
	case down:
		row.AdminState, row.OperState = "down", "down"
	case operDownAdminUp:
		row.AdminState, row.OperState = "up", "down"
	}
	for _, cidr := range cidrs {
		p := netip.MustParsePrefix(cidr)
		row.Addresses = append(row.Addresses, networkcontext.AddressRow{Address: p.Addr().String(), PrefixLength: uint8(p.Bits()), Family: networkcontext.Family(p.Addr()), State: "preferred", Assignment: "dhcp"})
	}
	f.ifaces = append(f.ifaces, row)
	return f
}

func (f *fixture) route(key, gateway string) *fixture {
	return f.rawRoute(networkcontext.RouteRow{Family: "ipv4", DestinationPrefix: "0.0.0.0/0", InterfaceKey: new(key), TableKey: "254", RouteType: "unicast",
		NextHops: []networkcontext.NextHop{{Address: new(gateway), InterfaceKey: new(key)}}})
}

func (f *fixture) rawRoute(r networkcontext.RouteRow) *fixture {
	f.routes = append(f.routes, r)
	return f
}

func (f *fixture) neighRow(key, address, mac, state string) *fixture {
	row := networkcontext.NeighborRow{RowKey: key + ":" + address, Address: address, Family: "ipv4", InterfaceKey: key, State: state}
	if mac != "" {
		row.MAC = new(mac)
	}
	f.neigh = append(f.neigh, row)
	return f
}

func (f *fixture) bridged(keys ...string) *fixture {
	for _, k := range keys {
		f.bridgedK[k] = true
	}
	return f
}

// serverVia resolves breeze.example to 203.0.113.20 and routes it out of key
// through nextHop ("" = on-link, no next hop).
func (f *fixture) serverVia(key, nextHop string) *fixture {
	f.resolved["breeze.example"] = []netip.Addr{netip.MustParseAddr("203.0.113.20")}
	sel := networkcontext.RouteSelection{ContextKey: testContextKey, InterfaceKey: key, Attribution: "observed"}
	if nextHop != "" {
		sel.NextHop = new(nextHop)
	}
	f.server = &sel
	return f
}

func (f *fixture) resolveTo(host string, addrs ...string) *fixture {
	f.resolved[host] = nil
	for _, a := range addrs {
		f.resolved[host] = append(f.resolved[host], netip.MustParseAddr(a))
	}
	return f
}

// fail makes a section return err ("contexts", "interfaces", "routes",
// "neighbors", "lookup", "resolve", "bridged"), with no rows.
func (f *fixture) fail(section string, err error) *fixture {
	f.fails[section] = err
	return f
}

// failPartial makes a section return its rows and err, as the Linux reader does.
func (f *fixture) failPartial(section string, err error) *fixture {
	f.partial[section] = true
	return f.fail(section, err)
}

type fakeReader struct{ f *fixture }

func (r fakeReader) section(name string) error {
	r.f.calls[name]++
	return r.f.fails[name]
}
func (r fakeReader) Contexts(context.Context) (networkcontext.Manifest, error) {
	if e := r.section("contexts"); e != nil {
		return networkcontext.Manifest{}, e
	}
	return networkcontext.Manifest{Outcome: networkcontext.Complete, Contexts: []networkcontext.Context{{ContextKey: testContextKey, Families: []string{"ipv4", "ipv6"}}}}, nil
}
func (r fakeReader) Capabilities() []networkcontext.Capability { return nil }
func (r fakeReader) Interfaces(_ context.Context, c networkcontext.Context) (networkcontext.Section[networkcontext.InterfaceRow], error) {
	r.checkScope(c)
	if e := r.section("interfaces"); e != nil && !r.f.partial["interfaces"] {
		return networkcontext.Section[networkcontext.InterfaceRow]{}, e
	}
	return networkcontext.Section[networkcontext.InterfaceRow]{Rows: append([]networkcontext.InterfaceRow{}, r.f.ifaces...)}, r.f.fails["interfaces"]
}
func (r fakeReader) Routes(_ context.Context, c networkcontext.Context) (networkcontext.Section[networkcontext.RouteRow], error) {
	r.checkScope(c)
	if e := r.section("routes"); e != nil && !r.f.partial["routes"] {
		return networkcontext.Section[networkcontext.RouteRow]{}, e
	}
	return networkcontext.Section[networkcontext.RouteRow]{Rows: append([]networkcontext.RouteRow{}, r.f.routes...)}, r.f.fails["routes"]
}
func (r fakeReader) Rules(context.Context, networkcontext.Context) (networkcontext.Section[networkcontext.RuleRow], error) {
	r.f.t.Error("Rules must not be read")
	return networkcontext.Section[networkcontext.RuleRow]{}, networkcontext.ErrUnsupported
}
func (r fakeReader) Resolvers(context.Context, networkcontext.Context) (networkcontext.ResolverSection, error) {
	r.f.t.Error("Resolvers must not be read")
	return networkcontext.ResolverSection{}, networkcontext.ErrUnsupported
}
func (r fakeReader) Neighbors(_ context.Context, c networkcontext.Context) (networkcontext.Section[networkcontext.NeighborRow], error) {
	r.checkScope(c)
	if e := r.section("neighbors"); e != nil && !r.f.partial["neighbors"] {
		return networkcontext.Section[networkcontext.NeighborRow]{}, e
	}
	return networkcontext.Section[networkcontext.NeighborRow]{Rows: append([]networkcontext.NeighborRow{}, r.f.neigh...)}, r.f.fails["neighbors"]
}
func (r fakeReader) checkScope(c networkcontext.Context) {
	if c.ContextKey != testContextKey || !reflect.DeepEqual(c.Families, []string{"ipv4"}) {
		r.f.t.Errorf("read scope = %+v, want context %q families [ipv4]", c, testContextKey)
	}
}

func (f *fixture) deps() deps {
	return deps{
		reader: fakeReader{f},
		lookup: func(_ context.Context, req networkcontext.RouteLookupRequest) (networkcontext.RouteSelection, error) {
			f.calls["lookup"]++
			if e := f.fails["lookup"]; e != nil {
				return networkcontext.RouteSelection{}, e
			}
			if req.ContextKey != testContextKey || req.Source.IsValid() || req.InterfaceKey != "" {
				f.t.Errorf("lookup request = %+v", req)
			}
			if f.server == nil || req.Destination != netip.MustParseAddr("203.0.113.20") {
				return networkcontext.RouteSelection{}, errors.New("network is unreachable")
			}
			return *f.server, nil
		},
		resolve: func(_ context.Context, host string) ([]netip.Addr, error) {
			f.calls["resolve"]++
			if e := f.fails["resolve"]; e != nil {
				return nil, e
			}
			return f.resolved[host], nil
		},
		bridged: func(_ context.Context, rows []networkcontext.InterfaceRow) (map[string]bool, error) {
			f.calls["bridged"]++
			for _, row := range rows {
				if row.Kind != "bridge" && row.Kind != "virtual" {
					f.t.Errorf("bridged asked about a %q row", row.Kind)
				}
			}
			if e := f.fails["bridged"]; e != nil {
				return nil, e
			}
			out := map[string]bool{}
			for _, row := range rows {
				out[row.InterfaceKey] = f.bridgedK[row.InterfaceKey]
			}
			return out, nil
		},
	}
}

func mustMAC(t *testing.T, s string) net.HardwareAddr {
	t.Helper()
	mac, err := net.ParseMAC(s)
	if err != nil {
		t.Fatal(err)
	}
	return mac
}

func att(t *testing.T, name string, index uint32, local string, gateway, mac string, primary bool) Attachment {
	t.Helper()
	p := netip.MustParsePrefix(local)
	a := Attachment{InterfaceName: name, InterfaceIndex: index, LocalAddress: p.Addr(), PrefixLength: uint8(p.Bits()), GatewayAddress: netip.MustParseAddr(gateway), Primary: primary}
	if mac != "" {
		a.GatewayMAC = mustMAC(t, mac)
	}
	return a
}

func check(t *testing.T, d deps, host string, want []Attachment, wantComplete, wantErr bool) {
	t.Helper()
	got, complete, err := current(context.Background(), d, host)
	if (err != nil) != wantErr || complete != wantComplete || !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v complete=%v err=%v\nwant %+v complete=%v err?=%v", got, complete, err, want, wantComplete, wantErr)
	}
}

func TestCurrent_BridgedUplinkIsReported(t *testing.T) {
	for _, tc := range []struct{ name, iface, kind string }{
		{"hyper-v external switch", "vEthernet (External)", "virtual"},
		{"linux bridge with a physical port", "br0", "bridge"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := newFixture(t).iface("k1", tc.iface, tc.kind, upWindows, "192.168.1.57/24").
				route("k1", "192.168.1.1").neighRow("k1", "192.168.1.1", "a4:2b:b0:11:22:9c", "reachable").
				bridged("k1").serverVia("k1", "192.168.1.1").deps()
			got, complete, err := current(context.Background(), d, "breeze.example")
			want := []Attachment{{InterfaceName: tc.iface, InterfaceIndex: 1,
				LocalAddress: netip.MustParseAddr("192.168.1.57"), PrefixLength: 24,
				GatewayAddress: netip.MustParseAddr("192.168.1.1"),
				GatewayMAC:     mustMAC(t, "a4:2b:b0:11:22:9c"), Primary: true}}
			if err != nil || !complete || !reflect.DeepEqual(got, want) {
				t.Fatalf("got %+v complete=%v err=%v", got, complete, err)
			}
		})
	}
}

func TestCurrent_NatSwitchIsSkipped(t *testing.T) {
	for _, tc := range []struct{ name, iface, kind string }{
		{"hyper-v internal or NAT switch", "vEthernet (Default Switch)", "virtual"},
		{"tap-style VPN adapter", "Ethernet 3", "virtual"},
		{"container veth behind a NAT bridge", "eth0", "virtual"},
		{"linux bridge with only tap or veth ports", "virbr0", "bridge"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := newFixture(t).iface("k1", tc.iface, tc.kind, upUnix, "10.1.2.57/24").
				route("k1", "10.1.2.100").neighRow("k1", "10.1.2.100", "3c:37:86:aa:bb:10", "reachable").
				serverVia("k1", "10.1.2.100").deps() // not bridged
			got, complete, err := current(context.Background(), d, "breeze.example")
			if err != nil || !complete || len(got) != 0 {
				t.Fatalf("got %+v complete=%v err=%v; want empty, complete", got, complete, err)
			}
		})
	}
}

func twoRoutes(t *testing.T) *fixture {
	return newFixture(t).
		iface("k1", "Ethernet", "ethernet", upWindows, "192.168.1.57/24").route("k1", "192.168.1.1").
		neighRow("k1", "192.168.1.1", "a4:2b:b0:11:22:9c", "reachable").
		iface("k2", "Wi-Fi", "wifi", upWindows, "10.1.2.57/24").route("k2", "10.1.2.100").
		neighRow("k2", "10.1.2.100", "3c:37:86:aa:bb:10", "stale")
}

func TestCurrent_TwoDefaultRoutes(t *testing.T) {
	t.Run("ethernet and wi-fi", func(t *testing.T) {
		d := twoRoutes(t).serverVia("k2", "10.1.2.100").deps()
		got, complete, err := current(context.Background(), d, "breeze.example")
		// one per LAN route; the server route decides primary, not the metric; primary sorts first
		if err != nil || !complete || len(got) != 2 ||
			got[0].InterfaceName != "Wi-Fi" || !got[0].Primary || got[0].GatewayMAC.String() != "3c:37:86:aa:bb:10" ||
			got[1].InterfaceName != "Ethernet" || got[1].Primary || got[1].GatewayMAC.String() != "a4:2b:b0:11:22:9c" {
			t.Fatalf("got %+v complete=%v err=%v", got, complete, err)
		}
	})
	t.Run("office LAN under a full-tunnel VPN", func(t *testing.T) {
		d := newFixture(t).
			iface("k1", "Ethernet", "ethernet", upWindows, "192.168.1.57/24").route("k1", "192.168.1.1").
			neighRow("k1", "192.168.1.1", "a4:2b:b0:11:22:9c", "reachable").
			iface("k2", "utun4", "tunnel", upUnix, "10.1.2.57/32").route("k2", "10.1.2.100").
			serverVia("k2", "10.1.2.100").deps()
		check(t, d, "breeze.example", []Attachment{att(t, "Ethernet", 1, "192.168.1.57/24", "192.168.1.1", "a4:2b:b0:11:22:9c", false)}, true, false)
	})
	t.Run("same interface listed twice is one attachment", func(t *testing.T) {
		d := newFixture(t).
			iface("k1", "en0", "unknown", upUnix, "192.168.1.57/24").route("k1", "192.168.1.1").route("k1", "192.168.1.1").
			serverVia("k1", "192.168.1.1").deps()
		check(t, d, "breeze.example", []Attachment{att(t, "en0", 1, "192.168.1.57/24", "192.168.1.1", "", true)}, true, false)
	})
	t.Run("multipath hops each name their interface", func(t *testing.T) {
		d := newFixture(t).
			iface("k1", "eth0", "ethernet", upUnix, "192.168.1.57/24").
			iface("k2", "eth1", "ethernet", upUnix, "10.1.2.57/24").
			rawRoute(networkcontext.RouteRow{Family: "ipv4", DestinationPrefix: "0.0.0.0/0", TableKey: "254", RouteType: "unicast", NextHops: []networkcontext.NextHop{
				{Address: new("192.168.1.1"), InterfaceKey: new("k1")},
				{Address: new("10.1.2.100"), InterfaceKey: new("k2")},
				{InterfaceKey: new("k2")}, // no address: not a candidate
			}}).
			serverVia("k1", "192.168.1.1").deps()
		check(t, d, "breeze.example", []Attachment{
			att(t, "eth0", 1, "192.168.1.57/24", "192.168.1.1", "", true),
			att(t, "eth1", 2, "10.1.2.57/24", "10.1.2.100", "", false),
		}, true, false)
	})
	t.Run("on-link server route marks the interface's only attachment", func(t *testing.T) {
		d := twoRoutes(t).serverVia("k1", "").deps()
		got, complete, err := current(context.Background(), d, "breeze.example")
		if err != nil || !complete || len(got) != 2 || got[0].InterfaceName != "Ethernet" || !got[0].Primary || got[1].Primary {
			t.Fatalf("got %+v complete=%v err=%v", got, complete, err)
		}
	})
	t.Run("server next hop that matches no attachment marks nothing", func(t *testing.T) {
		d := twoRoutes(t).serverVia("k1", "192.168.1.254").deps()
		got, _, err := current(context.Background(), d, "breeze.example")
		if err != nil || len(got) != 2 || got[0].Primary || got[1].Primary {
			t.Fatalf("got %+v err=%v", got, err)
		}
	})
}

func TestCurrent_TunnelAndLoopbackExcluded(t *testing.T) {
	for _, tc := range []struct {
		name string
		f    func(*fixture) *fixture
	}{
		{"tunnel row with a default route", func(f *fixture) *fixture {
			return f.iface("k1", "wg0", "tunnel", upUnix, "10.1.2.57/24").route("k1", "10.1.2.100").serverVia("k1", "10.1.2.100")
		}},
		{"loopback local address and gateway", func(f *fixture) *fixture {
			return f.iface("k1", "lo-ish", "other", upUnix, "127.0.0.1/8").route("k1", "127.0.0.1")
		}},
		{"loopback local address, LAN gateway", func(f *fixture) *fixture {
			return f.iface("k1", "lo-ish", "other", upUnix, "127.0.0.1/8").route("k1", "192.168.1.1")
		}},
		{"default route on a key with no interface row", func(f *fixture) *fixture {
			return f.iface("k1", "eth0", "ethernet", upUnix, "192.168.1.57/24").route("k9", "192.168.1.1")
		}},
		{"down ethernet row", func(f *fixture) *fixture {
			return f.iface("k1", "eth0", "ethernet", down, "192.168.1.57/24").route("k1", "192.168.1.1")
		}},
		{"blackhole default and a local-table default", func(f *fixture) *fixture {
			return f.iface("k1", "eth0", "ethernet", upUnix, "192.168.1.57/24").
				rawRoute(networkcontext.RouteRow{Family: "ipv4", DestinationPrefix: "0.0.0.0/0", InterfaceKey: new("k1"), TableKey: "254", RouteType: "blackhole", NextHops: []networkcontext.NextHop{{Address: new("192.168.1.1"), InterfaceKey: new("k1")}}}).
				rawRoute(networkcontext.RouteRow{Family: "ipv4", DestinationPrefix: "0.0.0.0/0", InterfaceKey: new("k1"), TableKey: "255", RouteType: "unicast", NextHops: []networkcontext.NextHop{{Address: new("192.168.1.1"), InterfaceKey: new("k1")}}})
		}},
		{"non-default and IPv6 routes", func(f *fixture) *fixture {
			return f.iface("k1", "eth0", "ethernet", upUnix, "192.168.1.57/24").
				rawRoute(networkcontext.RouteRow{Family: "ipv4", DestinationPrefix: "10.0.0.0/8", InterfaceKey: new("k1"), TableKey: "254", RouteType: "unicast", NextHops: []networkcontext.NextHop{{Address: new("192.168.1.1"), InterfaceKey: new("k1")}}}).
				rawRoute(networkcontext.RouteRow{Family: "ipv6", DestinationPrefix: "::/0", InterfaceKey: new("k1"), TableKey: "254", RouteType: "unicast", NextHops: []networkcontext.NextHop{{Address: new("2001:db8::1"), InterfaceKey: new("k1")}}})
		}},
		{"link-local, multicast and unspecified gateways", func(f *fixture) *fixture {
			return f.iface("k1", "eth0", "ethernet", upUnix, "192.168.1.57/24", "169.254.7.7/16").
				route("k1", "169.254.1.1").route("k1", "224.0.0.1").route("k1", "0.0.0.0").route("k1", "not-an-ip")
		}},
		{"interface with only a link-local address", func(f *fixture) *fixture {
			return f.iface("k1", "eth0", "ethernet", upUnix, "169.254.7.7/16").route("k1", "192.168.1.1")
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			check(t, tc.f(newFixture(t)).deps(), "breeze.example", nil, true, false)
		})
	}
}

func TestCurrent_ReportableKinds(t *testing.T) {
	for _, tc := range []struct {
		kind    string
		bridged bool
		want    bool
	}{
		{"ethernet", false, true}, {"wifi", false, true}, {"cellular", false, true}, {"other", false, true}, {"unknown", false, true},
		{"tunnel", false, false}, {"tunnel", true, false},
		{"bridge", false, false}, {"bridge", true, true},
		{"virtual", false, false}, {"virtual", true, true},
	} {
		t.Run(fmt.Sprintf("%s bridged=%v", tc.kind, tc.bridged), func(t *testing.T) {
			f := newFixture(t).iface("k1", "if-a", tc.kind, upUnix, "192.168.1.57/24").route("k1", "192.168.1.1")
			if tc.bridged {
				f.bridged("k1")
			}
			var want []Attachment
			if tc.want {
				want = []Attachment{att(t, "if-a", 1, "192.168.1.57/24", "192.168.1.1", "", false)}
			}
			check(t, f.deps(), "", want, true, false)
		})
	}
}

func TestCurrent_UpPredicate(t *testing.T) {
	for _, tc := range []struct {
		name string
		up   upShape
		want bool
	}{
		{"unix admin up, oper unknown", upUnix, true},
		{"windows oper up", upWindows, true},
		{"down", down, false},
		{"oper down, admin up", operDownAdminUp, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := newFixture(t).iface("k1", "eth0", "ethernet", tc.up, "192.168.1.57/24").route("k1", "192.168.1.1").deps()
			var want []Attachment
			if tc.want {
				want = []Attachment{att(t, "eth0", 1, "192.168.1.57/24", "192.168.1.1", "", false)}
			}
			check(t, d, "", want, true, false)
		})
	}
}

func TestCurrent_MissingNeighbourGivesNilMAC(t *testing.T) {
	for _, tc := range []struct {
		name    string
		f       func(*fixture) *fixture
		wantMAC string
	}{
		{"no neighbour row", func(f *fixture) *fixture { return f }, ""},
		{"incomplete, no MAC", func(f *fixture) *fixture { return f.neighRow("k1", "192.168.1.1", "", "incomplete") }, ""},
		{"failed with a MAC", func(f *fixture) *fixture {
			return f.neighRow("k1", "192.168.1.1", "a4:2b:b0:11:22:9c", "failed")
		}, ""},
		{"right MAC on another interface key", func(f *fixture) *fixture {
			return f.neighRow("k2", "192.168.1.1", "a4:2b:b0:11:22:9c", "reachable")
		}, ""},
		{"malformed MAC", func(f *fixture) *fixture { return f.neighRow("k1", "192.168.1.1", "zz:zz", "reachable") }, ""},
		{"permanent with a MAC", func(f *fixture) *fixture {
			return f.neighRow("k1", "192.168.1.1", "a4:2b:b0:11:22:9c", "permanent")
		}, "a4:2b:b0:11:22:9c"},
		{"stale with a MAC", func(f *fixture) *fixture {
			return f.neighRow("k1", "192.168.1.1", "A4:2B:B0:11:22:9C", "stale")
		}, "a4:2b:b0:11:22:9c"},
		{"macOS unknown state with a MAC", func(f *fixture) *fixture {
			return f.neighRow("k1", "192.168.1.1", "a4:2b:b0:11:22:9c", "unknown")
		}, "a4:2b:b0:11:22:9c"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t).iface("k1", "eth0", "ethernet", upUnix, "192.168.1.57/24").route("k1", "192.168.1.1")
			check(t, tc.f(f).deps(), "", []Attachment{att(t, "eth0", 1, "192.168.1.57/24", "192.168.1.1", tc.wantMAC, false)}, true, false)
		})
	}
}

// A MAC no gateway can have is "no entry": otherwise every device behind the
// same gateway address would report the same placeholder fingerprint.
func TestCurrent_NonGatewayMACIsNil(t *testing.T) {
	for _, tc := range []struct {
		name, mac, want string
	}{
		{"macOS unprivileged placeholder", "02:00:00:00:00:00", ""},
		{"all zero", "00:00:00:00:00:00", ""},
		{"broadcast", "ff:ff:ff:ff:ff:ff", ""},
		{"multicast (group bit set)", "01:00:5e:00:00:01", ""},
		{"normal unicast is kept", "a4:2b:b0:11:22:9c", "a4:2b:b0:11:22:9c"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := newFixture(t).iface("k1", "eth0", "ethernet", upUnix, "192.168.1.57/24").route("k1", "192.168.1.1").
				neighRow("k1", "192.168.1.1", tc.mac, "reachable").deps()
			check(t, d, "", []Attachment{att(t, "eth0", 1, "192.168.1.57/24", "192.168.1.1", tc.want, false)}, true, false)
		})
	}
}

func TestCurrent_LocalAddressChoice(t *testing.T) {
	d := newFixture(t).
		iface("k1", "eth0", "ethernet", upUnix, "10.1.2.57/24", "192.168.1.57/24").route("k1", "192.168.1.1").
		iface("k2", "eth1", "ethernet", upUnix, "169.254.3.3/16", "198.51.100.9/24", "10.1.2.60/24", "2001:db8::5/64").route("k2", "203.0.113.1").
		deps()
	check(t, d, "", []Attachment{
		att(t, "eth0", 1, "192.168.1.57/24", "192.168.1.1", "", false),
		att(t, "eth1", 2, "10.1.2.60/24", "203.0.113.1", "", false),
	}, true, false)
}

func TestCurrent_ReadFailureIsIncomplete(t *testing.T) {
	boom := errors.New("boom")
	t.Run("neighbors", func(t *testing.T) {
		d := twoRoutes(t).serverVia("k2", "10.1.2.100").fail("neighbors", boom).deps()
		check(t, d, "breeze.example", []Attachment{
			att(t, "Wi-Fi", 2, "10.1.2.57/24", "10.1.2.100", "", true),
			att(t, "Ethernet", 1, "192.168.1.57/24", "192.168.1.1", "", false),
		}, false, true)
	})
	for _, section := range []string{"lookup", "resolve"} {
		t.Run(section, func(t *testing.T) {
			d := twoRoutes(t).serverVia("k2", "10.1.2.100").fail(section, boom).deps()
			check(t, d, "breeze.example", []Attachment{
				att(t, "Ethernet", 1, "192.168.1.57/24", "192.168.1.1", "a4:2b:b0:11:22:9c", false),
				att(t, "Wi-Fi", 2, "10.1.2.57/24", "10.1.2.100", "3c:37:86:aa:bb:10", false),
			}, false, true)
		})
	}
	t.Run("bridged", func(t *testing.T) {
		d := newFixture(t).
			iface("k1", "br0", "bridge", upUnix, "10.1.2.57/24").route("k1", "10.1.2.100").bridged("k1").
			iface("k2", "eth1", "ethernet", upUnix, "192.168.1.57/24").route("k2", "192.168.1.1").
			fail("bridged", boom).deps()
		check(t, d, "", []Attachment{att(t, "eth1", 2, "192.168.1.57/24", "192.168.1.1", "", false)}, false, true)
	})
	for _, section := range []string{"routes", "interfaces", "contexts"} {
		t.Run(section, func(t *testing.T) {
			d := twoRoutes(t).serverVia("k2", "10.1.2.100").fail(section, boom).deps()
			check(t, d, "breeze.example", nil, false, true)
		})
	}
	t.Run("interfaces with partial rows keeps them", func(t *testing.T) {
		d := twoRoutes(t).serverVia("k2", "10.1.2.100").failPartial("interfaces", boom).deps()
		got, complete, err := current(context.Background(), d, "breeze.example")
		if !errors.Is(err, boom) || complete || len(got) != 2 || !got[0].Primary {
			t.Fatalf("got %+v complete=%v err=%v", got, complete, err)
		}
	})
	t.Run("routes and neighbors with partial rows both reported", func(t *testing.T) {
		other := errors.New("other")
		d := twoRoutes(t).serverVia("k2", "10.1.2.100").failPartial("routes", boom).failPartial("neighbors", other).deps()
		got, complete, err := current(context.Background(), d, "breeze.example")
		if !errors.Is(err, boom) || !errors.Is(err, other) || complete || len(got) != 2 || got[0].GatewayMAC == nil {
			t.Fatalf("got %+v complete=%v err=%v", got, complete, err)
		}
	})
	t.Run("no contexts", func(t *testing.T) {
		f := twoRoutes(t)
		d := f.deps()
		d.reader = emptyContexts{fakeReader{f}}
		check(t, d, "", nil, false, true)
	})
}

type emptyContexts struct{ fakeReader }

func (emptyContexts) Contexts(context.Context) (networkcontext.Manifest, error) {
	return networkcontext.Manifest{Outcome: networkcontext.Complete}, nil
}

func TestCurrent_ServerWithoutIPv4(t *testing.T) {
	f := twoRoutes(t).serverVia("k2", "10.1.2.100").resolveTo("breeze.example", "2001:db8::20")
	check(t, f.deps(), "breeze.example", []Attachment{
		att(t, "Ethernet", 1, "192.168.1.57/24", "192.168.1.1", "a4:2b:b0:11:22:9c", false),
		att(t, "Wi-Fi", 2, "10.1.2.57/24", "10.1.2.100", "3c:37:86:aa:bb:10", false),
	}, true, false)
	if f.calls["lookup"] != 0 {
		t.Fatalf("lookup called %d times with no IPv4 server address", f.calls["lookup"])
	}
}

func TestCurrent_ServerHostLiteral(t *testing.T) {
	t.Run("IPv4 literal is used without the resolver", func(t *testing.T) {
		f := twoRoutes(t).serverVia("k2", "10.1.2.100").fail("resolve", errors.New("must not resolve"))
		got, complete, err := current(context.Background(), f.deps(), "203.0.113.20")
		if err != nil || !complete || len(got) != 2 || !got[0].Primary || got[0].InterfaceName != "Wi-Fi" || f.calls["resolve"] != 0 {
			t.Fatalf("got %+v complete=%v err=%v resolve calls=%d", got, complete, err, f.calls["resolve"])
		}
	})
	t.Run("IPv6 literal marks nothing and adds no error", func(t *testing.T) {
		f := twoRoutes(t).serverVia("k2", "10.1.2.100").fail("resolve", errors.New("must not resolve"))
		got, complete, err := current(context.Background(), f.deps(), "2001:db8::20")
		if err != nil || !complete || len(got) != 2 || got[0].Primary || got[1].Primary || f.calls["resolve"]+f.calls["lookup"] != 0 {
			t.Fatalf("got %+v complete=%v err=%v calls=%v", got, complete, err, f.calls)
		}
	})
}

func TestCurrent_EmptyServerHost(t *testing.T) {
	e := errors.New("must not be called")
	f := twoRoutes(t).serverVia("k2", "10.1.2.100").fail("resolve", e).fail("lookup", e)
	check(t, f.deps(), "", []Attachment{
		att(t, "Ethernet", 1, "192.168.1.57/24", "192.168.1.1", "a4:2b:b0:11:22:9c", false),
		att(t, "Wi-Fi", 2, "10.1.2.57/24", "10.1.2.100", "3c:37:86:aa:bb:10", false),
	}, true, false)
}

// With nothing to mark, the server is neither resolved nor looked up, so an
// unreachable server cannot make an empty list incomplete.
func TestCurrent_NoCandidatesSkipsServerLookup(t *testing.T) {
	e := errors.New("must not be called")
	f := newFixture(t).iface("k1", "wg0", "tunnel", upUnix, "10.1.2.57/24").route("k1", "10.1.2.100").
		serverVia("k1", "10.1.2.100").fail("resolve", e).fail("lookup", e)
	check(t, f.deps(), "breeze.example", nil, true, false)
	if f.calls["resolve"]+f.calls["lookup"] != 0 {
		t.Fatalf("calls = %v", f.calls)
	}
}

func TestCurrent_NoBridgeRowsSkipsUplinkRead(t *testing.T) {
	f := twoRoutes(t).fail("bridged", errors.New("must not be called"))
	got, complete, err := current(context.Background(), f.deps(), "")
	if err != nil || !complete || len(got) != 2 || f.calls["bridged"] != 0 {
		t.Fatalf("got %+v complete=%v err=%v calls=%v", got, complete, err, f.calls)
	}
}

func TestCurrent_CutToEight(t *testing.T) {
	f := newFixture(t)
	for i := range 10 {
		key := fmt.Sprintf("k%d", i)
		f.iface(key, fmt.Sprintf("eth%d", i), "ethernet", upUnix, fmt.Sprintf("192.168.1.%d/24", 50+i)).route(key, "192.168.1.1")
	}
	f.serverVia("k9", "192.168.1.1")
	want := []Attachment{att(t, "eth9", 10, "192.168.1.59/24", "192.168.1.1", "", true)}
	for i := range 7 {
		want = append(want, att(t, fmt.Sprintf("eth%d", i), uint32(i+1), fmt.Sprintf("192.168.1.%d/24", 50+i), "192.168.1.1", "", false))
	}
	check(t, f.deps(), "breeze.example", want, false, false)
	if MaxAttachments != 8 {
		t.Fatalf("MaxAttachments = %d", MaxAttachments)
	}
}

func TestCurrent_OrderByNameThenGateway(t *testing.T) {
	d := newFixture(t).
		iface("k1", "b", "ethernet", upUnix, "192.168.1.57/24", "10.1.2.57/24").route("k1", "192.168.1.1").route("k1", "10.1.2.100").
		iface("k2", "a", "ethernet", upUnix, "192.168.1.58/24").route("k2", "192.168.1.1").
		deps()
	check(t, d, "", []Attachment{
		att(t, "a", 2, "192.168.1.58/24", "192.168.1.1", "", false),
		att(t, "b", 1, "10.1.2.57/24", "10.1.2.100", "", false),
		att(t, "b", 1, "192.168.1.57/24", "192.168.1.1", "", false),
	}, true, false)
}

func TestCurrent_NameIsCapped(t *testing.T) {
	long := strings.Repeat("é", 130)
	emoji := strings.Repeat("😀", 70)
	d := newFixture(t).
		iface("k1", long, "ethernet", upUnix, "192.168.1.57/24").route("k1", "192.168.1.1").
		iface("k2", emoji, "ethernet", upUnix, "192.168.1.58/24").route("k2", "192.168.1.1").
		iface("k3", "", "ethernet", upUnix, "192.168.1.59/24").route("k3", "192.168.1.1").
		deps()
	got, complete, err := current(context.Background(), d, "")
	if err != nil || !complete || len(got) != 3 {
		t.Fatalf("got %+v complete=%v err=%v", got, complete, err)
	}
	names := map[uint32]string{}
	for _, a := range got {
		names[a.InterfaceIndex] = a.InterfaceName
	}
	if names[1] != strings.Repeat("é", 128) {
		t.Errorf("é name = %d runes", utf8.RuneCountInString(names[1]))
	}
	if names[2] != strings.Repeat("😀", 64) || len(utf16.Encode([]rune(names[2]))) != 128 {
		t.Errorf("emoji name = %d runes", utf8.RuneCountInString(names[2]))
	}
	if names[3] != "if3" {
		t.Errorf("empty name = %q, want if3", names[3])
	}
}

func TestCurrent_UnparseableServerNextHopIsIncomplete(t *testing.T) {
	d := twoRoutes(t).serverVia("k2", "not-an-ip").deps()
	got, complete, err := current(context.Background(), d, "breeze.example")
	if err == nil || complete || len(got) != 2 || got[0].Primary || got[1].Primary {
		t.Fatalf("got %+v complete=%v err=%v; want both, none primary, incomplete", got, complete, err)
	}
}
