package gatewayproof

import (
	"bytes"
	"encoding/binary"
	"net"
	"net/netip"
)

// frameLen is the length of the request frame: the 42 bytes of an Ethernet
// ARP packet padded to the 60-byte Ethernet minimum (without the FCS).
const frameLen = 60

// arpPacketLen is the length of an Ethernet ARP frame without padding.
const arpPacketLen = 42

const (
	etherTypeARP  = 0x0806
	arpHTypeEther = 1
	arpPTypeIPv4  = 0x0800
	arpOpRequest  = 1
	arpOpReply    = 2
)

// encodeRequest builds a broadcast ARP request asking who has target, sent
// from srcMAC/src. tha is zero and the frame is zero-padded to frameLen.
func encodeRequest(srcMAC net.HardwareAddr, src, target netip.Addr) []byte {
	f := make([]byte, frameLen)
	copy(f[0:6], []byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff})
	copy(f[6:12], srcMAC)
	binary.BigEndian.PutUint16(f[12:14], etherTypeARP)
	binary.BigEndian.PutUint16(f[14:16], arpHTypeEther)
	binary.BigEndian.PutUint16(f[16:18], arpPTypeIPv4)
	f[18] = 6
	f[19] = 4
	binary.BigEndian.PutUint16(f[20:22], arpOpRequest)
	copy(f[22:28], srcMAC)
	s4 := src.As4()
	copy(f[28:32], s4[:])
	// f[32:38] (tha) stays zero.
	t4 := target.As4()
	copy(f[38:42], t4[:])
	return f
}

// decodeReply returns the sender MAC of frame when, and only when, frame is an
// untagged Ethernet ARP reply from gateway addressed to srcMAC/src. The MAC is
// a copy; it never aliases frame.
func decodeReply(frame []byte, srcMAC net.HardwareAddr, src, gateway netip.Addr) (net.HardwareAddr, bool) {
	if len(frame) < arpPacketLen || len(srcMAC) != 6 || !src.Is4() || !gateway.Is4() {
		return nil, false
	}
	// An 802.1Q tag puts 0x8100 here, so a tagged frame never matches.
	if binary.BigEndian.Uint16(frame[12:14]) != etherTypeARP ||
		binary.BigEndian.Uint16(frame[14:16]) != arpHTypeEther ||
		binary.BigEndian.Uint16(frame[16:18]) != arpPTypeIPv4 ||
		frame[18] != 6 || frame[19] != 4 ||
		binary.BigEndian.Uint16(frame[20:22]) != arpOpReply {
		return nil, false
	}
	sha := frame[22:28]
	spa := netip.AddrFrom4([4]byte(frame[28:32]))
	tha := frame[32:38]
	tpa := netip.AddrFrom4([4]byte(frame[38:42]))
	if spa != gateway || tpa != src || !bytes.Equal(tha, srcMAC) {
		return nil, false
	}
	if !usableUnicastMAC(sha) {
		return nil, false
	}
	return bytes.Clone(sha), true
}

// usableUnicastMAC reports whether mac is a 6-byte address that is neither all
// zeros nor group-addressed (broadcast is a group address).
func usableUnicastMAC(mac []byte) bool {
	if len(mac) != 6 || mac[0]&0x01 != 0 {
		return false
	}
	for _, b := range mac {
		if b != 0 {
			return true
		}
	}
	return false
}
