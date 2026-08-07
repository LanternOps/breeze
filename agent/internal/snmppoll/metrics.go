package snmppoll

import (
	"bytes"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gosnmp/gosnmp"
)

// ValueEncodingHex is the SNMPMetric.ValueEncoding marker for a value the agent
// hex-encoded because the raw octet string could not be stored as text. Without
// it the API cannot tell a hexed MAC ("001122304050") from a device that
// genuinely reported that string, and all-digit hex gets swept into numeric
// metric rollups.
const ValueEncodingHex = "hex"

// SNMPDevice defines the target and credentials for polling.
type SNMPDevice struct {
	IP             string
	Port           uint16
	Version        SNMPVersion
	Auth           SNMPAuth
	OIDs           []string
	Timeout        time.Duration
	Retries        int
	MaxRepetitions uint32
}

// SNMPMetric represents a single SNMP value read.
//
// ValueEncoding declares how Value was encoded by the agent. It is set to
// ValueEncodingHex only for octet strings the agent had to hex-encode, and is
// omitted otherwise: `omitempty` keeps the wire format backward-compatible in
// both directions (older APIs ignore the unknown field, older agents simply
// never send it).
type SNMPMetric struct {
	OID           string    `json:"oid"`
	Name          string    `json:"name"`
	Value         any       `json:"value"`
	Timestamp     time.Time `json:"timestamp"`
	ValueEncoding string    `json:"valueEncoding,omitempty"`
}

// CollectMetrics fetches all configured OIDs for a device.
func CollectMetrics(device SNMPDevice) ([]SNMPMetric, error) {
	if device.IP == "" {
		return nil, errors.New("device IP is required")
	}
	if len(device.OIDs) == 0 {
		return nil, errors.New("device has no OIDs configured")
	}

	client, err := NewClient(device.ClientConfig())
	if err != nil {
		return nil, err
	}
	defer client.Close()

	pdus, err := getDevicePDUs(client, device.OIDs)
	if err != nil {
		return nil, err
	}

	return buildMetrics(pdus, time.Now().UTC()), nil
}

// buildMetrics maps varbinds onto SNMPMetric rows, declaring the encoding at the
// same place the value is produced.
func buildMetrics(pdus []gosnmp.SnmpPDU, stamp time.Time) []SNMPMetric {
	metrics := make([]SNMPMetric, 0, len(pdus))
	for _, pdu := range pdus {
		value, hexEncoded := parseValue(pdu)
		metric := SNMPMetric{
			OID:       pdu.Name,
			Name:      pdu.Name,
			Value:     value,
			Timestamp: stamp,
		}
		if hexEncoded {
			metric.ValueEncoding = ValueEncodingHex
		}
		metrics = append(metrics, metric)
	}
	return metrics
}

// ClientConfig converts an SNMPDevice into an SNMPClientConfig.
func (d SNMPDevice) ClientConfig() SNMPClientConfig {
	return SNMPClientConfig{
		Target:         d.IP,
		Port:           d.Port,
		Version:        d.Version,
		Auth:           d.Auth,
		Timeout:        d.Timeout,
		Retries:        d.Retries,
		MaxRepetitions: d.MaxRepetitions,
	}
}

// ParseValue converts SNMP PDUs into Go-friendly values.
//
// The signature is load-bearing for external callers; use parseValue when you
// also need to know whether the value was hex-encoded.
func ParseValue(pdu gosnmp.SnmpPDU) any {
	value, _ := parseValue(pdu)
	return value
}

// parseValue is ParseValue plus the encoding flag: hexEncoded is true only when
// an octet string had to be rendered as hex because it was not storable as text.
func parseValue(pdu gosnmp.SnmpPDU) (value any, hexEncoded bool) {
	if pdu.Value == nil {
		return nil, false
	}

	switch v := pdu.Value.(type) {
	case string:
		return v, false
	case []byte:
		return octetStringToText(v)
	case *big.Int:
		return bigIntValue(v), false
	default:
		bi := gosnmp.ToBigInt(v)
		if bi == nil {
			return nil, false
		}
		return bigIntValue(bi), false
	}
}

