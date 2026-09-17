//go:build linux

package networkcontext

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type LinuxReader struct {
	Identities     *InterfaceIdentities
	Dump           func(context.Context, uint16) ([]syscall.NetlinkMessage, error)
	InterfacesOS   func() ([]net.Interface, error)
	InterfaceAddrs func(net.Interface) ([]net.Addr, error)
	Namespace      func() (string, error)
	DNS            func(context.Context) (ResolverSection, error)
}

func NewReader(epoch string) Reader {
	return &LinuxReader{Identities: NewInterfaceIdentities(func(evidence string) (string, error) { return StableEvidenceKey(epoch, evidence), nil }), Dump: dumpNetlink, InterfacesOS: net.Interfaces, InterfaceAddrs: func(i net.Interface) ([]net.Addr, error) { return i.Addrs() }, Namespace: func() (string, error) { return os.Readlink("/proc/self/ns/net") }, DNS: readLinuxDNS}
}
func (r *LinuxReader) Capabilities() []Capability {
	return []Capability{{"interfaces", 1, true}, {"routes_ipv4", 1, true}, {"routes_ipv6", 1, true}, {"routing_rules", 1, true}, {"scoped_dns", 1, true}, {"neighbor_cache", 1, true}, {"route_lookup", 1, true}, {"interface_bound_probes", 1, true}}
}
func (r *LinuxReader) Contexts(ctx context.Context) (Manifest, error) {
	if e := ctx.Err(); e != nil {
		return Manifest{}, e
	}
	ns, e := r.Namespace()
	if e != nil {
		return Manifest{}, e
	}
	return Manifest{Outcome: Complete, Contexts: []Context{{ContextKey: "linux:" + ns, Families: []string{"ipv4", "ipv6"}}}}, nil
}
func (r *LinuxReader) Interfaces(ctx context.Context, _ Context) (Section[InterfaceRow], error) {
	rows, _, e := interfaceRows(ctx, r.Identities, r.InterfacesOS, r.InterfaceAddrs)
	return Section[InterfaceRow]{Rows: rows}, e
}
func (r *LinuxReader) keys(ctx context.Context) (map[int]string, error) {
	_, keys, e := interfaceRows(ctx, r.Identities, r.InterfacesOS, r.InterfaceAddrs)
	return keys, e
}

