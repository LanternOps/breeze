package discovery

import (
	"encoding/hex"
	"net"
	"sort"
	"strconv"
	"strings"

	"github.com/breeze-rmm/agent/internal/snmppoll"
	"github.com/gosnmp/gosnmp"
)

// Port identity normalization (Collection spec §7). Every port reference keeps
// its namespace: interface name, ifIndex, bridge port, LLDP local port number
// and controller port index are different number spaces, and a numeric match
// across them never proves anything. A local port is resolved to an inventory
// interface only through an explicit mapping or a UNIQUE subtype-aware match.

const maxKeyBytes = 255

// InterfaceIdentity is one SNMP interface-inventory entry.
type InterfaceIdentity struct {
	Key           string // name:<ifName> when the name is unique, else if_index:<n>
	IfIndex       uint32
	Name          string
	Alias         string
	PhysAddress   string  // normalized MAC, or "" when not a 6-octet address
	LLDPLocalPort *uint32 // explicit LLDP local port mapping, when known
	BridgePort    *uint32 // from dot1dBasePortIfIndex (explicit, same MIB)
}

// InterfaceColumns are the already-walked inventory tables.
type InterfaceColumns struct {
	IfName          []gosnmp.SnmpPDU
	IfAlias         []gosnmp.SnmpPDU
	IfPhysAddress   []gosnmp.SnmpPDU
	BasePortIfIndex []gosnmp.SnmpPDU
}

// LLDPColumns are the already-walked LLDP-MIB columns.
type LLDPColumns struct {
	RemoteChassisSubtype []gosnmp.SnmpPDU
	RemoteChassis        []gosnmp.SnmpPDU
	RemotePortSubtype    []gosnmp.SnmpPDU
	RemotePort           []gosnmp.SnmpPDU
	RemoteSysName        []gosnmp.SnmpPDU
	RemoteManAddr        []gosnmp.SnmpPDU // lldpRemManAddrIfSubtype rows; the address is in the index
	LocalPortIDSubtype   []gosnmp.SnmpPDU
	LocalPortID          []gosnmp.SnmpPDU
}

// CDPColumns are the already-walked cdpCacheTable columns.
type CDPColumns struct {
	DeviceID    []gosnmp.SnmpPDU
	DevicePort  []gosnmp.SnmpPDU
	Address     []gosnmp.SnmpPDU
	AddressType []gosnmp.SnmpPDU
}

var lldpChassisSubtypes = map[int]string{1: "chassis_component", 2: "interface_alias", 3: "port_component", 4: "mac_address", 5: "network_address", 6: "interface_name", 7: "local"}
var lldpPortSubtypes = map[int]string{1: "interface_alias", 2: "port_component", 3: "mac_address", 4: "network_address", 5: "interface_name", 6: "agent_circuit_id", 7: "local"}

func suffixParts(name, root string) ([]uint32, bool) {
	s := indexSuffix(name, root)
	if s == "" {
		return nil, false
	}
	parts := strings.Split(s, ".")
	out := make([]uint32, len(parts))
	for i, p := range parts {
		n, err := strconv.ParseUint(p, 10, 32)
		if err != nil {
			return nil, false
		}
		out[i] = uint32(n)
	}
	return out, true
}

func pduBytes(p gosnmp.SnmpPDU) []byte {
	switch v := p.Value.(type) {
	case []byte:
		return v
	case string:
		return []byte(v)
	}
	return nil
}

func pduInt(p gosnmp.SnmpPDU) (int, bool) {
	switch p.Value.(type) {
	case nil, []byte, string:
		return 0, false
	}
	return int(gosnmp.ToBigInt(p.Value).Int64()), true
}

func formatMAC(b []byte) string {
	parts := make([]string, 6)
	for i, c := range b {
		parts[i] = hex.EncodeToString([]byte{c})
	}
	return strings.Join(parts, ":")
}

// columnByIndex maps each PDU's dotted index suffix under root to the PDU.
func columnByIndex(pdus []gosnmp.SnmpPDU, root string) map[string]gosnmp.SnmpPDU {
	out := make(map[string]gosnmp.SnmpPDU, len(pdus))
	for _, p := range pdus {
		if s := indexSuffix(p.Name, root); s != "" {
			out[s] = p
		}
	}
	return out
}

func validKey(s string) bool { return s != "" && len(s) <= maxKeyBytes }

