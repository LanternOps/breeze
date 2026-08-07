package discovery

import (
	"strings"
	"testing"
	"time"

	"github.com/gosnmp/gosnmp"
)

func pdu(name string, v interface{}, t gosnmp.Asn1BER) gosnmp.SnmpPDU {
	return gosnmp.SnmpPDU{Name: name, Value: v, Type: t}
}

func TestParseLLDPNeighbors(t *testing.T) {
	chassis := []gosnmp.SnmpPDU{
		pdu(".1.0.8802.1.1.2.1.4.1.1.5.0.1.1", []byte{0x00, 0x11, 0x22, 0x33, 0x44, 0x55}, gosnmp.OctetString),
	}
	portID := []gosnmp.SnmpPDU{
		pdu(".1.0.8802.1.1.2.1.4.1.1.7.0.1.1", []byte("Gi0/1"), gosnmp.OctetString),
	}
	sysName := []gosnmp.SnmpPDU{
		pdu(".1.0.8802.1.1.2.1.4.1.1.9.0.1.1", []byte("core-sw"), gosnmp.OctetString),
	}
	got := parseLLDPNeighbors(chassis, portID, sysName)
	if len(got) != 1 {
		t.Fatalf("expected 1 neighbor, got %d", len(got))
	}
	n := got[0]
	if n.RemoteChassisID != "00:11:22:33:44:55" {
		t.Errorf("chassis id = %q", n.RemoteChassisID)
	}
	if n.RemotePortID != "Gi0/1" {
		t.Errorf("remote port = %q", n.RemotePortID)
	}
	if n.RemoteSysName != "core-sw" {
		t.Errorf("sys name = %q", n.RemoteSysName)
	}
	if n.LocalPort != "0.1" {
		t.Errorf("local port (lldp index prefix) = %q", n.LocalPort)
	}
}

