package snmppoll

import (
	"bytes"
	"encoding/hex"
	"errors"
	"math/big"
	"time"
	"unicode"
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

// parseValue converts SNMP PDUs into Go-friendly values, plus an encoding flag:
// hexEncoded is true only when an octet string had to be rendered as hex because
// it was not storable as text.
//
// The flag is not optional bookkeeping — every caller has to decide what to do
// with a value that is an octet dump rather than the payload's own text. fdb.go
// drops such rows precisely because "0005" would otherwise coerce to bridge port
// 5 (see parseFdbPortColumn). A flagless wrapper existed here and had no
// non-test callers, so it was removed rather than left to tempt the next caller
// into the coercion it hides.
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
// The order of the three steps is the whole point. The payload is tested BEFORE
// anything is trimmed, so trimming can only ever RECOVER a payload that would
// otherwise be hexed; it can never turn a binary payload into a plausible string.
// Trimming first let the trim — not the payload — decide the outcome, which
// silently returned "" for an all-NUL MAC and "Test" for the MAC
// 54 65 73 74 00 00.
func octetStringToText(value []byte) (string, bool) {
	// 1. Storable as-is. Nothing is trimmed: a payload that passes this test has
	//    no NUL, so it has no padding to remove. Empty stays "".
	if isTextSafeOctetString(value) {
		return string(value), false
	}
	// 2. Not storable, but it may be a C-style NUL-padded text field.
	if text, ok := nulPaddedText(value); ok {
		return text, false
	}
	// 3. Binary. Hex the ORIGINAL bytes — a MAC ending in 0x00 must keep that
	//    octet, so this must never be handed a trimmed slice.
	return hexOctets(value), true
}

// binaryIdentifierWidths are the octet counts this codebase already treats as
// fixed-width binary identifiers rather than text: 4 (IPv4) and 6 (MAC/EUI-48),
// the same two widths discovery/adjacency.go's ipFromBytes and macFromBytes
// recognise. See nulPaddedText for why the length matters.
var binaryIdentifierWidths = map[int]bool{4: true, 6: true}

// nulPaddedText recovers the text of a C-style NUL-padded fixed-width field —
// "switch-01\x00\x00" is a clean name, not binary — and reports false for
// everything else.
//
// The rule, and it is a judgement call because the two cases are not separable
// from the bytes alone:
//
//	Trim only when ALL of these hold —
//	  a. every NUL is trailing (an interior NUL means binary, not padding);
//	  b. something is left after the padding (an all-NUL payload is a zeroed
//	     MAC/chassis id, routine on fresh hardware, NOT an empty string);
//	  c. that remainder is affirmatively text — valid UTF-8 with no control
//	     characters other than tab/CR/LF. This is deliberately stricter than
//	     isTextSafeOctetString: an untrimmed payload only has to be *storable*
//	     because it is returned unchanged, but a payload we are about to
//	     shorten has to prove it is a text field;
//	  d. the payload is not exactly a binary-identifier width (4 or 6).
//
// (d) is the tie-breaker for the genuinely ambiguous case. 54 65 73 74 00 00 is
// a valid MAC (0x54 is a real OUI prefix) AND a valid 6-byte buffer holding
// "Test" — no predicate can tell them apart. The ambiguity is resolved toward
// hex because the two failure modes are not symmetric: hexing a real name is
// lossless and carries the hex flag, while trimming a real MAC destroys octets
// and is indistinguishable from a device that reported that string.
//
// Limits, stated plainly:
//   - Text NUL-padded to exactly 4 or 6 octets ("Gi0/5\x00") is hexed. Recoverable
//     and flagged, but it will read as an octet dump.
//   - A binary payload of some other width whose non-NUL prefix happens to be
//     entirely printable UTF-8 (e.g. 7 bytes "ABCDE" + 00 00) is still trimmed to
//     text. Unresolvable without knowing the OID's syntax; it needs ~5 printable
//     octets in a row to occur, which is why the width rule targets the short
//     fixed-width identifiers where that is most likely.
func nulPaddedText(value []byte) (string, bool) {
	head := bytes.TrimRight(value, "\x00")
	if len(head) == 0 || len(head) == len(value) {
		// (b) entirely NUL, or (a) the NUL is not trailing at all.
		return "", false
	}
	if binaryIdentifierWidths[len(value)] {
		return "", false // (d)
	}
	if !isPaddedTextPayload(head) {
		return "", false // (a) interior NUL, or (c) not text
	}
	return string(head), true
}

// isPaddedTextPayload reports whether the non-NUL remainder of a NUL-padded
// payload looks like a text field: valid UTF-8 with no control characters beyond
// tab, CR and LF. NUL is itself a control character, so an interior NUL fails
// here too. Everything Postgres stores happily but that is not a control
// character — NBSP, the BOM, soft hyphen, ideographic space — still passes.
func isPaddedTextPayload(head []byte) bool {
	if !utf8.Valid(head) {
		return false
	}
	for _, r := range string(head) {
		if unicode.IsControl(r) && r != '\t' && r != '\n' && r != '\r' {
			return false
		}
	}
	return true
}

// isTextSafeOctetString reports whether the payload can be stored verbatim in a
// Postgres `text` column. That is exactly two conditions: valid UTF-8, and no
// NUL byte.
//
// It is always asked about the payload as received, never about a trimmed copy —
// trimming first makes the trim decide the answer. Payloads it rejects get a
// second, stricter look from nulPaddedText.
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

// hexOctets renders bytes as lowercase hex with no separator. Named rather than
// inlined so the callers above read as intent ("hex the original bytes") and so
// the unseparated-vs-colon rationale in OctetStringToText has something to point
// at.
func hexOctets(value []byte) string {
	return hex.EncodeToString(value)
}

func getDevicePDUs(client *SNMPClient, oids []string) ([]gosnmp.SnmpPDU, error) {
	return client.GetMulti(oids)
}