// typedID decodes an LLDP chassis/port id by its subtype. Only mac_address is
// formatted as a MAC; a six-octet locally assigned id stays opaque.
func typedID(subtypes map[int]string, subtype int, hasSubtype bool, p gosnmp.SnmpPDU) (TypedID, bool) {
	name, known := subtypes[subtype]
	if !hasSubtype || !known {
		name = "unknown"
	}
	raw := pduBytes(p)
	id := TypedID{Subtype: name, Value: snmpValueToString(p)}
	switch name {
	case "mac_address":
		if len(raw) == 6 {
			id.Value = formatMAC(raw)
		} else {
			id = TypedID{Subtype: "invalid_mac_address", Value: hex.EncodeToString(raw)}
		}
	case "network_address":
		if len(raw) == 5 && raw[0] == 1 {
			id.Value = net.IP(raw[1:]).String()
		} else if len(raw) == 17 && raw[0] == 2 {
			id.Value = net.IP(raw[1:]).String()
		} else {
			id.Value = hex.EncodeToString(raw)
		}
	}
	return id, validKey(id.Value)
}

// BuildInterfaceInventory assembles interface identities, ordered by ifIndex.
func BuildInterfaceInventory(cols InterfaceColumns) []InterfaceIdentity {
	byIndex := map[uint32]*InterfaceIdentity{}
	get := func(i uint32) *InterfaceIdentity {
		if e, ok := byIndex[i]; ok {
			return e
		}
		e := &InterfaceIdentity{IfIndex: i}
		byIndex[i] = e
		return e
	}
	for _, p := range cols.IfName {
		if idx, ok := suffixParts(p.Name, snmppoll.IfNameOID); ok && len(idx) == 1 {
			get(idx[0]).Name = snmpValueToString(p)
		}
	}
	for _, p := range cols.IfAlias {
		if idx, ok := suffixParts(p.Name, snmppoll.IfAliasOID); ok && len(idx) == 1 {
			get(idx[0]).Alias = snmpValueToString(p)
		}
	}
	for _, p := range cols.IfPhysAddress {
		if idx, ok := suffixParts(p.Name, snmppoll.IfPhysAddressOID); ok && len(idx) == 1 {
			e := get(idx[0])
			if b := pduBytes(p); len(b) == 6 {
				e.PhysAddress = formatMAC(b)
			}
		}
	}
	bridgeCount := map[uint32]int{}
	bridgeOf := map[uint32]uint32{}
	for _, p := range cols.BasePortIfIndex {
		idx, ok := suffixParts(p.Name, snmppoll.Dot1dBasePortIfIndexOID)
		ifIndex, okV := pduInt(p)
		if ok && okV && len(idx) == 1 && ifIndex > 0 {
			bridgeCount[uint32(ifIndex)]++
			bridgeOf[uint32(ifIndex)] = idx[0]
		}
	}
	names := map[string]int{}
	for _, e := range byIndex {
		if e.Name != "" {
			names[e.Name]++
		}
	}
	out := make([]InterfaceIdentity, 0, len(byIndex))
	for i, e := range byIndex {
		if bridgeCount[i] == 1 {
			bp := bridgeOf[i]
			e.BridgePort = &bp
		}
		e.Key = "if_index:" + InterfaceRowKey(i)
		if k := "name:" + e.Name; e.Name != "" && names[e.Name] == 1 && len(k) <= maxKeyBytes {
			e.Key = k
		}
		out = append(out, *e)
	}
	sort.Slice(out, func(a, b int) bool { return out[a].IfIndex < out[b].IfIndex })
	return out
}

// uniqueMatch returns the single inventory key satisfying pred, or "".
func uniqueMatch(inv []InterfaceIdentity, pred func(InterfaceIdentity) bool) string {
	key, n := "", 0
	for _, i := range inv {
		if pred(i) {
			key, n = i.Key, n+1
		}
	}
	if n != 1 {
		return ""
	}
	return key
}

// ResolveLLDPLocalPorts maps lldpLocPortNum → interface key through an explicit
// mapping or a unique subtype-aware match (interfaceAlias, macAddress,
// interfaceName). The `local` subtype and bare numbers are never matched to
// ifIndex. A port or interface claimed twice stays unresolved.
func ResolveLLDPLocalPorts(cols LLDPColumns, inv []InterfaceIdentity) map[uint32]string {
	subtypes := map[uint32]int{}
	for _, p := range cols.LocalPortIDSubtype {
		if idx, ok := suffixParts(p.Name, snmppoll.LldpLocPortIDSubtypeOID); ok && len(idx) == 1 {
			if v, ok := pduInt(p); ok {
				subtypes[idx[0]] = v
			}
		}
	}
	candidate := map[uint32]string{}
	for _, i := range inv {
		if i.LLDPLocalPort != nil {
			candidate[*i.LLDPLocalPort] = i.Key
		}
	}
	for _, p := range cols.LocalPortID {
		idx, ok := suffixParts(p.Name, snmppoll.LldpLocPortIDOID)
		if !ok || len(idx) != 1 {
			continue
		}
		port := idx[0]
		if _, explicit := candidate[port]; explicit {
			continue
		}
		raw, text := pduBytes(p), snmpValueToString(p)
		var key string
		switch subtypes[port] {
		case 1: // interfaceAlias
			key = uniqueMatch(inv, func(i InterfaceIdentity) bool { return text != "" && i.Alias == text })
		case 3: // macAddress
			if len(raw) == 6 {
				mac := formatMAC(raw)
				key = uniqueMatch(inv, func(i InterfaceIdentity) bool { return i.PhysAddress == mac })
			}
		case 5: // interfaceName
			key = uniqueMatch(inv, func(i InterfaceIdentity) bool { return text != "" && i.Name == text })
		}
		if key != "" {
			candidate[port] = key
		}
	}
	claims := map[string]int{}
	for _, k := range candidate {
		claims[k]++
	}
	out := map[uint32]string{}
	for port, k := range candidate {
		if claims[k] == 1 {
			out[port] = k
		}
	}
	return out
}

