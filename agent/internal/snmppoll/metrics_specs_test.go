package snmppoll

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gosnmp/gosnmp"
)

// fakePDUSource stands in for *SNMPClient. Poll behaviour is decided entirely
// by the PDUs a device returns, and a fake is the only way to exercise an
// unsupported OID, a 600-row table and a mid-walk failure without one.
type fakePDUSource struct {
	getPDUs  []gosnmp.SnmpPDU
	getErr   error
	getCalls [][]string

	// walkPDUs maps a root OID to the rows a walk of it yields.
	walkPDUs  map[string][]gosnmp.SnmpPDU
	walkErrs  map[string]error
	walkCalls []string
	// onWalkRow advances the clock the caller sees, per row, for deadline tests.
	onWalkRow func()
}

func (f *fakePDUSource) GetMulti(oids []string) ([]gosnmp.SnmpPDU, error) {
	f.getCalls = append(f.getCalls, oids)
	if f.getErr != nil {
		return nil, f.getErr
	}
	return f.getPDUs, nil
}

func (f *fakePDUSource) WalkBounded(rootOID string, fn gosnmp.WalkFunc) error {
	f.walkCalls = append(f.walkCalls, rootOID)
	for _, pdu := range f.walkPDUs[rootOID] {
		if f.onWalkRow != nil {
			f.onWalkRow()
		}
		if err := fn(pdu); err != nil {
			return err
		}
	}
	return f.walkErrs[rootOID]
}

var stamp = time.Date(2026, 9, 16, 12, 0, 0, 0, time.UTC)

func metricByOID(metrics []SNMPMetric, oid string) *SNMPMetric {
	for i := range metrics {
		if metrics[i].OID == oid {
			return &metrics[i]
		}
	}
	return nil
}

func TestCollectWithSource_ScalarGetCarriesBaseAndEmptyInstance(t *testing.T) {
	src := &fakePDUSource{getPDUs: []gosnmp.SnmpPDU{
		{Name: ".1.3.6.1.2.1.1.3.0", Type: gosnmp.TimeTicks, Value: uint32(12345)},
	}}
	specs := []OIDSpec{{OID: "1.3.6.1.2.1.1.3.0", Name: "sysUpTime", Mode: ModeGet, Cadence: CadenceFast}}

	metrics, err := collectWithSource(src, specs, DefaultPollLimits, stamp)
	if err != nil {
		t.Fatalf("collectWithSource returned %v", err)
	}
	if len(metrics) != 1 {
		t.Fatalf("got %d metrics, want 1: %+v", len(metrics), metrics)
	}
	m := metrics[0]
	if m.BaseOID != "1.3.6.1.2.1.1.3.0" {
		t.Errorf("BaseOID = %q, want the template's own spelling", m.BaseOID)
	}
	if m.Instance != "" {
		t.Errorf("Instance = %q, want empty for a scalar", m.Instance)
	}
	if m.Name != "sysUpTime" {
		t.Errorf("Name = %q, want the spec name", m.Name)
	}
	if m.Error != "" {
		t.Errorf("Error = %q, want empty", m.Error)
	}
	// The OID field keeps the device's own spelling, as it always has — the
	// server stores it and legacy rows are matched on it.
	if m.OID != ".1.3.6.1.2.1.1.3.0" {
		t.Errorf("OID = %q, want the PDU name verbatim", m.OID)
	}
}

