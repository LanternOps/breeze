package snmppoll

import (
	"bytes"
	"encoding/hex"
	"errors"
	"log/slog"
	"math/big"
	"net"
	"strings"
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
	IP      string
	Port    uint16
	Version SNMPVersion
	Auth    SNMPAuth
	// OIDs is the legacy flat list. Kept verbatim: it is what pre-W02 servers
	// send and what SpecsFromOIDs falls back to.
	OIDs []string
	// Specs is the per-OID acquisition plan (spec §7.1). When empty,
	// CollectMetrics derives it from OIDs as plain GETs.
	Specs []OIDSpec
	// Limits bounds one poll. The zero value is replaced with
	// DefaultPollLimits by CollectMetrics.
	Limits         PollLimits
	Timeout        time.Duration
	Retries        int
	MaxRepetitions uint32
}

// SNMPMetric represents a single SNMP value read.
//
// BaseOID and Instance split what used to be one opaque OID string. BaseOID is
// the TEMPLATE's own spelling of the object, which is what the server matches a
// row back to a template entry with; Instance is the index suffix, empty for a
// scalar. Neither is `omitempty`: they are the substance of the protocol-2 row
// shape (spec §7.2), and an empty instance is a fact about a scalar, not a
// missing field.
//
// Error carries a per-OID failure code (spec §7.2 closed set). It IS
// `omitempty` — the overwhelming majority of rows succeed, and a walked 48-port
// switch is ~138k rows/day.
//
// ValueEncoding declares how Value was encoded by the agent. It is set to
// ValueEncodingHex only for octet strings the agent had to hex-encode, and is
// omitted otherwise: `omitempty` keeps the wire format backward-compatible in
// both directions (older APIs ignore the unknown field, older agents simply
// never send it).
type SNMPMetric struct {
	OID           string    `json:"oid"`
	BaseOID       string    `json:"baseOid"`
	Instance      string    `json:"instance"`
	Name          string    `json:"name"`
	Value         any       `json:"value"`
	Error         string    `json:"error,omitempty"`
	Timestamp     time.Time `json:"timestamp"`
	ValueEncoding string    `json:"valueEncoding,omitempty"`
}

// pduSource is the SNMP transport CollectMetrics needs: a multi-OID GET
// and a streaming bounded walk.
// *SNMPClient satisfies it.
//
// The seam exists for one reason: what this file does is decided entirely by
// the PDUs a device returns, and an unsupported table OID, a 600-row FDB and a
// mid-walk timeout are all things a real device on a test runner cannot be
// asked to produce. No production behaviour depends on the indirection.
type pduSource interface {
	GetMulti(oids []string) ([]gosnmp.SnmpPDU, error)
	WalkBounded(rootOID string, fn gosnmp.WalkFunc) error
}

// CollectMetrics fetches all configured OIDs for a device.
func CollectMetrics(device SNMPDevice) ([]SNMPMetric, error) {
	if device.IP == "" {
		return nil, errors.New("device IP is required")
	}

	specs := device.Specs
	if len(specs) == 0 {
		specs = SpecsFromOIDs(device.OIDs)
	}
	if len(specs) == 0 {
		return nil, errors.New("device has no OIDs configured")
	}

	limits := normalizePollLimits(device.Limits)

	client, err := NewClient(device.ClientConfig())
	if err != nil {
		return nil, err
	}
	defer client.Close()

	return collectWithSource(client, specs, limits, time.Now().UTC())
}

