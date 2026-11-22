// Package netattach reports the networks this device is attached to: one entry
// per IPv4 default route on an up LAN interface, with the gateway's MAC from
// the neighbour cache (learned networks, #12369).
//
// It reads OS tables only (netlink, the routing socket, iphlpapi) through its
// own networkcontext reader, and resolves the server host through the system
// resolver. It never sends a packet to the LAN, and it does not depend on the
// network-context manager or its snapshot.
package netattach

import (
	"cmp"
	"context"
	"errors"
	"net"
	"net/netip"
	"slices"
	"strconv"

	"github.com/breeze-rmm/agent/internal/collectors/networkcontext"
)

// MaxAttachments caps one report (spec §6).
const MaxAttachments = 8

// maxNameUnits caps InterfaceName in both runes and UTF-16 code units.
const maxNameUnits = 128

// Attachment is one IPv4 default route on an up, reportable interface.
type Attachment struct {
	InterfaceName  string
	InterfaceIndex uint32
	LocalAddress   netip.Addr
	PrefixLength   uint8
	GatewayAddress netip.Addr
	GatewayMAC     net.HardwareAddr // nil when the neighbour cache has no usable entry
	Primary        bool
}

// deps is the seam between the attachment rules and the OS.
type deps struct {
	reader  networkcontext.Reader
	lookup  func(context.Context, networkcontext.RouteLookupRequest) (networkcontext.RouteSelection, error)
	resolve func(ctx context.Context, host string) ([]netip.Addr, error)
	// bridged reports, by InterfaceKey, which bridge or virtual rows have a physical uplink (K2).
	bridged func(context.Context, []networkcontext.InterfaceRow) (map[string]bool, error)
}

var errNoContext = errors.New("netattach: no network context")

// Current returns one Attachment per IPv4 default route on an up, reportable
// interface. complete is false when any read failed or the list was cut to
// MaxAttachments. An empty serverHost marks nothing primary and adds no error.
func Current(ctx context.Context, serverHost string) (attachments []Attachment, complete bool, err error) {
	return current(ctx, osDeps(), serverHost)
}

type candidate struct {
	row     networkcontext.InterfaceRow
	gateway netip.Addr
}

// entry is an Attachment plus the interface key it was read under, which the
// server route selection names.
type entry struct {
	Attachment
	key string
}

func current(ctx context.Context, d deps, serverHost string) ([]Attachment, bool, error) {
	var errs []error
	manifest, err := d.reader.Contexts(ctx)
	if err == nil && len(manifest.Contexts) == 0 {
		err = errNoContext
	}
	if err != nil {
		return nil, false, err
	}
	scope := networkcontext.Context{ContextKey: manifest.Contexts[0].ContextKey, Families: []string{"ipv4"}}

	// A reader may return the rows it could read beside an error (the Linux
	// reader joins per-row failures); keep them, and mark the list incomplete.
	interfaces, err := d.reader.Interfaces(ctx, scope)
	if err != nil {
		if len(interfaces.Rows) == 0 {
			return nil, false, err
		}
		errs = append(errs, err)
	}
	routes, err := d.reader.Routes(ctx, scope)
	if err != nil {
		if len(routes.Rows) == 0 {
			return nil, false, errors.Join(append(errs, err)...)
		}
		errs = append(errs, err)
	}
	neighbors, err := d.reader.Neighbors(ctx, scope)
	if err != nil {
		errs = append(errs, err)
	}

	byKey := map[string]networkcontext.InterfaceRow{}
	var bridgeRows []networkcontext.InterfaceRow
	for _, row := range interfaces.Rows {
		if _, dup := byKey[row.InterfaceKey]; dup || row.InterfaceKey == "" {
			continue
		}
		byKey[row.InterfaceKey] = row
		if row.Kind == "bridge" || row.Kind == "virtual" {
			bridgeRows = append(bridgeRows, row)
		}
	}
	bridged := map[string]bool{}
	if len(bridgeRows) > 0 {
		m, err := d.bridged(ctx, bridgeRows)
		if err != nil {
			errs = append(errs, err)
		}
		for k, v := range m {
			bridged[k] = v
		}
	}

	var out []entry
	seen := map[string]bool{}
	for _, c := range defaultRouteCandidates(routes.Rows, byKey) {
		dedupe := c.row.InterfaceKey + "\x00" + c.gateway.String()
		if seen[dedupe] || !isUp(c.row) || !reportableKind(c.row, bridged) {
			continue
		}
		seen[dedupe] = true
		local, ok := localAddress(c.row, c.gateway)
		if !ok {
			continue
		}
		name := c.row.Name
		if name == "" {
			name = "if" + strconv.FormatUint(uint64(c.row.OSIndex), 10)
		}
		out = append(out, entry{key: c.row.InterfaceKey, Attachment: Attachment{
			InterfaceName:  capName(name),
			InterfaceIndex: c.row.OSIndex,
			LocalAddress:   local.Addr(),
			PrefixLength:   uint8(local.Bits()),
			GatewayAddress: c.gateway,
			GatewayMAC:     gatewayMAC(neighbors.Rows, c.row.InterfaceKey, c.gateway),
		}})
	}

	// Nothing to mark means no reason to resolve the server or ask for its
	// route: an unreachable server must not make an empty list incomplete.
	if serverHost != "" && len(out) > 0 {
		if err := markPrimary(ctx, d, scope.ContextKey, serverHost, out); err != nil {
			errs = append(errs, err)
		}
	}

	slices.SortStableFunc(out, func(a, b entry) int {
		if a.Primary != b.Primary {
			if a.Primary {
				return -1
			}
			return 1
		}
		return cmp.Or(cmp.Compare(a.InterfaceName, b.InterfaceName), a.GatewayAddress.Compare(b.GatewayAddress))
	})
	cut := len(out) > MaxAttachments
	if cut {
		out = out[:MaxAttachments]
	}
	var attachments []Attachment
	for _, e := range out {
		attachments = append(attachments, e.Attachment)
	}
	err = errors.Join(errs...)
	return attachments, err == nil && !cut, err
}