func TestCollectWithSource_UnsupportedOIDBecomesAnErrorRow(t *testing.T) {
	tests := []struct {
		name     string
		pduType  gosnmp.Asn1BER
		wantCode string
	}{
		{"noSuchObject", gosnmp.NoSuchObject, ErrCodeNoSuchObject},
		{"noSuchInstance", gosnmp.NoSuchInstance, ErrCodeNoSuchInstance},
		{"endOfMibView", gosnmp.EndOfMibView, ErrCodeEndOfMib},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			src := &fakePDUSource{getPDUs: []gosnmp.SnmpPDU{
				{Name: ".1.3.6.1.2.1.25.3.5.1.1", Type: tt.pduType, Value: nil},
			}}
			specs := []OIDSpec{{OID: "1.3.6.1.2.1.25.3.5.1.1", Name: "hrPrinterStatus", Mode: ModeGet, Cadence: CadenceFast}}

			metrics, err := collectWithSource(src, specs, DefaultPollLimits, stamp)
			if err != nil {
				t.Fatalf("collectWithSource returned %v", err)
			}
			if len(metrics) != 1 {
				t.Fatalf("got %d metrics, want 1", len(metrics))
			}
			// This is F3's fix: the row used to be stored as value_type 'null',
			// indistinguishable from a device that genuinely reported nothing.
			if metrics[0].Error != tt.wantCode {
				t.Errorf("Error = %q, want %q", metrics[0].Error, tt.wantCode)
			}
			if metrics[0].Value != nil {
				t.Errorf("Value = %v, want nil on an error row", metrics[0].Value)
			}
			if metrics[0].Name != "hrPrinterStatus" {
				t.Errorf("Name = %q, want the spec name so the UI can label the failure", metrics[0].Name)
			}
		})
	}
}

func TestCollectWithSource_PairsPDUsBySpecNotByOrder(t *testing.T) {
	// The device answers in a different order than asked and drops one varbind.
	src := &fakePDUSource{getPDUs: []gosnmp.SnmpPDU{
		{Name: ".1.3.6.1.2.1.1.5.0", Type: gosnmp.OctetString, Value: []byte("switch-2")},
		{Name: ".1.3.6.1.2.1.1.3.0", Type: gosnmp.TimeTicks, Value: uint32(7)},
	}}
	specs := []OIDSpec{
		{OID: "1.3.6.1.2.1.1.3.0", Name: "sysUpTime", Mode: ModeGet, Cadence: CadenceFast},
		{OID: "1.3.6.1.2.1.1.5.0", Name: "sysName", Mode: ModeGet, Cadence: CadenceFast},
		{OID: "1.3.6.1.2.1.1.6.0", Name: "sysLocation", Mode: ModeGet, Cadence: CadenceFast},
	}

	metrics, err := collectWithSource(src, specs, DefaultPollLimits, stamp)
	if err != nil {
		t.Fatalf("collectWithSource returned %v", err)
	}
	if m := metricByOID(metrics, ".1.3.6.1.2.1.1.5.0"); m == nil || m.Name != "sysName" {
		t.Fatalf("out-of-order PDU landed on %v, want sysName", m)
	}
	if m := metricByOID(metrics, ".1.3.6.1.2.1.1.3.0"); m == nil || m.Name != "sysUpTime" {
		t.Fatalf("out-of-order PDU landed on %v, want sysUpTime", m)
	}
	// The dropped varbind produces nothing rather than shifting the others.
	if len(metrics) != 2 {
		t.Errorf("got %d metrics, want 2 — the omitted varbind must not invent a row", len(metrics))
	}
}

func TestCollectWithSource_UnknownPDUFallsBackToItsOwnOID(t *testing.T) {
	src := &fakePDUSource{getPDUs: []gosnmp.SnmpPDU{
		{Name: ".1.3.6.1.4.1.9999.1.0", Type: gosnmp.Integer, Value: 1},
	}}
	specs := []OIDSpec{{OID: "1.3.6.1.2.1.1.3.0", Name: "sysUpTime", Mode: ModeGet, Cadence: CadenceFast}}

	metrics, err := collectWithSource(src, specs, DefaultPollLimits, stamp)
	if err != nil {
		t.Fatalf("collectWithSource returned %v", err)
	}
	if len(metrics) != 1 {
		t.Fatalf("got %d metrics, want 1", len(metrics))
	}
	if metrics[0].BaseOID != ".1.3.6.1.4.1.9999.1.0" || metrics[0].Instance != "" {
		t.Errorf("unmatched PDU = %+v, want baseOid == oid and empty instance", metrics[0])
	}
}

