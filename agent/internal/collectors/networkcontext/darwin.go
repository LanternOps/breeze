//go:build darwin

package networkcontext

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/net/route"
)

// DarwinReader reads the process-visible RIB; all OS seams are injectable.
type DarwinReader struct {
	Identities     *InterfaceIdentities
	FetchRIB       func(int, route.RIBType, int) ([]byte, error)
	InterfacesOS   func() ([]net.Interface, error)
	InterfaceAddrs func(net.Interface) ([]net.Addr, error)
	DNS            func(context.Context) (ResolverSection, error)
}

func NewReader(epoch string) Reader {
	return &DarwinReader{Identities: NewInterfaceIdentities(func(evidence string) (string, error) { return StableEvidenceKey(epoch, evidence), nil }), FetchRIB: route.FetchRIB, InterfacesOS: net.Interfaces, InterfaceAddrs: func(i net.Interface) ([]net.Addr, error) { return i.Addrs() }, DNS: readNativeDNS}
}
func (r *DarwinReader) Capabilities() []Capability {
	return []Capability{{"interfaces", 1, true}, {"routes_ipv4", 1, true}, {"routes_ipv6", 1, true}, {"routing_rules", 1, false}, {"scoped_dns", 1, true}, {"neighbor_cache", 1, true}, {"route_lookup", 1, true}, {"interface_bound_probes", 1, true}}
}
func (r *DarwinReader) Contexts(ctx context.Context) (Manifest, error) {
	if e := ctx.Err(); e != nil {
		return Manifest{}, e
	}
	return Manifest{Outcome: Complete, Contexts: []Context{{"darwin:default", []string{"ipv4", "ipv6"}}}}, nil
}
func (r *DarwinReader) Interfaces(ctx context.Context, _ Context) (Section[InterfaceRow], error) {
	rows, _, e := interfaceRows(ctx, r.Identities, r.InterfacesOS, r.InterfaceAddrs)
	return Section[InterfaceRow]{Rows: rows}, e
}
func (r *DarwinReader) keys(ctx context.Context) (map[int]string, error) {
	_, keys, e := interfaceRows(ctx, r.Identities, r.InterfacesOS, r.InterfaceAddrs)
	return keys, e
}
func (r *DarwinReader) messages(ctx context.Context) ([]route.Message, error) {
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	b, e := r.FetchRIB(syscall.AF_UNSPEC, route.RIBTypeRoute, 0)
	if e != nil {
		return nil, e
	}
	if len(b) > 1024*1024 {
		return nil, ErrLimit
	}
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	return route.ParseRIB(route.RIBTypeRoute, b)
}
func nativeAddr(a route.Addr) (netip.Addr, int, bool) {
	switch v := a.(type) {
	case *route.Inet4Addr:
		return netip.AddrFrom4(v.IP), 0, true
	case *route.Inet6Addr:
		ip := v.IP
		zone := v.ZoneID
		if ip[0] == 0xfe && ip[1]&0xc0 == 0x80 {
			if zone == 0 {
				zone = int(ip[2])<<8 | int(ip[3])
			}
			ip[2], ip[3] = 0, 0
		}
		return netip.AddrFrom16(ip), zone, true
	}
	return netip.Addr{}, 0, false
}
func addrAt(a []route.Addr, index int) route.Addr {
	if index >= len(a) {
		return nil
	}
	return a[index]
}
func routePrefix(m *route.RouteMessage) (netip.Prefix, error) {
	ip, _, ok := nativeAddr(addrAt(m.Addrs, syscall.RTAX_DST))
	if !ok {
		return netip.Prefix{}, ErrMalformed
	}
	bits := 0
	if m.Flags&syscall.RTF_HOST != 0 {
		bits = ip.BitLen()
	} else if mask := addrAt(m.Addrs, syscall.RTAX_NETMASK); mask != nil {
		if maskIP, _, ok := nativeAddr(mask); ok {
			ones, total := net.IPMask(maskIP.AsSlice()).Size()
			if total == 0 {
				return netip.Prefix{}, ErrMalformed
			}
			bits = ones
		} else if raw, ok := mask.(*route.DefaultAddr); ok {
			b := make([]byte, ip.BitLen()/8)
			offset := 4
			if ip.Is6() {
				offset = 8
			}
			if len(raw.Raw) > offset {
				copy(b, raw.Raw[offset:])
			}
			ones, total := net.IPMask(b).Size()
			if total == 0 {
				return netip.Prefix{}, ErrMalformed
			}
			bits = ones
		} else {
			return netip.Prefix{}, ErrMalformed
		}
	}
	return netip.PrefixFrom(ip, bits).Masked(), nil
}
func parseDarwinRoutes(messages []route.Message, keys map[int]string) ([]RouteRow, error) {
	rows := []RouteRow{}
	var failures []error
	for _, message := range messages {
		m, ok := message.(*route.RouteMessage)
		if !ok || m.Flags&syscall.RTF_LLINFO != 0 {
			continue
		}
		prefix, e := routePrefix(m)
		if e != nil {
			failures = append(failures, e)
			continue
		}
		if prefix.Addr().IsLoopback() {
			continue
		}
		key, ok := keys[m.Index]
		if !ok {
			continue
		}
		kind := "unicast"
		if m.Flags&syscall.RTF_GATEWAY == 0 {
			kind = "on_link"
		}
		if m.Flags&syscall.RTF_REJECT != 0 {
			kind = "unreachable"
		}
		if m.Flags&syscall.RTF_BLACKHOLE != 0 {
			kind = "blackhole"
		}
		hop := NextHop{InterfaceKey: ptr(key)}
		if ip, zone, ok := nativeAddr(addrAt(m.Addrs, syscall.RTAX_GATEWAY)); ok && !ip.IsUnspecified() {
			hop.Address = ptr(ip.String())
			if ip.Is6() && ip.IsLinkLocalUnicast() {
				hop.Zone = ptr(key)
				if zone != 0 && zone != m.Index {
					failures = append(failures, ErrMalformed)
					continue
				}
			}
		}
		rows = append(rows, RouteRow{Family: Family(prefix.Addr()), DestinationPrefix: prefix.String(), InterfaceKey: ptr(key), TableKey: "default", RouteType: kind, NextHops: []NextHop{hop}, OSFlags: uint32(m.Flags)})
	}
	normalized, e := NormalizeRoutes(rows)
	failures = append(failures, e)
	return normalized, errors.Join(failures...)
}
func (r *DarwinReader) Routes(ctx context.Context, scope Context) (Section[RouteRow], error) {
	keys, e := r.keys(ctx)
	if e != nil {
		return Section[RouteRow]{}, e
	}
	messages, e := r.messages(ctx)
	if e != nil {
		return Section[RouteRow]{}, e
	}
	rows, e := parseDarwinRoutes(messages, keys)
	return Section[RouteRow]{Rows: filterRouteFamily(rows, scope)}, e
}
func (r *DarwinReader) Rules(context.Context, Context) (Section[RuleRow], error) {
	return Section[RuleRow]{}, ErrUnsupported
}
func (r *DarwinReader) Resolvers(ctx context.Context, _ Context) (ResolverSection, error) {
	s, err := r.DNS(ctx)
	if err != nil {
		return s, err
	}
	keys, err := r.keys(ctx)
	if err != nil {
		return s, err
	}
	native, err := r.InterfacesOS()
	if err != nil {
		return s, err
	}
	names := map[string]int{}
	for _, item := range native {
		names[item.Name] = item.Index
	}
	for i := range s.Rows {
		row := &s.Rows[i]
		if row.InterfaceKey != nil {
			index, err := strconv.Atoi(strings.TrimPrefix(*row.InterfaceKey, "darwin-ifindex:"))
			if strings.HasPrefix(*row.InterfaceKey, "darwin-ifname:") {
				index = names[strings.TrimPrefix(*row.InterfaceKey, "darwin-ifname:")]
				err = nil
			}
			key, ok := keys[index]
			if err != nil || !ok {
				s.Outcome = Partial
				s.ReasonCode = "resolver_scope_unknown"
				row.InterfaceKey = nil
				if row.Zone != nil {
					return s, ErrMalformed
				}
				continue
			}
			row.InterfaceKey = ptr(key)
			if row.Zone != nil {
				row.Zone = ptr(key)
			}
			row.RowKey = ""
			row.RowKey = rowIdentity(*row)
		}
	}
	return s, nil
}
func (r *DarwinReader) Neighbors(ctx context.Context, scope Context) (Section[NeighborRow], error) {
	keys, e := r.keys(ctx)
	if e != nil {
		return Section[NeighborRow]{}, e
	}
	messages, e := r.messages(ctx)
	if e != nil {
		return Section[NeighborRow]{}, e
	}
	rows := []NeighborRow{}
	for _, message := range messages {
		m, ok := message.(*route.RouteMessage)
		if !ok || m.Flags&syscall.RTF_LLINFO == 0 {
			continue
		}
		key, ok := keys[m.Index]
		if !ok {
			continue
		}
		ip, _, ok := nativeAddr(addrAt(m.Addrs, syscall.RTAX_DST))
		if !ok {
			continue
		}
		var mac *string
		if link, ok := addrAt(m.Addrs, syscall.RTAX_GATEWAY).(*route.LinkAddr); ok && len(link.Addr) == 6 {
			mac = ptr(net.HardwareAddr(link.Addr).String())
		}
		var zone *string
		if ip.Is6() && ip.IsLinkLocalUnicast() {
			zone = ptr(key)
		}
		rows = append(rows, NeighborRow{RowKey: key + ":" + ip.String(), Address: ip.String(), Family: Family(ip), Zone: zone, InterfaceKey: key, MAC: mac, State: "unknown"})
	}
	return Section[NeighborRow]{Rows: filterNeighborFamily(rows, scope)}, nil
}
func darwinIndexKey(index int) string { return "darwin-ifindex:" + strconv.Itoa(index) }

func (r *DarwinReader) SetIdentityResolver(resolve func(string) (string, error)) {
	r.Identities = NewInterfaceIdentities(resolve)
}