// collectWithSource is CollectMetrics with the transport and the clock supplied.
func collectWithSource(src pduSource, specs []OIDSpec, limits PollLimits, stamp time.Time, clocks ...func() time.Time) ([]SNMPMetric, error) {
	limits = normalizePollLimits(limits)
	now := time.Now
	if len(clocks) > 0 && clocks[0] != nil {
		now = clocks[0]
	}
	getSpecs := make([]OIDSpec, 0, len(specs))
	walkSpecs := make([]OIDSpec, 0, len(specs))
	for _, spec := range specs {
		if spec.Mode == ModeWalk {
			walkSpecs = append(walkSpecs, spec)
			continue
		}
		getSpecs = append(getSpecs, spec)
	}

	metrics := make([]SNMPMetric, 0, len(getSpecs)+len(walkSpecs))

	// All scalars in ONE GET, exactly as before.
	if len(getSpecs) > 0 {
		oids := make([]string, 0, len(getSpecs))
		for _, spec := range getSpecs {
			oids = append(oids, spec.OID)
		}
		pdus, err := src.GetMulti(oids)
		if err != nil {
			// Unchanged: a failed GET batch means the device did not answer at
			// all, which is a whole-poll transport failure, not a per-OID one.
			return nil, err
		}
		metrics = append(metrics, buildGetMetrics(getSpecs, pdus, stamp)...)
	}

	budget := &walkBudget{
		bytes:    totalMetricBytes(metrics),
		rows:     len(metrics),
		deadline: now().Add(limits.MaxDuration),
		now:      now,
		limits:   limits,
	}

	for _, spec := range walkSpecs {
		if budget.exhausted() {
			// Explicit, not omitted: a spec that never ran must not read as
			// "never polled" in the OID table.
			metrics = append(metrics, errorMetric(spec, "", ErrCodeTruncated, stamp))
			continue
		}

		rows, truncated, err := collectWalkSpec(src, spec, budget, stamp)
		metrics = append(metrics, rows...)

		switch {
		case err != nil:
			// Per-OID, not per-poll: one unimplemented or slow table must not
			// discard the scalars and the other columns that did answer. The
			// code set is closed, so the underlying error goes to the log.
			code := walkErrorCode(err)
			var statusErr *SnmpStatusError
			if errors.As(err, &statusErr) {
				slog.Warn("SNMP walk failed", "oid", spec.OID, "name", spec.Name, "status", statusErr.Status.String(), "error", err)
			} else {
				slog.Warn("SNMP walk failed", "oid", spec.OID, "name", spec.Name, "error", err)
			}
			metrics = append(metrics, errorMetric(spec, "", code, stamp))
		case truncated:
			metrics = append(metrics, errorMetric(spec, "", ErrCodeTruncated, stamp))
		case len(rows) == 0:
			// An empty subtree or an exception varbind ends the page loop
			// without value rows. Protocol error statuses instead return an
			// error above; neither outcome should look like never-polled.
			metrics = append(metrics, errorMetric(spec, "", ErrCodeNoSuchObject, stamp))
		}
	}

	return metrics, nil
}

func totalMetricBytes(metrics []SNMPMetric) int {
	total := 0
	for _, m := range metrics {
		total += metricByteSize(m)
	}
	return total
}

// errWalkStop unwinds a walk from inside its callback once a bound is hit. It
// never escapes collectWalkSpec.
var errWalkStop = errors.New("snmppoll: walk bound reached")

// walkBudget carries the POLL-level bounds across every walk spec in one poll.
// Per-OID bounds live in collectWalkSpec; both are needed, because one runaway
// table and fifty modest ones fail differently.
type walkBudget struct {
	rows     int
	bytes    int
	deadline time.Time
	now      func() time.Time
	limits   PollLimits
}

func (b *walkBudget) exhausted() bool {
	return b.rows >= b.limits.MaxRowsPerPoll ||
		b.bytes >= b.limits.MaxBytesPerPoll ||
		!b.now().Before(b.deadline)
}

// jsonOverheadPerMetric is a flat allowance for the JSON keys, quoting and
// RFC3339 timestamp every row carries. metricByteSize is a safety valve, not an
// accounting ledger: it has to be cheap and to over- rather than under-estimate.
const jsonOverheadPerMetric = 96

func metricByteSize(m SNMPMetric) int {
	size := jsonOverheadPerMetric + len(m.OID) + len(m.BaseOID) + len(m.Instance) + len(m.Name) + len(m.Error)
	switch v := m.Value.(type) {
	case nil:
	case string:
		size += len(v)
	default:
		size += 20 // every numeric form serialises to at most 20 bytes
	}
	return size
}

// errorMetric builds a value-less row carrying a per-OID failure code.
func errorMetric(spec OIDSpec, instance, code string, stamp time.Time) SNMPMetric {
	oid := spec.OID
	if instance != "" {
		oid = spec.OID + "." + instance
	}
	return SNMPMetric{
		OID:       oid,
		BaseOID:   spec.OID,
		Instance:  instance,
		Name:      spec.Name,
		Value:     nil,
		Error:     code,
		Timestamp: stamp,
	}
}

