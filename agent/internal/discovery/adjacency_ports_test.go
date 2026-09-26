package discovery

import (
	"reflect"
	"testing"

	"github.com/breeze-rmm/agent/internal/snmppoll"
	"github.com/gosnmp/gosnmp"
)

func octets(oid string, v []byte) gosnmp.SnmpPDU {
	return gosnmp.SnmpPDU{Name: "." + oid, Type: gosnmp.OctetString, Value: v}
}
func integer(oid string, v int) gosnmp.SnmpPDU {
	return gosnmp.SnmpPDU{Name: "." + oid, Type: gosnmp.Integer, Value: v}
}

func TestParseLLDPV2KeepsPortNamespace(t *testing.T) {
	cols := LLDPColumns{
		RemoteChassisSubtype: []gosnmp.SnmpPDU{
			integer(snmppoll.LldpRemChassisIDSubtypeOID+".400.7.1", 4),
			integer(snmppoll.LldpRemChassisIDSubtypeOID+".400.7.2", 4),
		},
		RemoteChassis: []gosnmp.SnmpPDU{
			octets(snmppoll.LldpRemChassisIDOID+".400.7.1", []byte{2, 0, 0, 0, 0, 1}),
			octets(snmppoll.LldpRemChassisIDOID+".400.7.2", []byte{2, 0, 0, 0, 0, 2}),
		},
		RemotePort: []gosnmp.SnmpPDU{
			octets(snmppoll.LldpRemPortIDOID+".400.7.1", []byte("Gi0/1")),
			octets(snmppoll.LldpRemPortIDOID+".400.7.2", []byte("Gi0/2")),
		},
	}
	got := ParseLLDPV2(cols, nil)
	if len(got) != 2 {
		t.Fatalf("lost remote tuple: %#v", got)
	}
	for i, row := range got {
		if row.LocalPort.Namespace != PortNamespaceLLDPLocal || row.LocalPort.Value != "7" || row.LocalPort.ResolvedInterfaceKey != nil {
			t.Fatalf("invented interface mapping: %#v", row.LocalPort)
		}
		if row.TimeMark != 400 || row.RemoteIndex != uint32(i+1) || row.RowKey != LldpRowKey(7, uint32(i+1)) {
			t.Fatalf("timeMark/remoteIndex must be metadata, not port identity: %#v", row)
		}
		if row.RemoteChassis != (TypedID{Subtype: "mac_address", Value: []string{"02:00:00:00:00:01", "02:00:00:00:00:02"}[i]}) {
			t.Fatalf("chassis identity: %#v", row.RemoteChassis)
		}
	}
}

func TestParseLLDPV2TypedIdentities(t *testing.T) {
	const idx = ".0.3.1"
	tests := []struct {
		name        string
		subtype     int
		value       []byte
		wantSubtype string
		wantValue   string
	}{
		{"mac subtype", 4, []byte{2, 0, 0, 0, 0, 0x0a}, "mac_address", "02:00:00:00:00:0a"},
		{"six-byte locally assigned id is not a mac", 7, []byte{2, 0, 0, 0, 0, 0x0a}, "local", "02000000000a"},
		{"mac subtype with wrong length is flagged", 4, []byte{2, 0, 0, 0, 0}, "invalid_mac_address", "0200000000"},
		{"network address ipv4", 5, []byte{1, 192, 0, 2, 7}, "network_address", "192.0.2.7"},
		{"interface name", 6, []byte("Gi0/7"), "interface_name", "Gi0/7"},
		{"unknown subtype", 0, []byte("x1"), "unknown", "x1"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cols := LLDPColumns{
				RemoteChassis: []gosnmp.SnmpPDU{octets(snmppoll.LldpRemChassisIDOID+idx, tt.value)},
				RemotePort:    []gosnmp.SnmpPDU{octets(snmppoll.LldpRemPortIDOID+idx, []byte{2, 0, 0, 0, 0, 9})},
				RemotePortSubtype: []gosnmp.SnmpPDU{
					integer(snmppoll.LldpRemPortIDSubtypeOID+idx, 3),
				},
			}
			if tt.subtype != 0 {
				cols.RemoteChassisSubtype = []gosnmp.SnmpPDU{integer(snmppoll.LldpRemChassisIDSubtypeOID+idx, tt.subtype)}
			}
			got := ParseLLDPV2(cols, nil)
			if len(got) != 1 {
				t.Fatalf("rows: %#v", got)
			}
			if got[0].RemoteChassis != (TypedID{Subtype: tt.wantSubtype, Value: tt.wantValue}) {
				t.Fatalf("chassis = %#v", got[0].RemoteChassis)
			}
			if got[0].RemotePort != (TypedID{Subtype: "mac_address", Value: "02:00:00:00:00:09"}) {
				t.Fatalf("port subtype 3 is a MAC: %#v", got[0].RemotePort)
			}
		})
	}
}