// defaultRouteCandidates lists (interface, gateway) pairs for every IPv4
// unicast default route outside the Linux local table (K4). A hop's own
// interface wins over the route's.
func defaultRouteCandidates(routes []networkcontext.RouteRow, byKey map[string]networkcontext.InterfaceRow) []candidate {
	var out []candidate
	for _, r := range routes {
		if r.Family != "ipv4" || r.DestinationPrefix != "0.0.0.0/0" || r.RouteType != "unicast" || r.TableKey == "255" {
			continue
		}
		for _, hop := range r.NextHops {
			if hop.Address == nil {
				continue
			}
			keyPtr := hop.InterfaceKey
			if keyPtr == nil {
				keyPtr = r.InterfaceKey
			}
			if keyPtr == nil {
				continue
			}
			row, ok := byKey[*keyPtr]
			if !ok {
				continue
			}
			gw, err := netip.ParseAddr(*hop.Address)
			if err != nil {
				continue
			}
			gw = gw.Unmap()
			if !gw.Is4() || gw.IsLoopback() || gw.IsLinkLocalUnicast() || gw.IsMulticast() || gw.IsUnspecified() || gw == netip.AddrFrom4([4]byte{255, 255, 255, 255}) {
				continue
			}
			out = append(out, candidate{row: row, gateway: gw})
		}
	}
	return out
}

// isUp is K3: Windows sets OperState, Linux and macOS set AdminState.
func isUp(row networkcontext.InterfaceRow) bool {
	return row.OperState == "up" || (row.OperState == "unknown" && row.AdminState == "up")
}

// reportableKind is K1: never a tunnel; a bridge or virtual row only with a
// proven physical uplink; every other kind (unknown included: macOS reports
// every en* as unknown) is reportable.
func reportableKind(row networkcontext.InterfaceRow, bridged map[string]bool) bool {
	switch row.Kind {
	case "tunnel":
		return false
	case "bridge", "virtual":
		return bridged[row.InterfaceKey]
	}
	return true
}

// localAddress is K5: the interface's IPv4 address whose prefix contains the
// gateway, else its lowest IPv4 address that is not link-local. Loopback,
// multicast and unspecified addresses never qualify.
func localAddress(row networkcontext.InterfaceRow, gateway netip.Addr) (netip.Prefix, bool) {
	var containing, lowest netip.Prefix
	for _, a := range row.Addresses {
		ip, err := netip.ParseAddr(a.Address)
		if err != nil {
			continue
		}
		ip = ip.Unmap()
		if !ip.Is4() || ip.IsLoopback() || ip.IsMulticast() || ip.IsUnspecified() || int(a.PrefixLength) > 32 {
			continue
		}
		p := netip.PrefixFrom(ip, int(a.PrefixLength))
		if p.Masked().Contains(gateway) && (!containing.IsValid() || ip.Less(containing.Addr())) {
			containing = p
		}
		if !ip.IsLinkLocalUnicast() && (!lowest.IsValid() || ip.Less(lowest.Addr())) {
			lowest = p
		}
	}
	if containing.IsValid() {
		return containing, true
	}
	return lowest, lowest.IsValid()
}