// lldpRemPortId with portIdSubtype = macAddress(3) is a raw 6-octet MAC — the
// exact payload behind the production insert failure. It must arrive as hex, not
// as a raw cast carrying a NUL, and ordinary text columns must stay untouched.
func TestParseLLDPNeighborsSanitizesRawOctetStrings(t *testing.T) {
	tests := []struct {
		name        string
		portID      any
		sysName     any
		wantPortID  string
		wantSysName string
	}{
		{
			name:        "mac_portid_with_nul_becomes_hex",
			portID:      []byte{0x78, 0x8a, 0x20, 0x00, 0xd4, 0xe1},
			sysName:     []byte("core-sw"),
			wantPortID:  "788a2000d4e1",
			wantSysName: "core-sw",
		},
		{
			name:        "invalid_utf8_sysname_becomes_hex",
			portID:      []byte("Gi0/1"),
			sysName:     []byte{0xff, 0xfe, 0x41},
			wantPortID:  "Gi0/1",
			wantSysName: "fffe41",
		},
		{
			name:        "nul_padded_sysname_recovers_to_text",
			portID:      []byte("Gi0/1"),
			sysName:     []byte("switch-01\x00"),
			wantPortID:  "Gi0/1",
			wantSysName: "switch-01",
		},
		{
			// lldpRemPortId of an unconfigured/zeroed neighbour port. It must
			// stay a flagged hex dump, not become the empty string that reads
			// as "the neighbour reported no port".
			name:        "all_nul_portid_becomes_hex",
			portID:      []byte{0x00, 0x00, 0x00, 0x00, 0x00, 0x00},
			sysName:     []byte("core-sw"),
			wantPortID:  "000000000000",
			wantSysName: "core-sw",
		},
		{
			// A real MAC whose last two octets are NUL: trimming first would
			// store "Test" and drop two octets with no marker.
			name:        "mac_portid_with_printable_prefix_and_trailing_nuls_stays_hex",
			portID:      []byte{0x54, 0x65, 0x73, 0x74, 0x00, 0x00},
			sysName:     []byte("core-sw"),
			wantPortID:  "546573740000",
			wantSysName: "core-sw",
		},
		{
			name:        "invalid_utf8_sysname_with_trailing_nul_hexes_original_bytes",
			portID:      []byte("Gi0/1"),
			sysName:     []byte{0xff, 0xfe, 0x41, 0x00},
			wantPortID:  "Gi0/1",
			wantSysName: "fffe4100",
		},
		{
			name:        "nul_padded_sysname_with_two_nuls_recovers_to_text",
			portID:      []byte("Gi0/1"),
			sysName:     []byte("switch-01\x00\x00"),
			wantPortID:  "Gi0/1",
			wantSysName: "switch-01",
		},
		{
			name:        "nbsp_sysname_unchanged",
			portID:      []byte("Gi0/1"),
			sysName:     []byte("core\u00a0sw"),
			wantPortID:  "Gi0/1",
			wantSysName: "core\u00a0sw",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			chassis := []gosnmp.SnmpPDU{
				pdu(".1.0.8802.1.1.2.1.4.1.1.5.0.1.1", []byte{0x00, 0x11, 0x22, 0x33, 0x44, 0x55}, gosnmp.OctetString),
			}
			portID := []gosnmp.SnmpPDU{pdu(".1.0.8802.1.1.2.1.4.1.1.7.0.1.1", tt.portID, gosnmp.OctetString)}
			sysName := []gosnmp.SnmpPDU{pdu(".1.0.8802.1.1.2.1.4.1.1.9.0.1.1", tt.sysName, gosnmp.OctetString)}

			got := parseLLDPNeighbors(chassis, portID, sysName)
			if len(got) != 1 {
				t.Fatalf("expected 1 neighbor, got %d", len(got))
			}
			if got[0].RemotePortID != tt.wantPortID {
				t.Errorf("RemotePortID = %q, want %q", got[0].RemotePortID, tt.wantPortID)
			}
			if got[0].RemoteSysName != tt.wantSysName {
				t.Errorf("RemoteSysName = %q, want %q", got[0].RemoteSysName, tt.wantSysName)
			}
			// The chassis id keeps its colon-separated MAC formatting — that
			// path knows it is formatting a MAC and is deliberately different
			// from the unseparated hex fallback.
			if got[0].RemoteChassisID != "00:11:22:33:44:55" {
				t.Errorf("RemoteChassisID = %q, want colon-separated MAC", got[0].RemoteChassisID)
			}
			for _, v := range []string{got[0].RemotePortID, got[0].RemoteSysName} {
				if strings.ContainsRune(v, 0) {
					t.Errorf("%q contains a NUL byte", v)
				}
			}
		})
	}
}

// macFromBytes falls back to snmpValueToString when the payload is not exactly
// 6 bytes, so that fallback must be sanitised too.
func TestMacFromBytesNonSixByteFallbackIsSanitized(t *testing.T) {
	got := macFromBytes(pdu(".1.0.8802.1.1.2.1.4.1.1.5.0.1.1", []byte{0x78, 0x8a, 0x00, 0xd4, 0xe1}, gosnmp.OctetString))
	if got != "788a00d4e1" {
		t.Errorf("macFromBytes(5-byte payload) = %q, want %q", got, "788a00d4e1")
	}
}

// ipFromBytes falls back the same way when the address is not 4 bytes.
func TestIPFromBytesNonFourByteFallbackIsSanitized(t *testing.T) {
	got := ipFromBytes(pdu(".1.3.6.1.4.1.9.9.23.1.2.1.1.4.3.1", []byte{0x20, 0x01, 0x00, 0x0d, 0xb8}, gosnmp.OctetString))
	if got != "2001000db8" {
		t.Errorf("ipFromBytes(non-IPv4 payload) = %q, want %q", got, "2001000db8")
	}
}

