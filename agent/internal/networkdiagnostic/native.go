package networkdiagnostic

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors/networkcontext"
	"golang.org/x/net/dns/dnsmessage"
	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv4"
	"golang.org/x/net/ipv6"
)

type NativeIO struct {
	Reader networkcontext.Reader
	Origin Origin
}

func (n *NativeIO) LookupRoute(ctx context.Context, request networkcontext.RouteLookupRequest) (networkcontext.RouteSelection, error) {
	reader, ok := n.Reader.(interface {
		LookupRoute(context.Context, networkcontext.RouteLookupRequest) (networkcontext.RouteSelection, error)
	})
	if !ok {
		return networkcontext.RouteSelection{}, ErrUnsupportedContext
	}
	selected, e := reader.LookupRoute(ctx, request)
	if e != nil {
		return selected, e
	}
	interfaces, e := n.Reader.Interfaces(ctx, networkcontext.Context{ContextKey: selected.ContextKey, Families: []string{"ipv4", "ipv6"}})
	if e != nil {
		return selected, e
	}
	for _, iface := range interfaces.Rows {
		if iface.InterfaceKey == selected.InterfaceKey {
			for _, address := range iface.Addresses {
				ip, e := netip.ParseAddr(address.Address)
				if e == nil {
					selected.LocalPrefixes = append(selected.LocalPrefixes, netip.PrefixFrom(ip, int(address.PrefixLength)).Masked().String())
				}
			}
		}
	}
	return selected, nil
}
func (n *NativeIO) Resolvers(ctx context.Context) ([]networkcontext.ResolverRow, error) {
	s, e := n.Reader.Resolvers(ctx, networkcontext.Context{ContextKey: n.Origin.ContextKey, Families: []string{"ipv4", "ipv6"}})
	if e != nil || s.Outcome == networkcontext.Failed || s.Outcome == networkcontext.Unsupported {
		return nil, ErrUnsupportedContext
	}
	return s.Rows, nil
}
func (n *NativeIO) dialer(ctx context.Context, route networkcontext.RouteSelection, udp bool) (*net.Dialer, error) {
	if route.SourceAddress == "" || route.ContextKey != n.Origin.ContextKey {
		return nil, ErrUnsupportedContext
	}
	source, e := netip.ParseAddr(route.SourceAddress)
	if e != nil {
		return nil, e
	}
	section, e := n.Reader.Interfaces(ctx, networkcontext.Context{ContextKey: route.ContextKey, Families: []string{"ipv4", "ipv6"}})
	if e != nil {
		return nil, ErrUnsupportedContext
	}
	var index uint32
	for _, iface := range section.Rows {
		if iface.InterfaceKey == route.InterfaceKey {
			index = iface.OSIndex
			break
		}
	}
	if index == 0 {
		return nil, ErrUnsupportedContext
	}
	if route.OSIndex != 0 {
		index = route.OSIndex
	}
	zone := ""
	if source.Is6() && source.IsLinkLocalUnicast() {
		zone = strconv.FormatUint(uint64(index), 10)
	}
	dialer := &net.Dialer{Control: bindInterface(index, source.Is6())}
	if udp {
		dialer.LocalAddr = &net.UDPAddr{IP: net.IP(source.AsSlice()), Zone: zone}
	} else {
		dialer.LocalAddr = &net.TCPAddr{IP: net.IP(source.AsSlice()), Zone: zone}
	}
	return dialer, nil
}
func literalEndpoint(ip netip.Addr, port uint16, route networkcontext.RouteSelection) string {
	if ip.Is6() && ip.IsLinkLocalUnicast() && ip.Zone() == "" {
		ip = ip.WithZone(strconv.FormatUint(uint64(route.OSIndex), 10))
	}
	return net.JoinHostPort(ip.String(), strconv.Itoa(int(port)))
}
func (n *NativeIO) TCP(ctx context.Context, ip netip.Addr, port uint16, route networkcontext.RouteSelection) (Details, error) {
	d, e := n.dialer(ctx, route, false)
	if e != nil {
		return Details{}, e
	}
	started := time.Now()
	conn, e := d.DialContext(ctx, "tcp", literalEndpoint(ip, port, route))
	if e != nil {
		return Details{}, e
	}
	defer conn.Close()
	ms := float64(time.Since(started).Microseconds()) / 1000
	return Details{LatencyMS: &ms}, nil
}
func (n *NativeIO) HTTPS(ctx context.Context, ip netip.Addr, target TargetDefinition, route networkcontext.RouteSelection, method string, responseLimit int) (Details, error) {
	if target.ProxyMode != "direct" || target.MaxRedirects < 0 || target.MaxRedirects > 2 {
		return Details{}, ErrUnsupportedContext
	}
	d, e := n.dialer(ctx, route, false)
	if e != nil {
		return Details{}, e
	}
	started := time.Now()
	tlsConfig := &tls.Config{ServerName: target.Hostname, MinVersion: tls.VersionTLS12}
	dialTLS := func(ctx context.Context, _, _ string) (net.Conn, error) {
		raw, e := d.DialContext(ctx, "tcp", literalEndpoint(ip, target.Port, route))
		if e != nil {
			return nil, e
		}
		secured := tls.Client(raw, tlsConfig)
		if e = secured.HandshakeContext(ctx); e != nil {
			raw.Close()
			return nil, e
		}
		return secured, nil
	}
	if method == "tls" {
		conn, e := dialTLS(ctx, "", "")
		if e != nil {
			return Details{}, e
		}
		conn.Close()
		ms := float64(time.Since(started).Microseconds()) / 1000
		return Details{LatencyMS: &ms}, nil
	}
	transport := &http.Transport{Proxy: nil, DialTLSContext: dialTLS, DisableKeepAlives: true, TLSClientConfig: tlsConfig, MaxResponseHeaderBytes: 8192}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(request *http.Request, via []*http.Request) error {
		if target.MaxRedirects == 0 {
			return http.ErrUseLastResponse
		}
		if len(via) > target.MaxRedirects || request.URL.User != nil || request.URL.Scheme != "https" || request.URL.Hostname() != target.Hostname {
			return ErrBlocked
		}
		port := request.URL.Port()
		if port == "" {
			port = "443"
		}
		if port != strconv.Itoa(int(target.Port)) {
			return ErrBlocked
		}
		refreshed, e := requestRoute(request.Context(), n, n.Origin, ip)
		if e != nil {
			return e
		}
		if refreshed.InterfaceKey != route.InterfaceKey || refreshed.SourceAddress != route.SourceAddress {
			return ErrUnsupportedContext
		}
		return ValidateDestination(Target{Kind: "configured_target", Definition: &target}, ip, refreshed)
	}}
	request, e := http.NewRequestWithContext(ctx, target.Method, "https://"+net.JoinHostPort(target.Hostname, strconv.Itoa(int(target.Port)))+target.Path, nil)
	if e != nil {
		return Details{}, e
	}
	response, e := client.Do(request)
	if e != nil {
		return Details{}, e
	}
	defer response.Body.Close()
	if responseLimit <= 0 || responseLimit > 65536 {
		return Details{}, errors.New("invalid response limit")
	}
	count, e := io.Copy(io.Discard, io.LimitReader(response.Body, int64(responseLimit)+1))
	if e != nil {
		return Details{}, e
	}
	if count > int64(responseLimit) {
		return Details{}, errors.New("response_limit_exceeded")
	}
	ms := float64(time.Since(started).Microseconds()) / 1000
	details := Details{LatencyMS: &ms, StatusCode: &response.StatusCode}
	if response.StatusCode != target.ExpectedStatus {
		return details, errors.New("http_status_mismatch")
	}
	return details, nil
}
func (n *NativeIO) Resolve(ctx context.Context, hostname, queryType string, resolvers []networkcontext.ResolverRow, _ networkcontext.RouteSelection, retries int) ([]netip.Addr, error) {
	if !hostnamePattern.MatchString(hostname) || len(resolvers) > 2 || retries < 0 || retries > 1 {
		return nil, ErrBlocked
	}
	name, e := dnsmessage.NewName(hostname + ".")
	if e != nil {
		return nil, e
	}
	typ := dnsmessage.TypeA
	if queryType == "AAAA" {
		typ = dnsmessage.TypeAAAA
	}
	var last error
	for _, resolver := range resolvers {
		ip, e := netip.ParseAddr(resolver.Address)
		if e != nil {
			return nil, e
		}
		var route networkcontext.RouteSelection
		if resolver.IsLocalStub && ip.IsLoopback() {
			// Loopback is allowed only for the exact freshly observed local DNS
			// listener. Its route is local, not the requested external interface.
			fresh, err := n.Resolvers(ctx)
			if err != nil {
				return nil, err
			}
			matched := false
			for _, current := range fresh {
				if current.IsLocalStub && current.Address == resolver.Address && current.Port == resolver.Port && stringPtr(current.InterfaceKey) == stringPtr(resolver.InterfaceKey) {
					matched = true
					break
				}
			}
			if !matched {
				return nil, ErrUnsupportedContext
			}
			route, e = n.LookupRoute(ctx, networkcontext.RouteLookupRequest{ContextKey: n.Origin.ContextKey, Destination: ip})
		} else {
			route, e = requestRoute(ctx, n, n.Origin, ip)
			if e == nil {
				e = ValidateDestination(Target{Kind: "observed_resolver", Address: resolver.Address, Port: resolver.Port}, ip, route)
			}
		}
		if e != nil {
			return nil, e
		}
		for attempt := 0; attempt <= retries; attempt++ {
			attemptCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
			answers, e := n.queryDNS(attemptCtx, name, typ, resolver, route)
			cancel()
			if e == nil {
				return answers, nil
			}
			last = e
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
		}
	}
	return nil, last
}
func (n *NativeIO) queryDNS(ctx context.Context, name dnsmessage.Name, typ dnsmessage.Type, resolver networkcontext.ResolverRow, route networkcontext.RouteSelection) ([]netip.Addr, error) {
	var token [2]byte
	if _, e := rand.Read(token[:]); e != nil {
		return nil, e
	}
	id := binary.BigEndian.Uint16(token[:])
	query := dnsmessage.Message{Header: dnsmessage.Header{ID: id, RecursionDesired: true}, Questions: []dnsmessage.Question{{Name: name, Type: typ, Class: dnsmessage.ClassINET}}}
	wire, e := query.Pack()
	if e != nil {
		return nil, e
	}
	ip, e := netip.ParseAddr(resolver.Address)
	if e != nil {
		return nil, e
	}
	d, e := n.dialer(ctx, route, true)
	if e != nil {
		return nil, e
	}
	conn, e := d.DialContext(ctx, "udp", literalEndpoint(ip, resolver.Port, route))
	if e != nil {
		return nil, e
	}
	defer conn.Close()
	deadline, _ := ctx.Deadline()
	_ = conn.SetDeadline(deadline)
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	if _, e = conn.Write(wire); e != nil {
		return nil, e
	}
	buffer := make([]byte, 4096)
	count, e := conn.Read(buffer)
	if e != nil {
		return nil, e
	}
	var response dnsmessage.Message
	if e = response.Unpack(buffer[:count]); e != nil {
		return nil, e
	}
	if response.ID != id || !response.Response || response.RCode != dnsmessage.RCodeSuccess || response.Truncated {
		return nil, errors.New("invalid_dns_response")
	}
	ips := []netip.Addr{}
	for _, answer := range response.Answers {
		if answer.Header.Class != dnsmessage.ClassINET {
			continue
		}
		switch body := answer.Body.(type) {
		case *dnsmessage.AResource:
			if typ == dnsmessage.TypeA {
				ips = append(ips, netip.AddrFrom4(body.A))
			}
		case *dnsmessage.AAAAResource:
			if typ == dnsmessage.TypeAAAA {
				ips = append(ips, netip.AddrFrom16(body.AAAA))
			}
		}
		if len(ips) > 2 {
			return nil, errors.New("address_limit_exceeded")
		}
	}
	return ips, nil
}
func (n *NativeIO) ICMP(ctx context.Context, ip netip.Addr, route networkcontext.RouteSelection, count, payloadBytes int) (Details, error) {
	if count < 1 || count > 5 || payloadBytes < 0 || payloadBytes > 1024 {
		return Details{}, ErrBlocked
	}
	if route.SourceAddress == "" {
		return Details{}, ErrUnsupportedContext
	}
	network, protocol := "ip4:icmp", 1
	var typ icmp.Type = ipv4.ICMPTypeEcho
	expected := ipv4.ICMPTypeEchoReply
	if ip.Is6() {
		network = "ip6:ipv6-icmp"
		protocol = 58
		typ = ipv6.ICMPTypeEchoRequest
	}
	section, e := n.Reader.Interfaces(ctx, networkcontext.Context{ContextKey: route.ContextKey, Families: []string{"ipv4", "ipv6"}})
	if e != nil {
		return Details{}, ErrUnsupportedContext
	}
	index := 0
	for _, iface := range section.Rows {
		if iface.InterfaceKey == route.InterfaceKey {
			index = int(iface.OSIndex)
		}
	}
	if index == 0 {
		return Details{}, ErrUnsupportedContext
	}
	conn, e := icmp.ListenPacket(network, route.SourceAddress)
	if e != nil {
		return Details{}, ErrUnsupportedContext
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	var token [2]byte
	if _, e = rand.Read(token[:]); e != nil {
		return Details{}, e
	}
	id := int(binary.BigEndian.Uint16(token[:]))
	packetTimeout := 2 * time.Second
	if end, ok := ctx.Deadline(); ok {
		if remaining := time.Until(end) / time.Duration(count); remaining < packetTimeout {
			packetTimeout = remaining
		}
	}
	sent, received := 0, 0
	started := time.Now()
	for sequence := 0; sequence < count; sequence++ {
		if ctx.Err() != nil {
			return Details{}, ctx.Err()
		}
		message := icmp.Message{Type: typ, Body: &icmp.Echo{ID: id, Seq: sequence, Data: make([]byte, payloadBytes)}}
		wire, e := message.Marshal(nil)
		if e != nil {
			return Details{}, e
		}
		destination := &net.IPAddr{IP: net.IP(ip.AsSlice())}
		if ip.Is6() && ip.IsLinkLocalUnicast() {
			destination.Zone = strconv.Itoa(index)
		}
		if ip.Is6() {
			_, e = conn.IPv6PacketConn().WriteTo(wire, &ipv6.ControlMessage{Src: net.ParseIP(route.SourceAddress), IfIndex: index}, destination)
		} else {
			_, e = conn.IPv4PacketConn().WriteTo(wire, &ipv4.ControlMessage{Src: net.ParseIP(route.SourceAddress), IfIndex: index}, destination)
		}
		if e != nil {
			return Details{}, e
		}
		sent++
		deadline := time.Now().Add(packetTimeout)
		if end, ok := ctx.Deadline(); ok && end.Before(deadline) {
			deadline = end
		}
		_ = conn.SetReadDeadline(deadline)
		for {
			buffer := make([]byte, 1500)
			count, peer, e := conn.ReadFrom(buffer)
			if e != nil {
				break
			}
			reply, e := icmp.ParseMessage(protocol, buffer[:count])
			if e != nil {
				continue
			}
			peerIP, _, e := net.SplitHostPort(peer.String())
			if e != nil {
				peerIP = peer.String()
			}
			parsed, e := netip.ParseAddr(peerIP)
			if e != nil || parsed.Unmap() != ip.Unmap() {
				continue
			}
			matches := reply.Type == expected
			if ip.Is6() {
				matches = reply.Type == ipv6.ICMPTypeEchoReply
			}
			if echo, ok := reply.Body.(*icmp.Echo); matches && ok && echo.ID == id && echo.Seq == sequence {
				received++
				break
			}
		}
	}
	ms := float64(time.Since(started).Microseconds()) / 1000
	details := Details{LatencyMS: &ms, PacketsSent: &sent, PacketsReceived: &received}
	if received == 0 {
		return details, context.DeadlineExceeded
	}
	return details, nil
}
func (n *NativeIO) NeighborLookup(ctx context.Context, ip netip.Addr, route networkcontext.RouteSelection) (Details, error) {
	family := "ipv4"
	if ip.Is6() {
		family = "ipv6"
	}
	s, e := n.Reader.Neighbors(ctx, networkcontext.Context{ContextKey: route.ContextKey, Families: []string{family}})
	if e != nil {
		return Details{}, e
	}
	for _, row := range s.Rows {
		if row.Address == ip.WithZone("").String() && row.InterfaceKey == route.InterfaceKey {
			return Details{}, nil
		}
	}
	return Details{}, fmt.Errorf("neighbor_not_cached")
}
