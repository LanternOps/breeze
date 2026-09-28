//go:build !windows

package networkdiagnostic

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"net"
	"net/netip"
	"strconv"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors/networkcontext"
	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv4"
	"golang.org/x/net/ipv6"
)

var (
	traceSupportOnce sync.Once
	traceSupported   bool
)

// TraceSupported reports whether this process can open the raw ICMP socket a
// Unix trace needs. It is decided once: the agent's privilege does not change
// while it runs, and a false answer keeps the capability unadvertised.
func TraceSupported() bool {
	traceSupportOnce.Do(func() {
		conn, e := icmp.ListenPacket("ip4:icmp", "0.0.0.0")
		if e != nil {
			return
		}
		_ = conn.Close()
		traceSupported = true
	})
	return traceSupported
}

// TraceTransport gives the durable runner a native raw-ICMP trace transport.
func (n *NativeIO) TraceTransport() (TraceTransport, error) {
	if !TraceSupported() {
		return nil, ErrTraceUnsupported
	}
	var token [2]byte
	if _, e := rand.Read(token[:]); e != nil {
		return nil, e
	}
	return &rawICMPTraceTransport{reader: n.Reader, id: int(binary.BigEndian.Uint16(token[:]))}, nil
}

type rawICMPTraceTransport struct {
	reader networkcontext.Reader
	id     int
}

func (t *rawICMPTraceTransport) interfaceIndex(ctx context.Context, source SourceBinding) (int, error) {
	if source.OSIndex != 0 {
		return int(source.OSIndex), nil
	}
	if t.reader == nil {
		return 0, ErrUnsupportedContext
	}
	section, e := t.reader.Interfaces(ctx, networkcontext.Context{ContextKey: source.ContextKey, Families: []string{"ipv4", "ipv6"}})
	if e != nil {
		return 0, ErrUnsupportedContext
	}
	for _, row := range section.Rows {
		if row.InterfaceKey == source.InterfaceKey && row.OSIndex != 0 {
			return int(row.OSIndex), nil
		}
	}
	return 0, ErrUnsupportedContext
}

// Probe sends one ICMP echo request with the given TTL/hop limit from the
// bound source and waits for the matching Time Exceeded, Echo Reply or
// Destination Unreachable. Replies are matched on the echo identifier,
// sequence and embedded destination, so another process's ICMP traffic on the
// shared raw socket is ignored rather than attributed to this hop.
func (t *rawICMPTraceTransport) Probe(ctx context.Context, ttl, attempt int, destination netip.Addr, source SourceBinding) (TraceReply, error) {
	if ttl < 1 || ttl > TraceMaxHops || attempt < 1 || attempt > TraceMaxProbesPerHop || !destination.IsValid() || !source.Address.IsValid() || destination.Is4() != source.Address.Unmap().Is4() {
		return TraceReply{}, errors.New("trace_probe_invalid")
	}
	index, e := t.interfaceIndex(ctx, source)
	if e != nil {
		return TraceReply{}, e
	}
	v6 := destination.Is6()
	network, protocol := "ip4:icmp", 1
	listen := source.Address.Unmap().String()
	if v6 {
		network, protocol = "ip6:ipv6-icmp", 58
		if source.Address.IsLinkLocalUnicast() {
			listen = source.Address.WithZone(strconv.Itoa(index)).String()
		}
	}
	conn, e := icmp.ListenPacket(network, listen)
	if e != nil {
		return TraceReply{}, ErrTraceUnsupported
	}
	defer func() { _ = conn.Close() }()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()

	sequence := (ttl<<2 | attempt) & 0xffff
	var typ icmp.Type = ipv4.ICMPTypeEcho
	if v6 {
		typ = ipv6.ICMPTypeEchoRequest
	}
	wire, e := (&icmp.Message{Type: typ, Body: &icmp.Echo{ID: t.id, Seq: sequence, Data: make([]byte, 32)}}).Marshal(nil)
	if e != nil {
		return TraceReply{}, e
	}
	target := &net.IPAddr{IP: net.IP(destination.WithZone("").AsSlice())}
	if v6 && destination.IsLinkLocalUnicast() {
		target.Zone = strconv.Itoa(index)
	}
	src := net.IP(source.Address.Unmap().AsSlice())
	if v6 {
		p := conn.IPv6PacketConn()
		if e = p.SetHopLimit(ttl); e != nil {
			return TraceReply{}, ErrTraceUnsupported
		}
		_, e = p.WriteTo(wire, &ipv6.ControlMessage{Src: src, IfIndex: index}, target)
	} else {
		p := conn.IPv4PacketConn()
		if e = p.SetTTL(ttl); e != nil {
			return TraceReply{}, ErrTraceUnsupported
		}
		_, e = p.WriteTo(wire, &ipv4.ControlMessage{Src: src, IfIndex: index}, target)
	}
	if e != nil {
		return TraceReply{}, e
	}
	started := time.Now()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetReadDeadline(deadline)
	}
	buffer := make([]byte, 1500)
	for {
		count, peer, e := conn.ReadFrom(buffer)
		if e != nil {
			if ctx.Err() != nil {
				return TraceReply{}, ctx.Err()
			}
			var netErr net.Error
			if errors.As(e, &netErr) && netErr.Timeout() {
				return TraceReply{}, context.DeadlineExceeded
			}
			return TraceReply{}, e
		}
		kind, ok := matchTraceReply(protocol, buffer[:count], t.id, sequence, destination)
		if !ok {
			continue
		}
		address, ok := peerAddr(peer)
		if !ok {
			continue
		}
		if kind == TraceEchoReply && address != destination.WithZone("") {
			continue
		}
		return TraceReply{Kind: kind, Address: address, RTT: time.Since(started)}, nil
	}
}

