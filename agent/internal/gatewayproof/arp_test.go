package gatewayproof

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"net"
	"net/netip"
	"strings"
	"testing"
)

// Synthetic fixture values only (plan index, "Public repository").
var (
	ourMAC = mustMAC("00:1a:8c:00:00:01")
	gwMAC  = mustMAC("a4:2b:b0:11:22:9c")
	src    = netip.MustParseAddr("192.168.1.57")
	gw     = netip.MustParseAddr("192.168.1.1")
)

func mustMAC(s string) net.HardwareAddr {
	mac, err := net.ParseMAC(s)
	if err != nil {
		panic(err)
	}
	return mac
}

func mustHex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

// reply builds a well-formed 60-byte ARP reply from sender (sha, spa) to target (tha, tpa).
func reply(sha net.HardwareAddr, spa netip.Addr, tha net.HardwareAddr, tpa netip.Addr) []byte {
	f := make([]byte, 60)
	copy(f[0:6], tha)
	copy(f[6:12], sha)
	binary.BigEndian.PutUint16(f[12:14], 0x0806)
	binary.BigEndian.PutUint16(f[14:16], 1)
	binary.BigEndian.PutUint16(f[16:18], 0x0800)
	f[18], f[19] = 6, 4
	binary.BigEndian.PutUint16(f[20:22], 2)
	copy(f[22:28], sha)
	s4 := spa.As4()
	copy(f[28:32], s4[:])
	copy(f[32:38], tha)
	t4 := tpa.As4()
	copy(f[38:42], t4[:])
	return f
}

func withOp(frame []byte, op uint16) []byte {
	f := bytes.Clone(frame)
	binary.BigEndian.PutUint16(f[20:22], op)
	return f
}

func withEtherType(frame []byte, et uint16) []byte {
	f := bytes.Clone(frame)
	binary.BigEndian.PutUint16(f[12:14], et)
	return f
}

func withByte(frame []byte, off int, v byte) []byte {
	f := bytes.Clone(frame)
	f[off] = v
	return f
}

// vlanTagged inserts an 802.1Q tag (TPID 0x8100, VID 10) after the source MAC.
func vlanTagged(frame []byte) []byte {
	f := make([]byte, 0, len(frame)+4)
	f = append(f, frame[:12]...)
	f = append(f, 0x81, 0x00, 0x00, 0x0a)
	return append(f, frame[12:]...)
}

func TestEncodeRequest(t *testing.T) {
	want := mustHex("ffffffffffff" + "001a8c000001" + "0806" + "0001" + "0800" + "06" + "04" + "0001" +
		"001a8c000001" + "c0a80139" + "000000000000" + "c0a80101" + strings.Repeat("00", 18))
	if got := encodeRequest(ourMAC, src, gw); !bytes.Equal(got, want) || len(got) != frameLen {
		t.Fatalf("got %x\nwant %x", got, want)
	}
}

func TestDecodeReply(t *testing.T) {
	good := reply(gwMAC, gw, ourMAC, src)
	mac, ok := decodeReply(good, ourMAC, src, gw)
	if !ok || mac.String() != "a4:2b:b0:11:22:9c" {
		t.Fatalf("good reply: %v %v", mac, ok)
	}
	// The returned MAC is a copy: changing the frame afterwards must not change it.
	good[22] = 0xee
	if mac.String() != "a4:2b:b0:11:22:9c" {
		t.Fatalf("returned MAC aliases the frame: %v", mac)
	}
	good = reply(gwMAC, gw, ourMAC, src)
	if _, ok := decodeReply(good[:42], ourMAC, src, gw); !ok {
		t.Fatal("unpadded 42-byte reply rejected")
	}
	for name, frame := range map[string][]byte{
		"request, not reply":        withOp(good, 1),
		"sender is not the gateway": reply(gwMAC, netip.MustParseAddr("192.168.1.2"), ourMAC, src),
		"not addressed to our IP":   reply(gwMAC, gw, ourMAC, netip.MustParseAddr("192.168.1.58")),
		"not addressed to our MAC":  reply(gwMAC, gw, mustMAC("3c:37:86:aa:bb:10"), src),
		"zero sender MAC":           reply(mustMAC("00:00:00:00:00:00"), gw, ourMAC, src),
		"broadcast sender MAC":      reply(mustMAC("ff:ff:ff:ff:ff:ff"), gw, ourMAC, src),
		"multicast sender MAC":      reply(mustMAC("01:00:5e:00:00:01"), gw, ourMAC, src),
		"802.1Q tagged":             vlanTagged(good),
		"IPv4 EtherType":            withEtherType(good, 0x0800),
		"truncated":                 good[:41],
		"htype 6":                   withByte(good, 15, 6),
		"ptype IPv6":                withByte(withByte(good, 16, 0x86), 17, 0xdd),
		"hlen 8":                    withByte(good, 18, 8),
		"plen 16":                   withByte(good, 19, 16),
	} {
		if _, ok := decodeReply(frame, ourMAC, src, gw); ok {
			t.Errorf("%s: accepted", name)
		}
	}
}
