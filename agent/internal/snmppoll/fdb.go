package snmppoll

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/breeze-rmm/agent/internal/topologycanon"
	"github.com/gosnmp/gosnmp"
)

const (
	oidFdbPortColumn     = ".1.3.6.1.2.1.17.4.3.1.2." // dot1dTpFdbPort
	oidBridgePortIfIndex = ".1.3.6.1.2.1.17.1.4.1.2." // dot1dBasePortIfIndex
	oidIfName            = ".1.3.6.1.2.1.31.1.1.1.1." // ifName
)

type FdbRow struct {
	MAC        string
	BridgePort int
}

// macFromOIDSuffix extracts a 6-octet MAC encoded as the dotted-decimal OID
// suffix after columnPrefix. Returns ("", false) if the suffix is not a
// valid 6-octet MAC.
func macFromOIDSuffix(oid, columnPrefix string) (string, bool) {
	norm := oid
	if !strings.HasPrefix(norm, ".") {
		norm = "." + norm
	}
	if !strings.HasPrefix(norm, columnPrefix) {
		return "", false
	}
	suffix := strings.TrimPrefix(norm, columnPrefix)
	parts := strings.Split(suffix, ".")
	if len(parts) != 6 {
		return "", false
	}
	octets := make([]string, 6)
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 || n > 255 {
			return "", false
		}
		octets[i] = fmt.Sprintf("%02x", n)
	}
	return strings.Join(octets, ":"), true
}

// parseFdbPortColumn turns dot1dTpFdbPort PDUs into MAC→bridge-port rows.
func parseFdbPortColumn(pdus []gosnmp.SnmpPDU) []FdbRow {
	rows := make([]FdbRow, 0, len(pdus))
	for _, pdu := range pdus {
		mac, ok := macFromOIDSuffix(pdu.Name, oidFdbPortColumn)
		if !ok {
			continue
		}
		v, hexEncoded := parseValue(pdu)
		if hexEncoded {
			// A hex-encoded value is an octet dump of a binary payload, not a
			// port number, and hex is all-digit often enough to sail through
			// Atoi: an OCTET STRING {0x00,0x05} renders "0005" and would record
			// a phantom bridge port 5, {0x05,0x00} port 500. The hex flag exists
			// to stop exactly this numeric coercion, so drop the row instead.
			continue
		}
		port, ok := toInt(v)
		if !ok || port <= 0 {
			continue
		}
		rows = append(rows, FdbRow{MAC: mac, BridgePort: port})
	}
	return rows
}

// intFromOIDSuffix extracts a single integer encoded as the dotted-decimal OID
// suffix after columnPrefix. Returns (0, false) if the suffix is empty, not a
// single integer component, or outside 0..2147483647: every column indexed this
// way (ifIndex, dot1dBasePort) is an Integer32 index, and a wider value would
// later be narrowed to uint32 and alias a real index.
func intFromOIDSuffix(oid, columnPrefix string) (int, bool) {
	norm := oid
	if !strings.HasPrefix(norm, ".") {
		norm = "." + norm
	}
	if !strings.HasPrefix(norm, columnPrefix) {
		return 0, false
	}
	suffix := strings.TrimPrefix(norm, columnPrefix)
	if suffix == "" || strings.Contains(suffix, ".") {
		return 0, false
	}
	n, err := strconv.ParseUint(suffix, 10, 31)
	if err != nil {
		return 0, false
	}
	return int(n), true
}

// parseBridgePortIfIndex turns dot1dBasePortIfIndex PDUs into bridgePort→ifIndex.
func parseBridgePortIfIndex(pdus []gosnmp.SnmpPDU) map[int]int {
	out := make(map[int]int)
	for _, pdu := range pdus {
		port, ok := intFromOIDSuffix(pdu.Name, oidBridgePortIfIndex)
		if !ok {
			continue
		}
		v, hexEncoded := parseValue(pdu)
		if hexEncoded {
			continue // same numeric-coercion hazard as parseFdbPortColumn
		}
		ifIndex, ok := toInt(v)
		if !ok {
			continue
		}
		out[port] = ifIndex
	}
	return out
}