func testInventory() []InterfaceIdentity {
	return BuildInterfaceInventory(InterfaceColumns{
		IfName: []gosnmp.SnmpPDU{
			octets(snmppoll.IfNameOID+".101", []byte("ge-0/0/7")),
			octets(snmppoll.IfNameOID+".102", []byte("dup")),
			octets(snmppoll.IfNameOID+".103", []byte("dup")),
			octets(snmppoll.IfNameOID+".104", []byte("ge-0/0/9")),
			octets(snmppoll.IfNameOID+".105", []byte("ge-0/0/10")),
			octets(snmppoll.IfNameOID+".7", []byte("vlan7")),
		},
		IfAlias:       []gosnmp.SnmpPDU{octets(snmppoll.IfAliasOID+".104", []byte("uplink to core"))},
		IfPhysAddress: []gosnmp.SnmpPDU{octets(snmppoll.IfPhysAddressOID+".105", []byte{2, 0, 0, 0, 1, 5})},
		BasePortIfIndex: []gosnmp.SnmpPDU{
			integer(snmppoll.Dot1dBasePortIfIndexOID+".7", 101),
		},
	})
}

func TestBuildInterfaceInventoryKeys(t *testing.T) {
	inv := testInventory()
	byIndex := map[uint32]InterfaceIdentity{}
	for _, i := range inv {
		byIndex[i.IfIndex] = i
	}
	if byIndex[101].Key != "name:ge-0/0/7" || byIndex[102].Key != "if_index:102" || byIndex[103].Key != "if_index:103" {
		t.Fatalf("unique names key by name, ambiguous names by ifIndex: %#v", inv)
	}
	if byIndex[101].BridgePort == nil || *byIndex[101].BridgePort != 7 {
		t.Fatalf("dot1dBasePortIfIndex is the explicit bridge-port mapping: %#v", byIndex[101])
	}
	if byIndex[7].BridgePort != nil {
		t.Fatal("ifIndex 7 must not inherit bridge port 7 by numeric coincidence")
	}
	if byIndex[105].PhysAddress != "02:00:00:00:01:05" {
		t.Fatalf("phys address: %#v", byIndex[105])
	}
	// Reboot/remap: the same name under a new ifIndex keeps its interface key.
	remapped := BuildInterfaceInventory(InterfaceColumns{IfName: []gosnmp.SnmpPDU{octets(snmppoll.IfNameOID+".2001", []byte("ge-0/0/7"))}})
	if remapped[0].Key != byIndex[101].Key {
		t.Fatalf("interface key churned across ifIndex remap: %q vs %q", remapped[0].Key, byIndex[101].Key)
	}
}

func TestParseLLDPV2ResolvesOnlyUniqueSubtypeAwareMatches(t *testing.T) {
	loc := func(port int, subtype int, v []byte) (gosnmp.SnmpPDU, gosnmp.SnmpPDU) {
		suffix := "." + itoa(port)
		return integer(snmppoll.LldpLocPortIDSubtypeOID+suffix, subtype), octets(snmppoll.LldpLocPortIDOID+suffix, v)
	}
	var cols LLDPColumns
	add := func(port, subtype int, v []byte) {
		st, id := loc(port, subtype, v)
		cols.LocalPortIDSubtype = append(cols.LocalPortIDSubtype, st)
		cols.LocalPortID = append(cols.LocalPortID, id)
		idx := ".0." + itoa(port) + ".1"
		cols.RemoteChassis = append(cols.RemoteChassis, octets(snmppoll.LldpRemChassisIDOID+idx, []byte("peer-"+itoa(port))))
		cols.RemotePort = append(cols.RemotePort, octets(snmppoll.LldpRemPortIDOID+idx, []byte("p")))
	}
	add(7, 5, []byte("ge-0/0/7"))        // interfaceName, unique → resolved
	add(8, 5, []byte("dup"))             // interfaceName, ambiguous → unresolved
	add(9, 7, []byte("101"))             // local id "101" ≠ ifIndex namespace → unresolved
	add(10, 1, []byte("uplink to core")) // interfaceAlias, unique → resolved
	add(11, 3, []byte{2, 0, 0, 0, 1, 5}) // macAddress, unique → resolved
	add(12, 5, []byte("ge-0/0/99"))      // no such interface → unresolved
	want := map[string]*string{"7": strp("name:ge-0/0/7"), "8": nil, "9": nil, "10": strp("name:ge-0/0/9"), "11": strp("name:ge-0/0/10"), "12": nil}
	for _, row := range ParseLLDPV2(cols, testInventory()) {
		exp, ok := want[row.LocalPort.Value]
		if !ok {
			t.Fatalf("unexpected port %q", row.LocalPort.Value)
		}
		if !reflect.DeepEqual(row.LocalPort.ResolvedInterfaceKey, exp) {
			t.Errorf("port %s resolved to %v, want %v", row.LocalPort.Value, deref(row.LocalPort.ResolvedInterfaceKey), deref(exp))
		}
	}
}