// gatewayMAC is K6: the neighbour row on the same interface with the gateway's
// address and a 6-byte MAC, unless it is incomplete or failed. Stale and
// permanent entries count; the report never probes.
func gatewayMAC(neighbors []networkcontext.NeighborRow, key string, gateway netip.Addr) net.HardwareAddr {
	for _, n := range neighbors {
		if n.InterfaceKey != key || n.MAC == nil || n.State == "incomplete" || n.State == "failed" {
			continue
		}
		ip, err := netip.ParseAddr(n.Address)
		if err != nil || ip.Unmap() != gateway {
			continue
		}
		mac, err := net.ParseMAC(*n.MAC)
		if err != nil || len(mac) != 6 {
			continue
		}
		return mac
	}
	return nil
}

// markPrimary is K7: the attachment on the interface that carries the route
// to the server, matched on the selected next hop. At most one.
func markPrimary(ctx context.Context, d deps, contextKey, serverHost string, out []entry) error {
	server, ok, err := serverAddress(ctx, d, serverHost)
	if err != nil || !ok {
		return err
	}
	sel, err := d.lookup(ctx, networkcontext.RouteLookupRequest{Destination: server, ContextKey: contextKey})
	if err != nil {
		return err
	}
	// With a next hop, the attachment whose gateway it is; with none (the
	// server is on-link), the interface's only attachment.
	var nextHop netip.Addr
	if sel.NextHop != nil {
		if nextHop, err = netip.ParseAddr(*sel.NextHop); err != nil {
			return nil
		}
		nextHop = nextHop.Unmap()
	}
	match := -1
	onInterface := 0
	for i := range out {
		if out[i].key != sel.InterfaceKey {
			continue
		}
		onInterface++
		if !nextHop.IsValid() || out[i].GatewayAddress == nextHop {
			if match == -1 {
				match = i
			}
		}
	}
	if match >= 0 && (nextHop.IsValid() || onInterface == 1) {
		out[match].Primary = true
	}
	return nil
}

// serverAddress resolves serverHost to one IPv4 address. An IP literal is used
// as is. No IPv4 address is not an error: nothing is primary.
func serverAddress(ctx context.Context, d deps, serverHost string) (netip.Addr, bool, error) {
	if ip, err := netip.ParseAddr(serverHost); err == nil {
		ip = ip.Unmap()
		return ip, ip.Is4(), nil
	}
	addrs, err := d.resolve(ctx, serverHost)
	if err != nil {
		return netip.Addr{}, false, err
	}
	for _, a := range addrs {
		if a = a.Unmap(); a.Is4() {
			return a, true, nil
		}
	}
	return netip.Addr{}, false, nil
}

// capName is K9: the longest prefix of at most 128 runes and 128 UTF-16 units.
func capName(name string) string {
	runes, units := 0, 0
	for i, r := range name {
		w := 1
		if r >= 0x10000 { // outside the BMP: a UTF-16 surrogate pair
			w = 2
		}
		if runes+1 > maxNameUnits || units+w > maxNameUnits {
			return name[:i]
		}
		runes++
		units += w
	}
	return name
}

// readerLookup reaches the reader's LookupRoute by type assertion, as
// networkdiagnostic does; a reader without one is unsupported.
func readerLookup(reader networkcontext.Reader) func(context.Context, networkcontext.RouteLookupRequest) (networkcontext.RouteSelection, error) {
	return func(ctx context.Context, request networkcontext.RouteLookupRequest) (networkcontext.RouteSelection, error) {
		r, ok := reader.(interface {
			LookupRoute(context.Context, networkcontext.RouteLookupRequest) (networkcontext.RouteSelection, error)
		})
		if !ok {
			return networkcontext.RouteSelection{}, networkcontext.ErrUnsupported
		}
		return r.LookupRoute(ctx, request)
	}
}

// systemResolve asks the system resolver for the host's IPv4 addresses. A
// name with no IPv4 address is not an error (K8): nothing is primary.
func systemResolve(ctx context.Context, host string) ([]netip.Addr, error) {
	addrs, err := net.DefaultResolver.LookupNetIP(ctx, "ip4", host)
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) && dnsErr.IsNotFound {
		return nil, nil
	}
	return addrs, err
}