// parseIfName turns ifName PDUs into ifIndex→ifName.
func parseIfName(pdus []gosnmp.SnmpPDU) map[int]string {
	out := make(map[int]string)
	for _, pdu := range pdus {
		ifIndex, ok := intFromOIDSuffix(pdu.Name, oidIfName)
		if !ok {
			continue
		}
		v, hexEncoded := parseValue(pdu)
		if hexEncoded {
			continue // an octet dump is not an interface name
		}
		name, ok := v.(string)
		if !ok || name == "" {
			continue
		}
		out[ifIndex] = name
	}
	return out
}

// buildPortIfNameMap composes bridgePort→ifIndex and ifIndex→ifName into
// bridgePort→ifName. Bridge ports whose ifIndex has no ifName are omitted.
func buildPortIfNameMap(portIfIndex map[int]int, ifNames map[int]string) map[int]string {
	out := make(map[int]string, len(portIfIndex))
	for port, ifIndex := range portIfIndex {
		if name, ok := ifNames[ifIndex]; ok {
			out[port] = name
		}
	}
	return out
}

// FdbEntry is one assembled bridge-FDB row ready to ride in a DeviceAdjacency.
// Field names/JSON tags map 1:1 onto the locked cross-phase
// FdbEntry { mac; bridgePort; ifName?; vlan? } contract.
type FdbEntry struct {
	MAC        string `json:"mac"`
	BridgePort int    `json:"bridgePort"`
	IfName     string `json:"ifName,omitempty"`
	VLAN       int    `json:"vlan,omitempty"`
}

// AssembleFdbEntries is the legacy scalar-VLAN FDB view, kept as a lossy
// projection of AssembleFdbV2. Q-BRIDGE rows are now included even when the
// BRIDGE table is empty, and because the leading dot1qTpFdbPort index is an FDB
// id (not a VLAN) and this signature carries no dot1qVlanFdbId table, VLAN is
// never set here. Invalid/self rows and port zero are dropped, as before.
func AssembleFdbEntries(fdbPortPDUs, basePortPDUs, ifNamePDUs, qBridgePDUs []gosnmp.SnmpPDU) []FdbEntry {
	names := map[uint32]string{}
	for ifIndex, name := range parseIfName(ifNamePDUs) {
		if ifIndex >= 0 && ifIndex <= math.MaxInt32 {
			names[uint32(ifIndex)] = name
		}
	}
	asm := AssembleFdbV2(FdbTables{
		BridgeContext:        "default",
		Dot1dTpFdbPort:       NewFdbColumn(Dot1dTpFdbPortOID, fdbPortPDUs, topologycanon.Complete, ""),
		Dot1qTpFdbPort:       NewFdbColumn(Dot1qTpFdbPortOID, qBridgePDUs, topologycanon.Complete, ""),
		Dot1dBasePortIfIndex: NewFdbColumn(Dot1dBasePortIfIndexOID, basePortPDUs, topologycanon.Complete, ""),
		IfNames:              names,
	})
	return LegacyFdbEntries(asm.Rows)
}

// LegacyFdbEntries projects V2 rows onto the legacy contract. A scalar VLAN is
// emitted only when the mapping is complete and names exactly one VLAN.
func LegacyFdbEntries(rows []FdbV2Row) []FdbEntry {
	entries := make([]FdbEntry, 0, len(rows))
	for _, r := range rows {
		if r.Status == FdbStatusInvalid || r.Status == FdbStatusSelf || r.BridgePort == 0 {
			continue
		}
		e := FdbEntry{MAC: r.MAC, BridgePort: int(r.BridgePort), IfName: r.IfName}
		if r.VLANMapping == VLANMappingComplete && len(r.VLANs) == 1 {
			e.VLAN = int(r.VLANs[0])
		}
		entries = append(entries, e)
	}
	return entries
}

// toInt coerces a parseValue result (int64/uint64/string) into an int. Callers
// must reject hex-encoded values BEFORE calling it: hex is often all-digit and
// parses cleanly into a wrong number.
func toInt(v any) (int, bool) {
	switch n := v.(type) {
	case int64:
		return int(n), true
	case uint64:
		return int(n), true
	case int:
		return n, true
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(n))
		if err != nil {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}