func TestCollectWithSource_GetTransportErrorFailsThePoll(t *testing.T) {
	src := &fakePDUSource{getErr: errors.New("request timeout")}
	specs := []OIDSpec{{OID: "1.3.6.1.2.1.1.3.0", Name: "sysUpTime", Mode: ModeGet, Cadence: CadenceFast}}

	// Unchanged from today: a failed GET batch means the device did not answer,
	// which the server already handles as a whole-poll failure.
	if _, err := collectWithSource(src, specs, DefaultPollLimits, stamp); err == nil {
		t.Fatal("collectWithSource with a failing GET should return an error")
	}
}

func TestCollectMetrics_NoSpecsAndNoOIDsReturnsError(t *testing.T) {
	if _, err := CollectMetrics(SNMPDevice{IP: "192.0.2.1"}); err == nil {
		t.Fatal("CollectMetrics with neither Specs nor OIDs should return an error")
	}
}

// walkRows builds n instance PDUs under base, numbered from 1.
func walkRows(base string, n int) []gosnmp.SnmpPDU {
	pdus := make([]gosnmp.SnmpPDU, 0, n)
	for i := 1; i <= n; i++ {
		pdus = append(pdus, gosnmp.SnmpPDU{
			Name:  base + "." + itoa(i),
			Type:  gosnmp.Integer,
			Value: i,
		})
	}
	return pdus
}

func itoa(i int) string { return strconv.Itoa(i) }

const suppliesLevel = ".1.3.6.1.2.1.43.11.1.1.9"

func walkSpec() OIDSpec {
	return OIDSpec{OID: "1.3.6.1.2.1.43.11.1.1.9", Name: "prtMarkerSuppliesLevel", Mode: ModeWalk, Cadence: CadenceFast}
}

func TestCollectWithSource_WalkEmitsOneRowPerInstance(t *testing.T) {
	src := &fakePDUSource{walkPDUs: map[string][]gosnmp.SnmpPDU{
		"1.3.6.1.2.1.43.11.1.1.9": walkRows(suppliesLevel, 4),
	}}

	metrics, err := collectWithSource(src, []OIDSpec{walkSpec()}, DefaultPollLimits, stamp)
	if err != nil {
		t.Fatalf("collectWithSource returned %v", err)
	}
	if len(metrics) != 4 {
		t.Fatalf("got %d metrics, want 4: %+v", len(metrics), metrics)
	}
	// No GET is issued for a walk spec — that was the bug.
	if len(src.getCalls) != 0 {
		t.Errorf("walk spec issued %d GET batches, want 0", len(src.getCalls))
	}
	for i, m := range metrics {
		if m.BaseOID != "1.3.6.1.2.1.43.11.1.1.9" {
			t.Errorf("row %d BaseOID = %q, want the template base", i, m.BaseOID)
		}
		if m.Instance != itoa(i+1) {
			t.Errorf("row %d Instance = %q, want %q", i, m.Instance, itoa(i+1))
		}
		if m.Name != "prtMarkerSuppliesLevel" {
			t.Errorf("row %d Name = %q, want the spec name", i, m.Name)
		}
		if m.Error != "" {
			t.Errorf("row %d Error = %q, want empty", i, m.Error)
		}
	}
}

