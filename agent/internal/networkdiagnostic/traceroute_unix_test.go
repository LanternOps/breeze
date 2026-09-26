//go:build !windows

package networkdiagnostic

import (
	"encoding/binary"
	"net/netip"
	"testing"

	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv4"
	"golang.org/x/net/ipv6"
)

func quotedV4Echo(destination string, id, seq int) []byte {
	header := make([]byte, 28)
	header[0] = 0x45
	header[9] = 1
	dst := netip.MustParseAddr(destination).As4()
	copy(header[16:20], dst[:])
	header[20] = 8
	binary.BigEndian.PutUint16(header[24:], uint16(id))
	binary.BigEndian.PutUint16(header[26:], uint16(seq))
	return header
}

func quotedV6Echo(destination string, id, seq int) []byte {
	header := make([]byte, 48)
	header[0] = 0x60
	header[6] = 58
	dst := netip.MustParseAddr(destination).As16()
	copy(header[24:40], dst[:])
	header[40] = 128
	binary.BigEndian.PutUint16(header[44:], uint16(id))
	binary.BigEndian.PutUint16(header[46:], uint16(seq))
	return header
}

func marshal(t *testing.T, message icmp.Message, v6 bool) []byte {
	t.Helper()
	var psh []byte
	if v6 {
		psh = icmp.IPv6PseudoHeader(netip.MustParseAddr("2001:db8::1").AsSlice(), netip.MustParseAddr("2001:db8::2").AsSlice())
	}
	wire, e := message.Marshal(psh)
	if e != nil {
		t.Fatal(e)
	}
	return wire
}

func TestTraceReplyMatchingIsBoundToTheProbe(t *testing.T) {
	dst := netip.MustParseAddr("192.0.2.3")
	exceeded := marshal(t, icmp.Message{Type: ipv4.ICMPTypeTimeExceeded, Body: &icmp.TimeExceeded{Data: quotedV4Echo("192.0.2.3", 7, 9)}}, false)
	if kind, ok := matchTraceReply(1, exceeded, 7, 9, dst); !ok || kind != TraceTimeExceeded {
		t.Fatal("own time-exceeded not matched")
	}
	for name, packet := range map[string][]byte{
		"other id":          marshal(t, icmp.Message{Type: ipv4.ICMPTypeTimeExceeded, Body: &icmp.TimeExceeded{Data: quotedV4Echo("192.0.2.3", 8, 9)}}, false),
		"other sequence":    marshal(t, icmp.Message{Type: ipv4.ICMPTypeTimeExceeded, Body: &icmp.TimeExceeded{Data: quotedV4Echo("192.0.2.3", 7, 10)}}, false),
		"other destination": marshal(t, icmp.Message{Type: ipv4.ICMPTypeTimeExceeded, Body: &icmp.TimeExceeded{Data: quotedV4Echo("192.0.2.4", 7, 9)}}, false),
		"truncated quote":   marshal(t, icmp.Message{Type: ipv4.ICMPTypeTimeExceeded, Body: &icmp.TimeExceeded{Data: quotedV4Echo("192.0.2.3", 7, 9)[:24]}}, false),
		"echo request":      marshal(t, icmp.Message{Type: ipv4.ICMPTypeEcho, Body: &icmp.Echo{ID: 7, Seq: 9}}, false),
	} {
		if _, ok := matchTraceReply(1, packet, 7, 9, dst); ok {
			t.Fatalf("%s attributed to this probe", name)
		}
	}
	if kind, ok := matchTraceReply(1, marshal(t, icmp.Message{Type: ipv4.ICMPTypeEchoReply, Body: &icmp.Echo{ID: 7, Seq: 9}}, false), 7, 9, dst); !ok || kind != TraceEchoReply {
		t.Fatal("echo reply not matched")
	}
	if kind, ok := matchTraceReply(1, marshal(t, icmp.Message{Type: ipv4.ICMPTypeDestinationUnreachable, Code: 13, Body: &icmp.DstUnreach{Data: quotedV4Echo("192.0.2.3", 7, 9)}}, false), 7, 9, dst); !ok || kind != TraceUnreachable {
		t.Fatal("unreachable not matched")
	}
}

func TestTraceReplyMatchingIPv6(t *testing.T) {
	dst := netip.MustParseAddr("2001:db8::3")
	exceeded := marshal(t, icmp.Message{Type: ipv6.ICMPTypeTimeExceeded, Body: &icmp.TimeExceeded{Data: quotedV6Echo("2001:db8::3", 7, 9)}}, true)
	if kind, ok := matchTraceReply(58, exceeded, 7, 9, dst); !ok || kind != TraceTimeExceeded {
		t.Fatal("IPv6 hop-limit exceeded not matched")
	}
	other := marshal(t, icmp.Message{Type: ipv6.ICMPTypeTimeExceeded, Body: &icmp.TimeExceeded{Data: quotedV6Echo("2001:db8::4", 7, 9)}}, true)
	if _, ok := matchTraceReply(58, other, 7, 9, dst); ok {
		t.Fatal("IPv6 quote for another destination attributed")
	}
}
