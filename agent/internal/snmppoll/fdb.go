package snmppoll

import (
	"fmt"
	"strconv"
	"strings"

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
		v := ParseValue(pdu)
		port, ok := toInt(v)
		if !ok || port <= 0 {
			continue
		}
		rows = append(rows, FdbRow{MAC: mac, BridgePort: port})
	}
	return rows
}

// intFromOIDSuffix extracts a single integer encoded as the dotted-decimal OID
// suffix after columnPrefix. Returns (0, false) if the suffix is empty or not a
// single integer component.
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
	n, err := strconv.Atoi(suffix)
	if err != nil {
		return 0, false
	}
	return n, true
}

// parseBridgePortIfIndex turns dot1dBasePortIfIndex PDUs into bridgePort→ifIndex.
func parseBridgePortIfIndex(pdus []gosnmp.SnmpPDU) map[int]int {
	out := make(map[int]int)
	for _, pdu := range pdus {
		port, ok := intFromOIDSuffix(pdu.Name, oidBridgePortIfIndex)
		if !ok {
			continue
		}
		ifIndex, ok := toInt(ParseValue(pdu))
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
		name, ok := ParseValue(pdu).(string)
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

// toInt coerces a ParseValue result (int64/uint64/string) into an int.
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