func TestCollectWithSource_WalkStopsAtMaxRowsPerOID(t *testing.T) {
	src := &fakePDUSource{walkPDUs: map[string][]gosnmp.SnmpPDU{
		"1.3.6.1.2.1.43.11.1.1.9": walkRows(suppliesLevel, 40),
	}}
	limits := DefaultPollLimits
	limits.MaxRowsPerOID = 10

	metrics, err := collectWithSource(src, []OIDSpec{walkSpec()}, limits, stamp)
	if err != nil {
		t.Fatalf("collectWithSource returned %v", err)
	}
	// 10 value rows plus one truncation marker.
	if len(metrics) != 11 {
		t.Fatalf("got %d metrics, want 10 values + 1 truncated row: %+v", len(metrics), metrics)
	}
	last := metrics[len(metrics)-1]
	if last.Error != ErrCodeTruncated {
		t.Errorf("last row Error = %q, want %q", last.Error, ErrCodeTruncated)
	}
	if last.BaseOID != "1.3.6.1.2.1.43.11.1.1.9" || last.Instance != "" {
		t.Errorf("truncation row = %+v, want the base OID with an empty instance", last)
	}
	for _, m := range metrics[:10] {
		if m.Error != "" {
			t.Errorf("row before the bound carries Error %q; rows collected before truncation must still be emitted", m.Error)
		}
	}
}

func TestCollectWithSource_PollRowBudgetStopsLaterSpecs(t *testing.T) {
	src := &fakePDUSource{walkPDUs: map[string][]gosnmp.SnmpPDU{
		"1.3.6.1.2.1.43.11.1.1.9": walkRows(suppliesLevel, 10),
		"1.3.6.1.2.1.43.11.1.1.6": walkRows(".1.3.6.1.2.1.43.11.1.1.6", 10),
	}}
	limits := DefaultPollLimits
	limits.MaxRowsPerPoll = 6

	specs := []OIDSpec{
		walkSpec(),
		{OID: "1.3.6.1.2.1.43.11.1.1.6", Name: "prtMarkerSuppliesDescription", Mode: ModeWalk, Cadence: CadenceFast},
	}
	metrics, err := collectWithSource(src, specs, limits, stamp)
	if err != nil {
		t.Fatalf("collectWithSource returned %v", err)
	}

	values := 0
	truncated := map[string]bool{}
	for _, m := range metrics {
		if m.Error == ErrCodeTruncated {
			truncated[m.BaseOID] = true
			continue
		}
		values++
	}
	if values != 6 {
		t.Errorf("collected %d value rows, want the poll budget of 6", values)
	}
	// The second spec never got to run, and that must be visible rather than
	// looking like an OID that was never polled.
	if !truncated["1.3.6.1.2.1.43.11.1.1.6"] {
		t.Error("the skipped spec has no truncated row; it would read as never_polled in the UI")
	}
}

func TestCollectWithSource_ByteBudgetTruncates(t *testing.T) {
	big := make([]gosnmp.SnmpPDU, 0, 20)
	for i := 1; i <= 20; i++ {
		big = append(big, gosnmp.SnmpPDU{
			Name:  suppliesLevel + "." + itoa(i),
			Type:  gosnmp.OctetString,
			Value: []byte(strings.Repeat("x", 512)),
		})
	}
	src := &fakePDUSource{walkPDUs: map[string][]gosnmp.SnmpPDU{"1.3.6.1.2.1.43.11.1.1.9": big}}
	limits := DefaultPollLimits
	limits.MaxBytesPerPoll = 2048

	metrics, err := collectWithSource(src, []OIDSpec{walkSpec()}, limits, stamp)
	if err != nil {
		t.Fatalf("collectWithSource returned %v", err)
	}
	if len(metrics) >= 20 {
		t.Fatalf("got %d metrics, want the byte budget to cut the walk short", len(metrics))
	}
	if metrics[len(metrics)-1].Error != ErrCodeTruncated {
		t.Errorf("last row Error = %q, want %q", metrics[len(metrics)-1].Error, ErrCodeTruncated)
	}
}

func TestCollectWithSource_UnimplementedTableBecomesNoSuchObject(t *testing.T) {
	// The bounded page loop breaks on NoSuchObject/NoSuchInstance/EndOfMibView
	// WITHOUT calling the callback, so an unimplemented table looks exactly like
	// an empty one here. It must not be silently empty.
	src := &fakePDUSource{walkPDUs: map[string][]gosnmp.SnmpPDU{}}

	metrics, err := collectWithSource(src, []OIDSpec{walkSpec()}, DefaultPollLimits, stamp)
	if err != nil {
		t.Fatalf("collectWithSource returned %v", err)
	}
	if len(metrics) != 1 || metrics[0].Error != ErrCodeNoSuchObject {
		t.Fatalf("empty walk produced %+v, want one %q error row", metrics, ErrCodeNoSuchObject)
	}
}