// ParseLLDPV2 joins remote LLDP columns on the full timeMark.localPortNum.remIndex
// tuple and emits localPortNum as an lldp_local port reference.
func ParseLLDPV2(cols LLDPColumns, inventory []InterfaceIdentity) []LldpRow {
	rows, _ := parseLLDPV2(cols, inventory)
	return rows
}

func parseLLDPV2(cols LLDPColumns, inventory []InterfaceIdentity) ([]LldpRow, int) {
	resolved := ResolveLLDPLocalPorts(cols, inventory)
	chassisSub := columnByIndex(cols.RemoteChassisSubtype, snmppoll.LldpRemChassisIDSubtypeOID)
	portSub := columnByIndex(cols.RemotePortSubtype, snmppoll.LldpRemPortIDSubtypeOID)
	ports := columnByIndex(cols.RemotePort, snmppoll.LldpRemPortIDOID)
	names := columnByIndex(cols.RemoteSysName, snmppoll.LldpRemSysNameOID)
	addrs := lldpManagementAddresses(cols.RemoteManAddr)
	byKey := map[string]LldpRow{}
	malformed := 0
	for _, ch := range cols.RemoteChassis {
		idx, ok := suffixParts(ch.Name, snmppoll.LldpRemChassisIDOID)
		if !ok || len(idx) != 3 {
			malformed++
			continue
		}
		suffix := indexSuffix(ch.Name, snmppoll.LldpRemChassisIDOID)
		cs, hasCS := pduInt(chassisSub[suffix])
		chassis, okC := typedID(lldpChassisSubtypes, cs, hasCS, ch)
		portPDU, hasPort := ports[suffix]
		ps, hasPS := pduInt(portSub[suffix])
		port, okP := typedID(lldpPortSubtypes, ps, hasPS, portPDU)
		if !okC || !hasPort || !okP {
			malformed++
			continue
		}
		row := LldpRow{
			RowKey: LldpRowKey(idx[1], idx[2]), TimeMark: idx[0], RemoteIndex: idx[2],
			LocalPort:     PortRef{Namespace: PortNamespaceLLDPLocal, Value: InterfaceRowKey(idx[1])},
			RemoteChassis: chassis, RemotePort: port, RemoteAddresses: addrs[suffix],
		}
		if k, ok := resolved[idx[1]]; ok {
			k := k
			row.LocalPort.ResolvedInterfaceKey = &k
		}
		if n, ok := names[suffix]; ok {
			if s := snmpValueToString(n); validKey(s) {
				row.RemoteSysName = s
			}
		}
		// The same (port, remIndex) under two time marks: keep the newest.
		if prev, dup := byKey[row.RowKey]; !dup || prev.TimeMark < row.TimeMark {
			byKey[row.RowKey] = row
		}
	}
	out := make([]LldpRow, 0, len(byKey))
	for _, r := range byKey {
		out = append(out, r)
	}
	sort.Slice(out, func(a, b int) bool {
		pa, _ := strconv.ParseUint(out[a].LocalPort.Value, 10, 32)
		pb, _ := strconv.ParseUint(out[b].LocalPort.Value, 10, 32)
		if pa != pb {
			return pa < pb
		}
		return out[a].RemoteIndex < out[b].RemoteIndex
	})
	return out, malformed
}