// bigIntValue narrows a big.Int to the tightest Go integer type, falling back to
// its decimal string when it fits in neither int64 nor uint64.
func bigIntValue(v *big.Int) any {
	if v.IsInt64() {
		return v.Int64()
	}
	if v.Sign() >= 0 && v.BitLen() <= 64 {
		return v.Uint64()
	}
	return v.String()
}

// OctetStringToText renders an SNMP OCTET STRING payload as a value that is
// safe to ship as JSON and store in a Postgres `text` column.
//
// Most octet strings are ordinary text (sysDescr, sysName, ifDescr) and are
// returned verbatim. Some agents, however, answer bridge/FDB OIDs
// (dot1dBaseBridgeAddress .1.3.6.1.2.1.17.1.1.0, dot1dTpFdbAddress
// .1.3.6.1.2.1.17.4.3.1.1.*) or lldpRemPortId with portIdSubtype macAddress(3)
// with a raw 6-octet MAC. A raw cast of those bytes smuggles a NUL into the
// payload and Postgres rejects the insert with SQLSTATE 22021,
// `invalid byte sequence for encoding "UTF8": 0x00` — observed in production
// against a UniFi USW-24-PoE. Such payloads are returned as lowercase hex
// instead (e.g. "788a20c3d4e1").
//
// NOTE: NUL is the only byte that ever produced that insert failure. Invalid
// UTF-8 never reached Postgres intact — Go's json.Marshal silently replaces
// invalid sequences with U+FFFD — so it corrupted the value rather than failing
// the write. It is hexed here to keep such payloads recoverable, not to prevent
// an error.
//
// The hex form here is deliberately unseparated, unlike macFromOIDSuffix in
// fdb.go and macFromBytes in discovery/adjacency.go, which emit colon-separated
// MACs ("78:8a:20:c3:d4:e1"). Those two know they are formatting a MAC; this
// function does not know what the bytes mean, so it emits a plain octet dump and
// leaves interpretation to the consumer. Callers that want a MAC should use the
// MAC formatters, not this one.
func OctetStringToText(value []byte) string {
	text, _ := octetStringToText(value)
	return text
}

// octetStringToText is OctetStringToText plus a flag reporting whether the
// result is hex rather than the payload's own text.
//
// Trailing NULs are trimmed before the safety test: C-based SNMP agents commonly
// NUL-pad fixed-width fields, and "switch-01\x00" is a clean name, not binary.
// Interior NULs are left alone — those genuinely mean the payload is binary.
func octetStringToText(value []byte) (string, bool) {
	trimmed := bytes.TrimRight(value, "\x00")
	if isTextSafeOctetString(trimmed) {
		return string(trimmed), false
	}
	// Hex the ORIGINAL bytes so the trimmed padding stays recoverable.
	return hexOctets(value), true
}

// isTextSafeOctetString reports whether the payload can be stored verbatim in a
// Postgres `text` column. That is exactly two conditions: valid UTF-8, and no
// NUL byte.
//
// Nothing else is rejected. NBSP (U+00A0), the BOM (U+FEFF), soft hyphen
// (U+00AD), ideographic space (U+3000), tabs, newlines and ordinary control
// bytes are all stored fine by Postgres and must survive unchanged — a stricter
// predicate (unicode.IsPrint, say) hexes the whole string over one invisible
// byte, which also breaks the substring matching that discovery/classify.go runs
// against SysDescr to determine device type.
func isTextSafeOctetString(value []byte) bool {
	return utf8.Valid(value) && bytes.IndexByte(value, 0) < 0
}

// hexOctets renders bytes as lowercase hex with no separator.
func hexOctets(value []byte) string {
	var sb strings.Builder
	sb.Grow(len(value) * 2)
	for _, b := range value {
		fmt.Fprintf(&sb, "%02x", b)
	}
	return sb.String()
}

func getDevicePDUs(client *SNMPClient, oids []string) ([]gosnmp.SnmpPDU, error) {
	return client.GetMulti(oids)
}
