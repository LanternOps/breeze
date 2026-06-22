package discovery

import (
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