func peerAddr(peer net.Addr) (netip.Addr, bool) {
	raw := peer.String()
	if host, _, e := net.SplitHostPort(raw); e == nil {
		raw = host
	}
	address, e := netip.ParseAddr(raw)
	if e != nil {
		return netip.Addr{}, false
	}
	return address.Unmap().WithZone(""), true
}

// matchTraceReply classifies one received ICMP message and reports whether it
// answers this exact probe.
func matchTraceReply(protocol int, packet []byte, id, sequence int, destination netip.Addr) (TraceReplyKind, bool) {
	message, e := icmp.ParseMessage(protocol, packet)
	if e != nil {
		return 0, false
	}
	switch body := message.Body.(type) {
	case *icmp.Echo:
		if (message.Type == ipv4.ICMPTypeEchoReply || message.Type == ipv6.ICMPTypeEchoReply) && body.ID == id && body.Seq == sequence {
			return TraceEchoReply, true
		}
	case *icmp.TimeExceeded:
		if embeddedEchoMatches(body.Data, id, sequence, destination) {
			return TraceTimeExceeded, true
		}
	case *icmp.DstUnreach:
		if embeddedEchoMatches(body.Data, id, sequence, destination) {
			return TraceUnreachable, true
		}
	}
	return 0, false
}

// embeddedEchoMatches checks the original datagram quoted inside an ICMP
// error: it must be our echo request, to our destination, with our id/seq.
func embeddedEchoMatches(data []byte, id, sequence int, destination netip.Addr) bool {
	if len(data) < 1 {
		return false
	}
	switch data[0] >> 4 {
	case 4:
		ihl := int(data[0]&0x0f) * 4
		if ihl < 20 || len(data) < ihl+8 || data[9] != 1 || data[ihl] != 8 {
			return false
		}
		inner, _ := netip.AddrFromSlice(data[16:20])
		return inner == destination.Unmap() && int(binary.BigEndian.Uint16(data[ihl+4:])) == id && int(binary.BigEndian.Uint16(data[ihl+6:])) == sequence
	case 6:
		if len(data) < 48 || data[6] != 58 || data[40] != 128 {
			return false
		}
		inner, _ := netip.AddrFromSlice(data[24:40])
		return inner == destination.WithZone("") && int(binary.BigEndian.Uint16(data[44:])) == id && int(binary.BigEndian.Uint16(data[46:])) == sequence
	}
	return false
}