func TestCollectWithSource_WalkErrorIsPerOIDNotPerPoll(t *testing.T) {
	src := &fakePDUSource{
		getPDUs: []gosnmp.SnmpPDU{{Name: ".1.3.6.1.2.1.1.3.0", Type: gosnmp.TimeTicks, Value: uint32(9)}},
		walkErrs: map[string]error{
			"1.3.6.1.2.1.43.11.1.1.9": errors.New("request timeout"),
		},
	}
	specs := []OIDSpec{
		{OID: "1.3.6.1.2.1.1.3.0", Name: "sysUpTime", Mode: ModeGet, Cadence: CadenceFast},
		walkSpec(),
	}

	metrics, err := collectWithSource(src, specs, DefaultPollLimits, stamp)
	if err != nil {
		t.Fatalf("one failing walk must not fail the whole poll, got %v", err)
	}
	if m := metricByOID(metrics, ".1.3.6.1.2.1.1.3.0"); m == nil || m.Error != "" {
		t.Errorf("the healthy scalar was lost or errored: %v", m)
	}
	var errRow *SNMPMetric
	for i := range metrics {
		if metrics[i].BaseOID == "1.3.6.1.2.1.43.11.1.1.9" {
			errRow = &metrics[i]
		}
	}
	if errRow == nil || errRow.Error != ErrCodeTimeout {
		t.Fatalf("failing walk produced %v, want a %q error row", errRow, ErrCodeTimeout)
	}
}

func TestCollectWithSource_MixedSpecsIssueOneGetBatchAndOneWalkEach(t *testing.T) {
	src := &fakePDUSource{
		getPDUs: []gosnmp.SnmpPDU{
			{Name: ".1.3.6.1.2.1.1.3.0", Type: gosnmp.TimeTicks, Value: uint32(1)},
			{Name: ".1.3.6.1.2.1.1.5.0", Type: gosnmp.OctetString, Value: []byte("printer-1")},
		},
		walkPDUs: map[string][]gosnmp.SnmpPDU{"1.3.6.1.2.1.43.11.1.1.9": walkRows(suppliesLevel, 2)},
	}
	specs := []OIDSpec{
		{OID: "1.3.6.1.2.1.1.3.0", Name: "sysUpTime", Mode: ModeGet, Cadence: CadenceFast},
		walkSpec(),
		{OID: "1.3.6.1.2.1.1.5.0", Name: "sysName", Mode: ModeGet, Cadence: CadenceFast},
	}

	metrics, err := collectWithSource(src, specs, DefaultPollLimits, stamp)
	if err != nil {
		t.Fatalf("collectWithSource returned %v", err)
	}
	if len(src.getCalls) != 1 {
		t.Fatalf("issued %d GET batches, want exactly 1", len(src.getCalls))
	}
	if len(src.getCalls[0]) != 2 {
		t.Errorf("GET batch = %v, want only the two get specs", src.getCalls[0])
	}
	if len(src.walkCalls) != 1 || src.walkCalls[0] != "1.3.6.1.2.1.43.11.1.1.9" {
		t.Errorf("walk calls = %v, want one walk of the supplies column", src.walkCalls)
	}
	if len(metrics) != 4 {
		t.Errorf("got %d metrics, want 2 scalars + 2 instances", len(metrics))
	}
}