// dumpNetlink is receive-only apart from the kernel dump request; it never
// enters namespaces, changes configuration, or triggers ARP/NDP resolution.
func dumpNetlink(parent context.Context, typ uint16) ([]syscall.NetlinkMessage, error) {
	ctx, cancel := context.WithTimeout(parent, 2*time.Second)
	defer cancel()
	fd, e := syscall.Socket(syscall.AF_NETLINK, syscall.SOCK_RAW|syscall.SOCK_CLOEXEC, syscall.NETLINK_ROUTE)
	if e != nil {
		return nil, e
	}
	defer func() { _ = syscall.Close(fd) }()
	if e = syscall.Bind(fd, &syscall.SockaddrNetlink{Family: syscall.AF_NETLINK}); e != nil {
		return nil, e
	}
	if e = syscall.SetsockoptTimeval(fd, syscall.SOL_SOCKET, syscall.SO_RCVTIMEO, &syscall.Timeval{Usec: 100000}); e != nil {
		return nil, e
	}
	request := make([]byte, 20)
	binary.NativeEndian.PutUint32(request, uint32(len(request)))
	binary.NativeEndian.PutUint16(request[4:], typ)
	binary.NativeEndian.PutUint16(request[6:], syscall.NLM_F_REQUEST|syscall.NLM_F_DUMP)
	binary.NativeEndian.PutUint32(request[8:], 1)
	if e = syscall.Sendto(fd, request, 0, &syscall.SockaddrNetlink{Family: syscall.AF_NETLINK}); e != nil {
		return nil, e
	}
	out := []syscall.NetlinkMessage{}
	total := 0
	buf := make([]byte, 256*1024)
	for {
		if e = ctx.Err(); e != nil {
			return out, e
		}
		n, from, e := syscall.Recvfrom(fd, buf, syscall.MSG_TRUNC)
		if errors.Is(e, syscall.EAGAIN) || errors.Is(e, syscall.EINTR) {
			continue
		}
		if e != nil {
			return out, e
		}
		if n > len(buf) {
			return out, ErrLimit
		}
		sender, ok := from.(*syscall.SockaddrNetlink)
		if !ok || sender.Pid != 0 {
			return out, ErrMalformed
		}
		total += n
		if total > 4*1024*1024 {
			return out, ErrLimit
		}
		messages, e := syscall.ParseNetlinkMessage(buf[:n])
		if e != nil {
			return out, e
		}
		for _, m := range messages {
			if m.Header.Seq != 1 {
				continue
			}
			if m.Header.Flags&0x10 != 0 {
				return out, ErrMalformed
			}
			switch m.Header.Type {
			case syscall.NLMSG_DONE:
				return out, nil
			case syscall.NLMSG_ERROR:
				if len(m.Data) < 4 {
					return out, ErrMalformed
				}
				code := int32(binary.NativeEndian.Uint32(m.Data))
				if code != 0 {
					return out, syscall.Errno(-code)
				}
			default:
				out = append(out, m)
			}
		}
	}
}
func linuxAttrs(raw []byte) (map[uint16][]byte, error) {
	out := map[uint16][]byte{}
	for len(raw) > 0 {
		if len(raw) < 4 {
			return nil, ErrMalformed
		}
		n := int(binary.NativeEndian.Uint16(raw))
		if n < 4 || n > len(raw) {
			return nil, ErrMalformed
		}
		kind := binary.NativeEndian.Uint16(raw[2:]) & 0x3fff
		out[kind] = raw[4:n]
		padded := (n + 3) &^ 3
		if padded > len(raw) {
			return nil, ErrMalformed
		}
		raw = raw[padded:]
	}
	return out, nil
}
func attrU32(attrs map[uint16][]byte, key uint16, fallback uint32) (uint32, error) {
	value, ok := attrs[key]
	if !ok {
		return fallback, nil
	}
	if len(value) != 4 {
		return 0, ErrMalformed
	}
	return binary.NativeEndian.Uint32(value), nil
}
func linuxIP(raw []byte, family byte) (netip.Addr, error) {
	if family == syscall.AF_INET && len(raw) == 4 {
		return netip.AddrFrom4([4]byte(raw)), nil
	}
	if family == syscall.AF_INET6 && len(raw) == 16 {
		return netip.AddrFrom16([16]byte(raw)), nil
	}
	return netip.Addr{}, ErrMalformed
}
func linuxHop(attrs map[uint16][]byte, family byte, keys map[int]string, index int) (NextHop, error) {
	h := NextHop{}
	if key, ok := keys[index]; ok {
		h.InterfaceKey = ptr(key)
	}
	if raw, ok := attrs[5]; ok {
		ip, e := linuxIP(raw, family)
		if e != nil {
			return h, e
		}
		if !ip.IsUnspecified() {
			h.Address = ptr(ip.String())
			if ip.Is6() && ip.IsLinkLocalUnicast() {
				if h.InterfaceKey == nil {
					return h, ErrMalformed
				}
				h.Zone = h.InterfaceKey
			}
		}
	}
	return h, nil
}
func parseLinuxRoutes(messages []syscall.NetlinkMessage, keys map[int]string) ([]RouteRow, error) {
	out := []RouteRow{}
	var failures []error
	for _, m := range messages {
		if m.Header.Type != syscall.RTM_NEWROUTE {
			continue
		}
		if len(m.Data) < 12 {
			failures = append(failures, ErrMalformed)
			continue
		}
		header := m.Data[:12]
		family := header[0]
		if family != syscall.AF_INET && family != syscall.AF_INET6 {
			continue
		}
		attrs, e := linuxAttrs(m.Data[12:])
		if e != nil {
			failures = append(failures, e)
			continue
		}
		ip := netip.IPv4Unspecified()
		if family == syscall.AF_INET6 {
			ip = netip.IPv6Unspecified()
		}
		if raw, ok := attrs[1]; ok {
			ip, e = linuxIP(raw, family)
			if e != nil {
				failures = append(failures, e)
				continue
			}
		}
		if int(header[1]) > ip.BitLen() {
			failures = append(failures, ErrMalformed)
			continue
		}
		if ip.IsLoopback() {
			continue
		}
		table, e := attrU32(attrs, 15, uint32(header[4]))
		if e != nil {
			failures = append(failures, e)
			continue
		}
		index, e := attrU32(attrs, 4, 0)
		if e != nil {
			failures = append(failures, e)
			continue
		}
		metric, e := attrU32(attrs, 6, 0)
		if e != nil {
			failures = append(failures, e)
			continue
		}
		kind := map[byte]string{1: "unicast", 2: "local", 6: "blackhole", 7: "unreachable", 8: "prohibit"}[header[7]]
		if kind == "" {
			kind = "other"
		}
		row := RouteRow{Family: Family(ip), DestinationPrefix: netip.PrefixFrom(ip, int(header[1])).Masked().String(), TableKey: strconv.FormatUint(uint64(table), 10), RouteType: kind, NextHops: []NextHop{}, OSFlags: binary.NativeEndian.Uint32(header[8:]), Protocol: strconv.Itoa(int(header[5]))}
		if _, ok := attrs[6]; ok {
			row.Metric = ptr(metric)
		}
		if key, ok := keys[int(index)]; ok {
			row.InterfaceKey = ptr(key)
		}
		if raw, ok := attrs[2]; ok {
			source, e := linuxIP(raw, family)
			if e != nil || int(header[2]) > source.BitLen() {
				failures = append(failures, ErrMalformed)
				continue
			}
			row.SourcePrefix = netip.PrefixFrom(source, int(header[2])).Masked().String()
		}
		if multipath, ok := attrs[9]; ok {
			for len(multipath) > 0 {
				if len(multipath) < 8 {
					failures = append(failures, ErrMalformed)
					break
				}
				n := int(binary.NativeEndian.Uint16(multipath))
				if n < 8 || n > len(multipath) {
					failures = append(failures, ErrMalformed)
					break
				}
				a, e := linuxAttrs(multipath[8:n])
				if e != nil {
					failures = append(failures, e)
					break
				}
				hop, e := linuxHop(a, family, keys, int(binary.NativeEndian.Uint32(multipath[4:])))
				if e != nil {
					failures = append(failures, e)
					break
				}
				hop.Weight = ptr(uint32(multipath[3]) + 1)
				row.NextHops = append(row.NextHops, hop)
				padded := (n + 3) &^ 3
				if padded > len(multipath) {
					failures = append(failures, ErrMalformed)
					break
				}
				multipath = multipath[padded:]
			}
		} else {
			hop, e := linuxHop(attrs, family, keys, int(index))
			if e != nil {
				failures = append(failures, e)
				continue
			}
			if hop.Address == nil && row.InterfaceKey != nil && row.RouteType == "unicast" {
				row.RouteType = "on_link"
			}
			if hop.Address != nil || hop.InterfaceKey != nil {
				row.NextHops = append(row.NextHops, hop)
			}
		}
		out = append(out, row)
	}
	normalized, e := NormalizeRoutes(out)
	failures = append(failures, e)
	return normalized, errors.Join(failures...)
}
func (r *LinuxReader) Routes(ctx context.Context, scope Context) (Section[RouteRow], error) {
	keys, e := r.keys(ctx)
	if e != nil {
		return Section[RouteRow]{}, e
	}
	messages, readErr := r.Dump(ctx, syscall.RTM_GETROUTE)
	rows, e := parseLinuxRoutes(messages, keys)
	return Section[RouteRow]{Rows: filterRouteFamily(rows, scope)}, errors.Join(readErr, e)
}
func (r *LinuxReader) Rules(ctx context.Context, scope Context) (Section[RuleRow], error) {
	messages, readErr := r.Dump(ctx, syscall.RTM_GETRULE)
	rows := []RuleRow{}
	var failures []error
	failures = append(failures, readErr)
	for _, m := range messages {
		if m.Header.Type != syscall.RTM_NEWRULE {
			continue
		}
		if len(m.Data) < 12 {
			failures = append(failures, ErrMalformed)
			continue
		}
		h := m.Data[:12]
		if len(scope.Families) == 1 && ((h[0] == syscall.AF_INET && scope.Families[0] != "ipv4") || (h[0] == syscall.AF_INET6 && scope.Families[0] != "ipv6")) {
			continue
		}
		if h[0] != syscall.AF_INET && h[0] != syscall.AF_INET6 {
			continue
		}
		attrs, e := linuxAttrs(m.Data[12:])
		if e != nil {
			failures = append(failures, e)
			continue
		}
		priority, e := attrU32(attrs, 6, 0)
		if e != nil {
			failures = append(failures, e)
			continue
		}
		table, e := attrU32(attrs, 15, uint32(h[4]))
		if e != nil {
			failures = append(failures, e)
			continue
		}
		action := map[byte]string{1: "lookup", 2: "goto", 6: "blackhole", 7: "unreachable", 8: "prohibit"}[h[7]]
		if action == "" {
			action = "other"
		}
		row := RuleRow{Priority: priority, TableKey: ptr(strconv.FormatUint(uint64(table), 10)), Action: action, Selectors: []RuleSelector{}, SelectorCoverage: "complete"}
		// Header selectors change rule semantics even without attributes.
		if h[3] != 0 {
			row.SelectorCoverage = "partial"
			row.UnsupportedSelectorKinds = append(row.UnsupportedSelectorKinds, "tos")
		}
		if flags := binary.NativeEndian.Uint32(h[8:12]); flags != 0 {
			row.SelectorCoverage = "partial"
			row.UnsupportedSelectorKinds = append(row.UnsupportedSelectorKinds, fmt.Sprintf("rule_flags_%d", flags))
		}
		for kind, value := range attrs {
			switch kind {
			case 1, 2:
				ip, e := linuxIP(value, h[0])
				bits := h[1]
				name := "destination"
				if kind == 2 {
					bits = h[2]
					name = "source"
				}
				if e != nil || int(bits) > ip.BitLen() {
					row.SelectorCoverage = "partial"
					continue
				}
				row.Selectors = append(row.Selectors, RuleSelector{Kind: name, Prefix: netip.PrefixFrom(ip, int(bits)).Masked().String()})
			case 3, 17:
				row.SelectorCoverage = "partial"
				row.UnsupportedSelectorKinds = append(row.UnsupportedSelectorKinds, "native_interface_name")
			case 10:
				mark, e := attrU32(attrs, 10, 0)
				mask, e2 := attrU32(attrs, 16, ^uint32(0))
				if e != nil || e2 != nil {
					row.SelectorCoverage = "partial"
					continue
				}
				row.Selectors = append(row.Selectors, RuleSelector{Kind: "fwmark", Value: ptr(mark), Mask: ptr(mask)})
			case 20:
				if len(value) != 8 {
					row.SelectorCoverage = "partial"
					continue
				}
				row.Selectors = append(row.Selectors, RuleSelector{Kind: "uidRange", Start: ptr(binary.NativeEndian.Uint32(value)), End: ptr(binary.NativeEndian.Uint32(value[4:]))})
			case 6, 15, 16:
			default:
				row.SelectorCoverage = "partial"
				row.UnsupportedSelectorKinds = append(row.UnsupportedSelectorKinds, fmt.Sprintf("attribute_%d", kind))
			}
		}
		sort.Slice(row.Selectors, func(i, j int) bool { return stableString(row.Selectors[i]) < stableString(row.Selectors[j]) })
		sort.Strings(row.UnsupportedSelectorKinds)
		row.RowKey = rowIdentity(row)
		rows = append(rows, row)
	}
	return Section[RuleRow]{Rows: rows}, errors.Join(failures...)
}
func (r *LinuxReader) Resolvers(ctx context.Context, _ Context) (ResolverSection, error) {
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
	for _, i := range native {
		names[i.Name] = i.Index
	}
	for i := range s.Rows {
		row := &s.Rows[i]
		if row.InterfaceKey == nil {
			continue
		}
		raw := *row.InterfaceKey
		index := names[strings.TrimPrefix(raw, "linux-ifname:")]
		if strings.HasPrefix(raw, "linux-ifindex:") {
			index, _ = strconv.Atoi(strings.TrimPrefix(raw, "linux-ifindex:"))
		}
		key, ok := keys[index]
		if !ok {
			s.Outcome = Partial
			s.ReasonCode = "resolver_scope_unknown"
			if row.Zone != nil {
				return s, ErrMalformed
			}
			row.InterfaceKey = nil
			continue
		}
		row.InterfaceKey = ptr(key)
		if row.Zone != nil {
			row.Zone = ptr(key)
		}
		row.RowKey = ""
		row.RowKey = rowIdentity(*row)
	}
	return s, nil
}
func (r *LinuxReader) Neighbors(ctx context.Context, scope Context) (Section[NeighborRow], error) {
	keys, e := r.keys(ctx)
	if e != nil {
		return Section[NeighborRow]{}, e
	}
	messages, readErr := r.Dump(ctx, syscall.RTM_GETNEIGH)
	rows := []NeighborRow{}
	var failures []error
	failures = append(failures, readErr)
	for _, m := range messages {
		if m.Header.Type != syscall.RTM_NEWNEIGH {
			continue
		}
		if len(m.Data) < 12 {
			failures = append(failures, ErrMalformed)
			continue
		}
		h := m.Data[:12]
		key, ok := keys[int(binary.NativeEndian.Uint32(h[4:]))]
		if !ok {
			continue
		}
		attrs, e := linuxAttrs(m.Data[12:])
		if e != nil {
			failures = append(failures, e)
			continue
		}
		ip, e := linuxIP(attrs[1], h[0])
		if e != nil {
			failures = append(failures, e)
			continue
		}
		state := "unknown"
		nativeState := binary.NativeEndian.Uint16(h[8:])
		for _, pair := range []struct {
			bit  uint16
			name string
		}{{1, "incomplete"}, {2, "reachable"}, {4, "stale"}, {8, "delay"}, {16, "probe"}, {32, "failed"}, {128, "permanent"}} {
			if nativeState&pair.bit != 0 {
				state = pair.name
				break
			}
		}
		var mac, zone *string
		if raw := attrs[2]; len(raw) == 6 {
			mac = ptr(net.HardwareAddr(raw).String())
		}
		if ip.Is6() && ip.IsLinkLocalUnicast() {
			zone = ptr(key)
		}
		rows = append(rows, NeighborRow{RowKey: key + ":" + ip.String(), Address: ip.String(), Family: Family(ip), Zone: zone, InterfaceKey: key, MAC: mac, State: state, IsRouter: ptr(h[10]&0x80 != 0)})
	}
	return Section[NeighborRow]{Rows: filterNeighborFamily(rows, scope)}, errors.Join(failures...)
}

func (r *LinuxReader) SetIdentityResolver(resolve func(string) (string, error)) {
	r.Identities = NewInterfaceIdentities(resolve)
}
