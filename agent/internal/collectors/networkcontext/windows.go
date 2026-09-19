//go:build windows

package networkcontext

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

type Adapter struct {
	GUID        string
	Index       uint32
	IPv6Index   uint32
	LUID        uint64
	Compartment uint32
	Row         InterfaceRow
	Resolvers   []ResolverRow
}

func InterfaceIdentity(a Adapter) string { return "windows-guid:" + strings.ToLower(a.GUID) }

type WindowsReader struct {
	Adapters     func(context.Context) ([]Adapter, error)
	ForwardTable func(context.Context) ([]windows.MibIpForwardRow2, error)
	Compartment  func() uint32
}

var ipHelper = windows.NewLazySystemDLL("iphlpapi.dll")
var currentCompartment = ipHelper.NewProc("GetCurrentThreadCompartmentId")
var bestRoute2 = ipHelper.NewProc("GetBestRoute2")
var getNeighbors2 = ipHelper.NewProc("GetIpNetTable2")

func NewReader(_ string) Reader {
	return &WindowsReader{Adapters: readWindowsAdapters, ForwardTable: readWindowsRoutes, Compartment: func() uint32 { value, _, _ := currentCompartment.Call(); return uint32(value) }}
}
func (r *WindowsReader) Capabilities() []Capability {
	return []Capability{{"interfaces", 1, true}, {"routes_ipv4", 1, true}, {"routes_ipv6", 1, true}, {"routing_rules", 1, false}, {"scoped_dns", 1, true}, {"neighbor_cache", 1, true}, {"route_lookup", 1, true}, {"interface_bound_probes", 1, true}, {"external_compartments", 1, false}}
}
func (r *WindowsReader) Contexts(ctx context.Context) (Manifest, error) {
	if e := ctx.Err(); e != nil {
		return Manifest{}, e
	}
	id := r.Compartment()
	if id == 0 {
		return Manifest{}, ErrMalformed
	}
	return Manifest{Outcome: Complete, Contexts: []Context{{ContextKey: "windows-compartment:" + strconv.FormatUint(uint64(id), 10), Families: []string{"ipv4", "ipv6"}}}}, nil
}
func winIP(raw windows.RawSockaddrInet) (netip.Addr, uint32, error) {
	switch raw.Family {
	case windows.AF_INET:
		v := (*windows.RawSockaddrInet4)(unsafe.Pointer(&raw))
		return netip.AddrFrom4(v.Addr), 0, nil
	case windows.AF_INET6:
		v := (*windows.RawSockaddrInet6)(unsafe.Pointer(&raw))
		return netip.AddrFrom16(v.Addr), v.Scope_id, nil
	}
	return netip.Addr{}, 0, ErrMalformed
}
func readWindowsAdapters(ctx context.Context) ([]Adapter, error) {
	size := uint32(15000)
	for attempt := 0; attempt < 3; attempt++ {
		if e := ctx.Err(); e != nil {
			return nil, e
		}
		if size > 1024*1024 {
			return nil, ErrLimit
		}
		b := make([]byte, size)
		head := (*windows.IpAdapterAddresses)(unsafe.Pointer(&b[0]))
		e := windows.GetAdaptersAddresses(windows.AF_UNSPEC, windows.GAA_FLAG_INCLUDE_PREFIX, 0, head, &size)
		if errors.Is(e, windows.ERROR_BUFFER_OVERFLOW) {
			continue
		}
		if e != nil {
			return nil, e
		}
		out := []Adapter{}
		seen := map[*windows.IpAdapterAddresses]bool{}
		for a := head; a != nil; a = a.Next {
			if seen[a] || len(seen) >= 128 {
				return out, ErrLimit
			}
			seen[a] = true
			if a.IfType == 24 {
				continue
			}
			adapter := Adapter{GUID: windows.BytePtrToString(a.AdapterName), Index: a.IfIndex, IPv6Index: a.Ipv6IfIndex, LUID: a.Luid, Compartment: a.CompartmentId}
			key := InterfaceIdentity(adapter)
			name := windows.UTF16PtrToString(a.FriendlyName)
			if name == "" {
				name = adapter.GUID
			}
			state := "down"
			if a.OperStatus == 1 {
				state = "up"
			}
			kind := map[uint32]string{6: "ethernet", 71: "wifi", 131: "tunnel", 243: "cellular", 244: "cellular"}[a.IfType]
			if kind == "" {
				kind = "other"
			}
			adapter.Row = InterfaceRow{RowKey: key, InterfaceKey: key, OSIndex: a.IfIndex, Name: name, Kind: kind, AdminState: "unknown", OperState: state, MTU: ptr(a.Mtu), Addresses: []AddressRow{}}
			if a.PhysicalAddressLength == 6 {
				adapter.Row.CurrentMAC = net.HardwareAddr(a.PhysicalAddress[:6]).String()
			}
			count := 0
			for address := a.FirstUnicastAddress; address != nil; address = address.Next {
				count++
				if count > 1024 {
					return out, ErrLimit
				}
				ip, ok := netip.AddrFromSlice(address.Address.IP())
				if !ok {
					continue
				}
				ip = ip.Unmap()
				var zone *string
				if ip.Is6() && ip.IsLinkLocalUnicast() {
					zone = ptr(key)
				}
				assignment := "unknown"
				switch address.PrefixOrigin {
				case 1:
					assignment = "static"
				case 3:
					assignment = "dhcp"
				case 4:
					assignment = "slaac"
				}
				status := map[int32]string{0: "unknown", 1: "tentative", 2: "duplicate", 3: "deprecated", 4: "preferred"}[address.DadState]
				if status == "" {
					status = "unknown"
				}
				adapter.Row.Addresses = append(adapter.Row.Addresses, AddressRow{Address: ip.String(), PrefixLength: address.OnLinkPrefixLength, Family: Family(ip), Zone: zone, State: status, Assignment: assignment})
			}
			domains := []Domain{}
			if suffix := windows.UTF16PtrToString(a.DnsSuffix); suffix != "" {
				domains = append(domains, Domain{Name: suffix})
			}
			count = 0
			for server := a.FirstDnsServerAddress; server != nil; server = server.Next {
				count++
				if count > 128 {
					return out, ErrLimit
				}
				ip, ok := netip.AddrFromSlice(server.Address.IP())
				if !ok {
					continue
				}
				ip = ip.Unmap()
				var zone *string
				if ip.Is6() && ip.IsLinkLocalUnicast() {
					zone = ptr(key)
				}
				row := ResolverRow{Address: ip.String(), Zone: zone, InterfaceKey: ptr(key), IsLocalStub: ip.IsLoopback(), Port: 53, Transport: "udp_tcp", Domains: domains, Mechanism: "ip_helper"}
				row.RowKey = rowIdentity(row)
				adapter.Resolvers = append(adapter.Resolvers, row)
			}
			out = append(out, adapter)
		}
		runtime.KeepAlive(b)
		return out, nil
	}
	return nil, ErrLimit
}
func readWindowsRoutes(ctx context.Context) ([]windows.MibIpForwardRow2, error) {
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	var table *windows.MibIpForwardTable2
	if e := windows.GetIpForwardTable2(windows.AF_UNSPEC, &table); e != nil {
		return nil, e
	}
	if table == nil {
		return nil, ErrMalformed
	}
	defer windows.FreeMibTable(unsafe.Pointer(table))
	if table.NumEntries > 65536 {
		return nil, ErrLimit
	}
	return append([]windows.MibIpForwardRow2{}, table.Rows()...), nil
}
func (r *WindowsReader) Interfaces(ctx context.Context, _ Context) (Section[InterfaceRow], error) {
	adapters, e := r.Adapters(ctx)
	rows := []InterfaceRow{}
	for _, a := range adapters {
		rows = append(rows, a.Row)
	}
	normalized, err := NormalizeInterfaces(rows)
	return Section[InterfaceRow]{Rows: normalized}, errors.Join(e, err)
}
func windowsAdapterKeys(adapters []Adapter) map[uint32]string {
	keys := map[uint32]string{}
	for _, a := range adapters {
		keys[a.Index] = InterfaceIdentity(a)
		keys[a.IPv6Index] = InterfaceIdentity(a)
	}
	delete(keys, 0)
	return keys
}
func windowsRouteRows(native []windows.MibIpForwardRow2, keys map[uint32]string) ([]RouteRow, error) {
	rows := []RouteRow{}
	for _, v := range native {
		if v.Loopback != 0 {
			continue
		}
		key, ok := keys[v.InterfaceIndex]
		if !ok {
			continue
		}
		ip, _, e := winIP(v.DestinationPrefix.Prefix)
		if e != nil {
			return rows, e
		}
		if int(v.DestinationPrefix.PrefixLength) > ip.BitLen() {
			return rows, ErrMalformed
		}
		hopIP, _, e := winIP(v.NextHop)
		if e != nil {
			return rows, e
		}
		hop := NextHop{InterfaceKey: ptr(key)}
		kind := "on_link"
		if !hopIP.IsUnspecified() {
			hop.Address = ptr(hopIP.String())
			kind = "unicast"
			if hopIP.Is6() && hopIP.IsLinkLocalUnicast() {
				hop.Zone = ptr(key)
			}
		}
		rows = append(rows, RouteRow{Family: Family(ip), DestinationPrefix: netip.PrefixFrom(ip, int(v.DestinationPrefix.PrefixLength)).Masked().String(), InterfaceKey: ptr(key), TableKey: "compartment", RouteType: kind, Metric: ptr(v.Metric), NextHops: []NextHop{hop}, Protocol: strconv.FormatUint(uint64(v.Protocol), 10)})
	}
	return NormalizeRoutes(rows)
}
func (r *WindowsReader) Routes(ctx context.Context, scope Context) (Section[RouteRow], error) {
	a, e := r.Adapters(ctx)
	if e != nil {
		return Section[RouteRow]{}, e
	}
	native, e := r.ForwardTable(ctx)
	if e != nil {
		return Section[RouteRow]{}, e
	}
	rows, e := windowsRouteRows(native, windowsAdapterKeys(a))
	return Section[RouteRow]{Rows: filterRouteFamily(rows, scope)}, e
}
func (r *WindowsReader) Rules(context.Context, Context) (Section[RuleRow], error) {
	return Section[RuleRow]{}, ErrUnsupported
}
func (r *WindowsReader) Resolvers(ctx context.Context, _ Context) (ResolverSection, error) {
	a, e := r.Adapters(ctx)
	rows := []ResolverRow{}
	for _, v := range a {
		rows = append(rows, v.Resolvers...)
	}
	return ResolverSection{Rows: rows}, e
}

