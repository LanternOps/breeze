package snmppoll

import (
	"errors"
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
	// walkDelay advances the clock the caller sees, per row, for deadline tests.
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
	if err, ok := f.walkErrs[rootOID]; ok && err != nil {
		return err
	}
	for _, pdu := range f.walkPDUs[rootOID] {
		if f.onWalkRow != nil {
			f.onWalkRow()
		}
		if err := fn(pdu); err != nil {
			return err
		}
	}
	return nil
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