func TestParseLLDPV2ManagementAddressesAndMalformedRows(t *testing.T) {
	cols := LLDPColumns{
		RemoteChassis: []gosnmp.SnmpPDU{
			octets(snmppoll.LldpRemChassisIDOID+".0.3.1", []byte("peer")),
			octets(snmppoll.LldpRemChassisIDOID+".0.3.2", []byte("no-port")),
			octets(snmppoll.LldpRemChassisIDOID+".bad", []byte("junk")),
		},
		RemotePort: []gosnmp.SnmpPDU{octets(snmppoll.LldpRemPortIDOID+".0.3.1", []byte("Gi0/1"))},
		RemoteSysName: []gosnmp.SnmpPDU{
			octets(snmppoll.LldpRemSysNameOID+".0.3.1", []byte("core-sw")),
		},
		RemoteManAddr: []gosnmp.SnmpPDU{
			integer(snmppoll.LldpRemManAddrIfSubtypeOID+".0.3.1.1.4.192.0.2.9", 2),
			integer(snmppoll.LldpRemManAddrIfSubtypeOID+".0.3.1.2.16.32.1.13.184.0.0.0.0.0.0.0.0.0.0.0.1", 2),
		},
	}
	rows, malformed := parseLLDPV2(cols, nil)
	if len(rows) != 1 || malformed != 2 {
		t.Fatalf("rows=%#v malformed=%d", rows, malformed)
	}
	if !reflect.DeepEqual(rows[0].RemoteAddresses, []string{"192.0.2.9", "2001:db8::1"}) || rows[0].RemoteSysName != "core-sw" {
		t.Fatalf("remote identity: %#v", rows[0])
	}
}

func TestParseCDPV2KeepsIfIndexNamespace(t *testing.T) {
	cols := CDPColumns{
		DeviceID: []gosnmp.SnmpPDU{
			octets(snmppoll.CdpCacheDeviceIDOID+".7.1", []byte("edge-sw.example.test")),
			octets(snmppoll.CdpCacheDeviceIDOID+".102.4", []byte("phone")),
		},
		DevicePort: []gosnmp.SnmpPDU{
			octets(snmppoll.CdpCacheDevicePortOID+".7.1", []byte("FastEthernet0/3")),
			octets(snmppoll.CdpCacheDevicePortOID+".102.4", []byte("Port 1")),
		},
		AddressType: []gosnmp.SnmpPDU{
			integer(snmppoll.CdpCacheAddressTypeOID+".7.1", 1),
			integer(snmppoll.CdpCacheAddressTypeOID+".102.4", 20),
		},
		Address: []gosnmp.SnmpPDU{
			octets(snmppoll.CdpCacheAddressOID+".7.1", []byte{192, 0, 2, 2}),
			octets(snmppoll.CdpCacheAddressOID+".102.4", []byte{1, 2, 3, 4}),
		},
	}
	rows := ParseCDPV2(cols, testInventory())
	if len(rows) != 2 {
		t.Fatalf("rows: %#v", rows)
	}
	first := rows[0]
	if first.LocalPort.Namespace != PortNamespaceIfIndex || first.LocalPort.Value != "7" || first.RowKey != "7.1" {
		t.Fatalf("CDP cache ifIndex must stay an ifIndex: %#v", first.LocalPort)
	}
	// ifIndex 7 is "vlan7"; bridge port 7 is ifIndex 101. Namespaces never cross.
	if deref(first.LocalPort.ResolvedInterfaceKey) != "name:vlan7" {
		t.Fatalf("resolved = %v", deref(first.LocalPort.ResolvedInterfaceKey))
	}
	if first.RemoteDevice != (TypedID{Subtype: "cdp_device_id", Value: "edge-sw.example.test"}) || first.RemotePort != (TypedID{Subtype: "interface_name", Value: "FastEthernet0/3"}) || first.RemoteAddress != "192.0.2.2" {
		t.Fatalf("remote identity: %#v", first)
	}
	if rows[1].RemoteAddress != "" || deref(rows[1].LocalPort.ResolvedInterfaceKey) != "if_index:102" {
		t.Fatalf("non-IP address type must not become an address: %#v", rows[1])
	}
}

func strp(s string) *string { return &s }
func deref(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}
func itoa(n int) string { return InterfaceRowKey(uint32(n)) }

// The address-length index component is compared without narrowing, so a
// length at the top of the uint32 range can never match a short suffix.
func TestLldpManagementAddresses_RejectsOutOfRangeLength(t *testing.T) {
	got := lldpManagementAddresses([]gosnmp.SnmpPDU{
		integer(snmppoll.LldpRemManAddrIfSubtypeOID+".0.3.1.1.4294967295.192.0.2.9", 2),
		integer(snmppoll.LldpRemManAddrIfSubtypeOID+".0.3.1.1.4.192.0.2.10", 2),
	})
	if len(got) != 1 {
		t.Fatalf("lldpManagementAddresses = %v, want only the well-formed row", got)
	}
	for _, ips := range got {
		if !reflect.DeepEqual(ips, []string{"192.0.2.10"}) {
			t.Fatalf("addresses = %v, want [192.0.2.10]", ips)
		}
	}
}