// ABI mirrors MIB_IPNET_ROW2; neighbor reads never resolve an absent entry.
type windowsNeighbor struct {
	Address               windows.RawSockaddrInet
	InterfaceIndex        uint32
	InterfaceLUID         uint64
	PhysicalAddress       [32]byte
	PhysicalAddressLength uint32
	State                 uint32
	Flags                 uint8
	_                     [3]byte
	ReachabilityTime      uint32
}
type windowsNeighborTable struct {
	Count uint32
	Rows  [1]windowsNeighbor
}

func (r *WindowsReader) Neighbors(ctx context.Context, scope Context) (Section[NeighborRow], error) {
	a, e := r.Adapters(ctx)
	if e != nil {
		return Section[NeighborRow]{}, e
	}
	keys := windowsAdapterKeys(a)
	if e = ctx.Err(); e != nil {
		return Section[NeighborRow]{}, e
	}
	var table *windowsNeighborTable
	code, _, _ := getNeighbors2.Call(windows.AF_UNSPEC, uintptr(unsafe.Pointer(&table)))
	if code != 0 {
		return Section[NeighborRow]{}, syscall.Errno(code)
	}
	if table == nil {
		return Section[NeighborRow]{}, ErrMalformed
	}
	defer windows.FreeMibTable(unsafe.Pointer(table))
	if table.Count > 65536 {
		return Section[NeighborRow]{}, ErrLimit
	}
	rows := []NeighborRow{}
	for _, value := range unsafe.Slice(&table.Rows[0], table.Count) {
		key, ok := keys[value.InterfaceIndex]
		if !ok {
			continue
		}
		ip, _, e := winIP(value.Address)
		if e != nil {
			return Section[NeighborRow]{Rows: filterNeighborFamily(rows, scope)}, e
		}
		var mac, zone *string
		if value.PhysicalAddressLength == 6 {
			mac = ptr(net.HardwareAddr(value.PhysicalAddress[:6]).String())
		}
		if ip.Is6() && ip.IsLinkLocalUnicast() {
			zone = ptr(key)
		}
		state := map[uint32]string{0: "failed", 1: "incomplete", 2: "probe", 3: "delay", 4: "stale", 5: "reachable", 6: "permanent"}[value.State]
		if state == "" {
			state = "unknown"
		}
		rows = append(rows, NeighborRow{RowKey: key + ":" + ip.String(), Address: ip.String(), Family: Family(ip), Zone: zone, InterfaceKey: key, MAC: mac, State: state, IsRouter: ptr(value.Flags&1 != 0)})
	}
	return Section[NeighborRow]{Rows: filterNeighborFamily(rows, scope)}, nil
}
func winSockaddr(ip netip.Addr, index uint32) windows.RawSockaddrInet {
	var raw windows.RawSockaddrInet
	if ip.Is4() {
		v := (*windows.RawSockaddrInet4)(unsafe.Pointer(&raw))
		v.Family = windows.AF_INET
		v.Addr = ip.As4()
	} else {
		v := (*windows.RawSockaddrInet6)(unsafe.Pointer(&raw))
		v.Family = windows.AF_INET6
		v.Addr = ip.As16()
		v.Scope_id = index
	}
	return raw
}
func (r *WindowsReader) LookupRoute(ctx context.Context, request RouteLookupRequest) (RouteSelection, error) {
	if e := ctx.Err(); e != nil {
		return RouteSelection{}, e
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if request.ContextKey != "windows-compartment:"+strconv.FormatUint(uint64(r.Compartment()), 10) {
		return RouteSelection{}, ErrUnsupported
	}
	adapters, e := r.Adapters(ctx)
	if e != nil {
		return RouteSelection{}, e
	}
	var index uint32
	for _, a := range adapters {
		if InterfaceIdentity(a) == request.InterfaceKey {
			index = a.Index
			if request.Destination.Is6() {
				index = a.IPv6Index
			}
		}
	}
	if request.InterfaceKey != "" && index == 0 {
		return RouteSelection{}, ErrUnsupported
	}
	destination := winSockaddr(request.Destination, index)
	var source, bestSource windows.RawSockaddrInet
	var sourcePointer uintptr
	if request.Source.IsValid() {
		source = winSockaddr(request.Source, index)
		sourcePointer = uintptr(unsafe.Pointer(&source))
	}
	var row windows.MibIpForwardRow2
	code, _, _ := bestRoute2.Call(0, uintptr(index), sourcePointer, uintptr(unsafe.Pointer(&destination)), 0, uintptr(unsafe.Pointer(&row)), uintptr(unsafe.Pointer(&bestSource)))
	if code != 0 {
		return RouteSelection{}, syscall.Errno(code)
	}
	key, ok := windowsAdapterKeys(adapters)[row.InterfaceIndex]
	if !ok {
		return RouteSelection{}, ErrUnsupported
	}
	ip, _, e := winIP(bestSource)
	if e != nil {
		return RouteSelection{}, e
	}
	hop, _, e := winIP(row.NextHop)
	if e != nil {
		return RouteSelection{}, e
	}
	out := RouteSelection{ContextKey: request.ContextKey, InterfaceKey: key, OSIndex: row.InterfaceIndex, SourceAddress: ip.String(), Attribution: "observed"}
	if !hop.IsUnspecified() {
		out.NextHop = ptr(hop.String())
		if hop.Is6() && hop.IsLinkLocalUnicast() {
			out.Zone = ptr(key)
		}
	}
	return out, nil
}
