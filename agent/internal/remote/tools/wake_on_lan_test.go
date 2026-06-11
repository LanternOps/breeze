package tools

import (
	"bytes"
	"net"
	"testing"
	"time"
)

func TestMagicPacket_Length(t *testing.T) {
	mac, err := net.ParseMAC("aa:bb:cc:dd:ee:ff")
	if err != nil {
		t.Fatalf("ParseMAC: %v", err)
	}
	pkt, err := MagicPacket(mac)
	if err != nil {
		t.Fatalf("MagicPacket: %v", err)
	}
	if len(pkt) != 102 {
		t.Fatalf("expected 102-byte packet, got %d", len(pkt))
	}
}

func TestMagicPacket_Layout(t *testing.T) {
	mac, _ := net.ParseMAC("aa:bb:cc:dd:ee:ff")
	pkt, err := MagicPacket(mac)
	if err != nil {
		t.Fatal(err)
	}

	wantHeader := []byte{0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF}
	if !bytes.Equal(pkt[:6], wantHeader) {
		t.Errorf("first 6 bytes: got %x, want %x", pkt[:6], wantHeader)
	}

	for i := 0; i < 16; i++ {
		offset := 6 + i*6
		got := pkt[offset : offset+6]
		if !bytes.Equal(got, mac) {
			t.Errorf("repetition #%d at offset %d: got %x, want %x", i, offset, got, mac)
		}
	}
}

func TestMagicPacket_WrongLength(t *testing.T) {
	tooShort := net.HardwareAddr{0xaa, 0xbb}
	if _, err := MagicPacket(tooShort); err == nil {
		t.Error("expected error for 2-byte MAC, got nil")
	}
	eui64 := net.HardwareAddr{0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11}
	if _, err := MagicPacket(eui64); err == nil {
		t.Error("expected error for 8-byte EUI-64, got nil")
	}
}

func TestParseMAC_Formats(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"colon", "aa:bb:cc:dd:ee:ff", "aa:bb:cc:dd:ee:ff"},
		{"hyphen", "AA-BB-CC-DD-EE-FF", "aa:bb:cc:dd:ee:ff"},
		{"cisco-dot", "AABB.CCDD.EEFF", "aa:bb:cc:dd:ee:ff"},
		{"with-spaces", "  aa:bb:cc:dd:ee:ff  ", "aa:bb:cc:dd:ee:ff"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := parseMAC(c.in)
			if err != nil {
				t.Fatalf("parseMAC(%q): %v", c.in, err)
			}
			if got.String() != c.want {
				t.Errorf("parseMAC(%q) = %q, want %q", c.in, got.String(), c.want)
			}
		})
	}
}

func TestParseMAC_Invalid(t *testing.T) {
	cases := []string{
		"",
		"not-a-mac",
		"aa:bb:cc:dd:ee",                // 5 octets
		"00:11:22:33:44:55:66:77",       // EUI-64
		"zz:bb:cc:dd:ee:ff",             // invalid hex
	}
	for _, c := range cases {
		if _, err := parseMAC(c); err == nil {
			t.Errorf("parseMAC(%q) succeeded, expected error", c)
		}
	}
}

func TestWakeOnLan_RequiresBroadcast(t *testing.T) {
	r := WakeOnLan(map[string]any{
		"macs": []any{"aa:bb:cc:dd:ee:ff"},
	})
	if r.Status != "failed" {
		t.Errorf("missing broadcast should fail, got %q", r.Status)
	}
}

func TestWakeOnLan_RejectsIPv6Broadcast(t *testing.T) {
	r := WakeOnLan(map[string]any{
		"broadcast": "fe80::1",
		"macs":      []any{"aa:bb:cc:dd:ee:ff"},
	})
	if r.Status != "failed" {
		t.Errorf("IPv6 broadcast should fail, got %q", r.Status)
	}
}

func TestWakeOnLan_RequiresMacs(t *testing.T) {
	r := WakeOnLan(map[string]any{
		"broadcast": "192.168.1.255",
		"macs":      []any{},
	})
	if r.Status != "failed" {
		t.Errorf("empty macs should fail, got %q", r.Status)
	}
}

func TestWakeOnLan_RejectsInvalidMac(t *testing.T) {
	r := WakeOnLan(map[string]any{
		"broadcast": "192.168.1.255",
		"macs":      []any{"not-a-mac"},
	})
	if r.Status != "failed" {
		t.Errorf("invalid MAC should fail, got %q", r.Status)
	}
}

func TestWakeOnLan_RejectsInvalidPort(t *testing.T) {
	r := WakeOnLan(map[string]any{
		"broadcast": "192.168.1.255",
		"macs":      []any{"aa:bb:cc:dd:ee:ff"},
		"ports":     []any{float64(70000)},
	})
	if r.Status != "failed" {
		t.Errorf("out-of-range port should fail, got %q", r.Status)
	}
}

// TestWakeOnLan_Loopback exercises the full send path against a UDP listener
// on loopback. Sending to 127.0.0.1 verifies the packet bytes traverse the
// UDP socket correctly; the kernel doesn't care that this isn't a real
// broadcast destination for the test.
func TestWakeOnLan_Loopback(t *testing.T) {
	// Listen on 127.0.0.1:0 on a single port so each round/port write hits a
	// known target. We only verify at least one packet arrives — the function
	// fans out across ports 7 & 9 by default; we override to a single port we
	// can bind.
	listener, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket: %v", err)
	}
	defer listener.Close()
	port := listener.LocalAddr().(*net.UDPAddr).Port

	result := WakeOnLan(map[string]any{
		"broadcast":     "127.0.0.1",
		"macs":          []any{"aa:bb:cc:dd:ee:ff"},
		"ports":         []any{float64(port)},
		"wakeAttemptId": "test-attempt",
	})

	if result.Status != "completed" {
		t.Fatalf("WakeOnLan status = %q, want completed; stderr=%q error=%q", result.Status, result.Stderr, result.Error)
	}

	// Expect at least one packet to have arrived; drain whatever is queued.
	buf := make([]byte, 200)
	for i := 0; i < wolPacketRounds; i++ {
		if err := listener.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
			t.Fatalf("SetReadDeadline: %v", err)
		}
		n, _, err := listener.ReadFrom(buf)
		if err != nil {
			if i == 0 {
				t.Fatalf("no magic packet received: %v", err)
			}
			return // first packet sufficient
		}
		if n != wolMagicPacketLen {
			t.Errorf("received %d bytes, want %d", n, wolMagicPacketLen)
		}
		want := []byte{0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF}
		if !bytes.Equal(buf[:6], want) {
			t.Errorf("packet header = %x, want %x", buf[:6], want)
		}
	}
}