// collectWalkSpec walks one spec, stopping at the first bound it hits.
func collectWalkSpec(src pduSource, spec OIDSpec, budget *walkBudget, stamp time.Time) (rows []SNMPMetric, truncated bool, err error) {
	perOID := 0
	specs := []OIDSpec{spec}

	walkErr := src.WalkBounded(spec.OID, func(pdu gosnmp.SnmpPDU) error {
		// Checked BEFORE the row is kept, so MaxRowsPerOID = 512 yields exactly
		// 512 rows and the 513th trips truncation.
		if perOID >= budget.limits.MaxRowsPerOID || budget.exhausted() {
			truncated = true
			return errWalkStop
		}
		metric := metricFromPDU(specs, pdu, stamp)
		rows = append(rows, metric)
		perOID++
		budget.rows++
		budget.bytes += metricByteSize(metric)
		return nil
	})
	if walkErr != nil && !errors.Is(walkErr, errWalkStop) {
		return rows, truncated, walkErr
	}
	return rows, truncated, nil
}

// buildGetMetrics maps GET varbinds onto SNMPMetric rows, declaring the encoding
// at the same place the value is produced and turning the three "this object is
// not here" PDU types into explicit error rows.
func buildGetMetrics(specs []OIDSpec, pdus []gosnmp.SnmpPDU, stamp time.Time) []SNMPMetric {
	metrics := make([]SNMPMetric, 0, len(pdus))
	for _, pdu := range pdus {
		metrics = append(metrics, metricFromPDU(specs, pdu, stamp))
	}
	return metrics
}

// metricFromPDU builds one row, resolving which spec the PDU belongs to by OID.
func metricFromPDU(specs []OIDSpec, pdu gosnmp.SnmpPDU, stamp time.Time) SNMPMetric {
	spec := FindSpecForOID(specs, pdu.Name)

	metric := SNMPMetric{
		OID:       pdu.Name,
		BaseOID:   pdu.Name,
		Instance:  "",
		Name:      pdu.Name,
		Timestamp: stamp,
	}
	if spec != nil {
		metric.BaseOID = spec.OID
		metric.Instance = InstanceSuffix(spec.OID, pdu.Name)
		metric.Name = spec.Name
	}

	// A device that does not implement the object answers with one of these
	// three PDU types and a nil value. Before W02 that became value_type
	// 'null', indistinguishable from a real null — 145 of the ~407 built-in
	// template OIDs sat in that state permanently (spec F3).
	if code := pduErrorCode(pdu); code != "" {
		metric.Error = code
		metric.Value = nil
		return metric
	}

	value, hexEncoded := parseValue(pdu)
	metric.Value = value
	if hexEncoded {
		metric.ValueEncoding = ValueEncodingHex
	}
	return metric
}

// pduErrorCode maps the SNMP "no such thing" PDU types onto the closed per-OID
// error-code set. Everything else returns "" and is treated as a value.
func pduErrorCode(pdu gosnmp.SnmpPDU) string {
	switch pdu.Type {
	case gosnmp.NoSuchObject:
		return ErrCodeNoSuchObject
	case gosnmp.NoSuchInstance:
		return ErrCodeNoSuchInstance
	case gosnmp.EndOfMibView:
		return ErrCodeEndOfMib
	default:
		return ""
	}
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

func normalizePollLimits(limits PollLimits) PollLimits {
	if limits.MaxRowsPerOID <= 0 {
		limits.MaxRowsPerOID = DefaultPollLimits.MaxRowsPerOID
	}
	if limits.MaxRowsPerPoll <= 0 {
		limits.MaxRowsPerPoll = DefaultPollLimits.MaxRowsPerPoll
	}
	if limits.MaxBytesPerPoll <= 0 {
		limits.MaxBytesPerPoll = DefaultPollLimits.MaxBytesPerPoll
	}
	if limits.MaxDuration <= 0 {
		limits.MaxDuration = DefaultPollLimits.MaxDuration
	}
	return limits
}

func walkErrorCode(err error) string {
	var statusErr *SnmpStatusError
	if errors.As(err, &statusErr) {
		return ErrCodeSNMPError
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return ErrCodeTimeout
	}
	// gosnmp v1.44 returns an untyped error after its retries are exhausted.
	for cause := err; cause != nil; cause = errors.Unwrap(cause) {
		if cause.Error() == "request timeout" || strings.HasPrefix(cause.Error(), "request timeout (after ") {
			return ErrCodeTimeout
		}
	}
	return ErrCodeWalkFailed
}