func TestCollectWithSource_WalkTransportErrorCodes(t *testing.T) {
	for _, tt := range []struct {
		name string
		err  error
		want string
	}{
		{"gosnmp timeout", errors.New("request timeout (after 1 retries)"), "timeout"},
		{"network timeout", fmt.Errorf("read: %w", os.ErrDeadlineExceeded), "timeout"},
		{"not increasing", errors.New("OID not increasing"), "walkFailed"},
		{"not connected", errors.New("SNMP client is not connected"), "walkFailed"},
		{"connection refused", errors.New("connection refused"), "walkFailed"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			src := &fakePDUSource{walkErrs: map[string]error{walkSpec().OID: tt.err}}
			metrics, err := collectWithSource(src, []OIDSpec{walkSpec()}, DefaultPollLimits, stamp)
			if err != nil || len(metrics) != 1 || metrics[0].Error != tt.want {
				t.Fatalf("metrics = %+v, error = %v, want one %s row", metrics, err, tt.want)
			}
		})
	}
}

func TestCollectWithSource_DefaultsEachPollLimit(t *testing.T) {
	for _, tt := range []struct {
		name   string
		limits PollLimits
	}{
		{"rows per OID only", PollLimits{MaxRowsPerOID: 2}},
		{"negative omitted fields", PollLimits{MaxRowsPerOID: 2, MaxRowsPerPoll: -1, MaxBytesPerPoll: -1, MaxDuration: -1}},
		{"poll rows only", PollLimits{MaxRowsPerPoll: 2}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			src := &fakePDUSource{walkPDUs: map[string][]gosnmp.SnmpPDU{walkSpec().OID: walkRows(suppliesLevel, 5)}}
			metrics, err := collectWithSource(src, []OIDSpec{walkSpec()}, tt.limits, stamp)
			if err != nil || len(metrics) != 3 || metrics[0].Error != "" || metrics[1].Error != "" || metrics[2].Error != ErrCodeTruncated {
				t.Fatalf("metrics = %+v, error = %v, want two values and truncation", metrics, err)
			}
		})
	}
}

func TestCollectWithSource_SNMPStatusErrorPreservesPartialRows(t *testing.T) {
	for _, count := range []int{0, 3} {
		t.Run(itoa(count), func(t *testing.T) {
			src := &fakePDUSource{
				walkPDUs: map[string][]gosnmp.SnmpPDU{walkSpec().OID: walkRows(suppliesLevel, count)},
				walkErrs: map[string]error{walkSpec().OID: &SnmpStatusError{Status: gosnmp.NoAccess, Index: 1}},
			}
			metrics, err := collectWithSource(src, []OIDSpec{walkSpec()}, DefaultPollLimits, stamp)
			if err != nil || len(metrics) != count+1 || metrics[count].Error != "snmpError" {
				t.Fatalf("metrics = %+v, error = %v, want %d values and snmpError", metrics, err, count)
			}
			for _, row := range metrics[:count] {
				if row.Error != "" || row.Value == nil {
					t.Fatalf("lost partial value: %+v", row)
				}
			}
		})
	}
}

func TestCollectWithSource_WallClockBudgetTruncates(t *testing.T) {
	now := stamp
	specs := []OIDSpec{walkSpec(), {OID: "1.3.6.1.2.1.43.11.1.1.6", Name: "description", Mode: ModeWalk}}
	src := &fakePDUSource{
		walkPDUs:  map[string][]gosnmp.SnmpPDU{specs[0].OID: walkRows(suppliesLevel, 50), specs[1].OID: walkRows(".1.3.6.1.2.1.43.11.1.1.6", 5)},
		onWalkRow: func() { now = now.Add(time.Second) },
	}
	limits := DefaultPollLimits
	limits.MaxDuration = 3 * time.Second
	metrics, err := collectWithSource(src, specs, limits, stamp, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	values := 0
	truncated := map[string]bool{}
	for _, row := range metrics {
		if row.Error == ErrCodeTruncated {
			truncated[row.BaseOID] = true
		} else {
			values++
		}
	}
	if values != 2 || !truncated[specs[0].OID] || !truncated[specs[1].OID] || len(src.walkCalls) != 1 {
		t.Fatalf("values=%d, truncated=%v, walk calls=%v; want 2 values, both specs truncated, only first started", values, truncated, src.walkCalls)
	}
}