func TestParseCDPNeighborsSanitizesRawDeviceID(t *testing.T) {
	deviceID := []gosnmp.SnmpPDU{pdu(".1.3.6.1.4.1.9.9.23.1.2.1.1.6.3.1", []byte{0x78, 0x8a, 0x20, 0x00, 0xd4, 0xe1}, gosnmp.OctetString)}
	got := parseCDPNeighbors(deviceID, nil, nil)
	if len(got) != 1 {
		t.Fatalf("expected 1 cdp neighbor, got %d", len(got))
	}
	if got[0].RemoteDeviceID != "788a2000d4e1" {
		t.Errorf("RemoteDeviceID = %q, want %q", got[0].RemoteDeviceID, "788a2000d4e1")
	}
}

func TestParseLLDPNeighborsSkipsRowsWithoutChassis(t *testing.T) {
	got := parseLLDPNeighbors(nil, nil, nil)
	if len(got) != 0 {
		t.Fatalf("expected 0 neighbors, got %d", len(got))
	}
}

func TestParseCDPNeighbors(t *testing.T) {
	deviceID := []gosnmp.SnmpPDU{pdu(".1.3.6.1.4.1.9.9.23.1.2.1.1.6.3.1", []byte("edge-sw.acme"), gosnmp.OctetString)}
	devicePort := []gosnmp.SnmpPDU{pdu(".1.3.6.1.4.1.9.9.23.1.2.1.1.7.3.1", []byte("FastEthernet0/3"), gosnmp.OctetString)}
	address := []gosnmp.SnmpPDU{pdu(".1.3.6.1.4.1.9.9.23.1.2.1.1.4.3.1", []byte{10, 0, 0, 2}, gosnmp.OctetString)}
	got := parseCDPNeighbors(deviceID, devicePort, address)
	if len(got) != 1 {
		t.Fatalf("expected 1 cdp neighbor, got %d", len(got))
	}
	if got[0].RemoteDeviceID != "edge-sw.acme" {
		t.Errorf("device id = %q", got[0].RemoteDeviceID)
	}
	if got[0].RemotePortID != "FastEthernet0/3" {
		t.Errorf("device port = %q", got[0].RemotePortID)
	}
	if got[0].RemoteAddress != "10.0.0.2" {
		t.Errorf("address = %q", got[0].RemoteAddress)
	}
}

func TestCollectAdjacencyFiltersAndStubs(t *testing.T) {
	orig := collectAdjacencyFor
	t.Cleanup(func() { collectAdjacencyFor = orig })

	collectAdjacencyFor = func(ip string, communities []string, timeout time.Duration) DeviceAdjacency {
		if ip == "10.0.0.1" {
			return DeviceAdjacency{
				SourceDeviceIP: ip,
				Lldp:           []LldpNeighbor{{LocalPort: "1", RemoteChassisID: "aa:bb:cc:dd:ee:ff", RemotePortID: "Gi0/1"}},
				Cdp:            []CdpNeighbor{},
				Fdb:            []FdbEntry{},
			}
		}
		return DeviceAdjacency{SourceDeviceIP: ip, Lldp: []LldpNeighbor{}, Cdp: []CdpNeighbor{}, Fdb: []FdbEntry{}}
	}

	s := NewScanner(ScanConfig{SNMPCommunities: []string{"public"}})
	hosts := []DiscoveredHost{
		{IP: "10.0.0.1", Methods: []string{"snmp"}, SNMPData: &SNMPInfo{SysName: "core"}},
		{IP: "10.0.0.2", Methods: []string{"snmp"}, SNMPData: &SNMPInfo{SysName: "edge"}}, // no neighbors → dropped
		{IP: "10.0.0.3", Methods: []string{"ping"}},                                       // not snmp → skipped
	}
	got := s.CollectAdjacency(hosts)
	if len(got) != 1 {
		t.Fatalf("expected 1 adjacency block, got %d", len(got))
	}
	if got[0].SourceDeviceIP != "10.0.0.1" || len(got[0].Lldp) != 1 {
		t.Fatalf("unexpected adjacency: %+v", got[0])
	}
}