// lldpManagementAddresses decodes lldpRemManAddrTable indexes
// (timeMark.port.remIndex.subtype.len.addr...) into IPs per remote tuple.
func lldpManagementAddresses(pdus []gosnmp.SnmpPDU) map[string][]string {
	sets := map[string]map[string]bool{}
	for _, p := range pdus {
		idx, ok := suffixParts(p.Name, snmppoll.LldpRemManAddrIfSubtypeOID)
		if !ok || len(idx) < 5 || int(idx[4]) != len(idx)-5 {
			continue
		}
		raw := make([]byte, 0, len(idx)-5)
		for _, b := range idx[5:] {
			if b > 255 {
				raw = nil
				break
			}
			raw = append(raw, byte(b))
		}
		var ip string
		switch {
		case idx[3] == 1 && len(raw) == 4, idx[3] == 2 && len(raw) == 16:
			ip = net.IP(raw).String()
		default:
			continue
		}
		key := InterfaceRowKey(idx[0]) + "." + InterfaceRowKey(idx[1]) + "." + InterfaceRowKey(idx[2])
		if sets[key] == nil {
			sets[key] = map[string]bool{}
		}
		sets[key][ip] = true
	}
	out := map[string][]string{}
	for k, set := range sets {
		list := make([]string, 0, len(set))
		for ip := range set {
			list = append(list, ip)
		}
		sort.Strings(list)
		if len(list) > 64 {
			list = list[:64]
		}
		out[k] = list
	}
	return out
}

// ParseCDPV2 keeps the cdpCacheIfIndex as an if_index port and resolves it only
// against the same namespace in the interface inventory.
func ParseCDPV2(cols CDPColumns, inventory []InterfaceIdentity) []CdpRow {
	rows, _ := parseCDPV2(cols, inventory)
	return rows
}

func parseCDPV2(cols CDPColumns, inventory []InterfaceIdentity) ([]CdpRow, int) {
	ports := columnByIndex(cols.DevicePort, snmppoll.CdpCacheDevicePortOID)
	addrs := columnByIndex(cols.Address, snmppoll.CdpCacheAddressOID)
	types := columnByIndex(cols.AddressType, snmppoll.CdpCacheAddressTypeOID)
	byIfIndex := map[uint32]string{}
	for _, i := range inventory {
		byIfIndex[i.IfIndex] = i.Key
	}
	out := []CdpRow{}
	malformed := 0
	for _, d := range cols.DeviceID {
		idx, ok := suffixParts(d.Name, snmppoll.CdpCacheDeviceIDOID)
		if !ok || len(idx) != 2 {
			malformed++
			continue
		}
		suffix := indexSuffix(d.Name, snmppoll.CdpCacheDeviceIDOID)
		device := TypedID{Subtype: "cdp_device_id", Value: snmpValueToString(d)}
		portPDU, hasPort := ports[suffix]
		port := TypedID{Subtype: "interface_name", Value: snmpValueToString(portPDU)}
		if !validKey(device.Value) || !hasPort || !validKey(port.Value) {
			malformed++
			continue
		}
		row := CdpRow{RowKey: CdpRowKey(idx[0], idx[1]), DeviceIndex: idx[1], RemoteDevice: device, RemotePort: port,
			LocalPort: PortRef{Namespace: PortNamespaceIfIndex, Value: InterfaceRowKey(idx[0])}}
		if k, ok := byIfIndex[idx[0]]; ok {
			k := k
			row.LocalPort.ResolvedInterfaceKey = &k
		}
		if a, ok := addrs[suffix]; ok {
			t, hasType := pduInt(types[suffix])
			if raw := pduBytes(a); len(raw) == 4 && (!hasType || t == 1) {
				row.RemoteAddress = net.IP(raw).String()
			}
		}
		out = append(out, row)
	}
	sort.Slice(out, func(a, b int) bool {
		if out[a].LocalPort.Value != out[b].LocalPort.Value {
			x, _ := strconv.ParseUint(out[a].LocalPort.Value, 10, 32)
			y, _ := strconv.ParseUint(out[b].LocalPort.Value, 10, 32)
			return x < y
		}
		return out[a].DeviceIndex < out[b].DeviceIndex
	})
	return out, malformed
}

// interfaceRows renders the inventory as the adjacency `interfaces` section,
// carrying the resolved LLDP local port for each interface.
func interfaceRows(inv []InterfaceIdentity, lldpLocal map[uint32]string) []PhysicalInterfaceRow {
	portOf := map[string]uint32{}
	for port, key := range lldpLocal {
		portOf[key] = port
	}
	out := make([]PhysicalInterfaceRow, 0, len(inv))
	for _, i := range inv {
		row := PhysicalInterfaceRow{RowKey: InterfaceRowKey(i.IfIndex), InterfaceKey: i.Key, IfIndex: i.IfIndex, BridgePort: i.BridgePort, LldpLocalPort: i.LLDPLocalPort}
		if validKey(i.Name) {
			n := i.Name
			row.IfName = &n
		}
		if validKey(i.Alias) {
			a := i.Alias
			row.IfAlias = &a
		}
		if i.PhysAddress != "" {
			m := i.PhysAddress
			row.PhysAddress = &m
		}
		if p, ok := portOf[i.Key]; ok && row.LldpLocalPort == nil {
			row.LldpLocalPort = &p
		}
		out = append(out, row)
	}
	return out
}
