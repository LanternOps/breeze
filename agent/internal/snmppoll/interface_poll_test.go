package snmppoll

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gosnmp/gosnmp"
)

const interfacePollFixture = "../../../packages/shared/src/testing/topology-interface-poll-v1.json"

// ---- fakes: no socket is ever opened ----

type fakeInterfaceMetricReader struct {
	mu     sync.Mutex
	values map[string]gosnmp.SnmpPDU
	// failOIDs makes any GET containing one of these OIDs fail with the error.
	failOIDs map[string]error
	// statusErrorOnMissing mimics SNMPv1: one absent OID fails the whole PDU.
	statusErrorOnMissing bool
	calls                [][]string
	onGet                func()
}

func (f *fakeInterfaceMetricReader) Get(ctx context.Context, oids []string) ([]gosnmp.SnmpPDU, error) {
	f.mu.Lock()
	f.calls = append(f.calls, append([]string(nil), oids...))
	onGet := f.onGet
	f.mu.Unlock()
	if onGet != nil {
		onGet()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(oids) > gosnmp.MaxOids {
		return nil, errors.New("too many oids")
	}
	out := make([]gosnmp.SnmpPDU, 0, len(oids))
	for _, oid := range oids {
		if err, ok := f.failOIDs[oid]; ok {
			return nil, err
		}
		pdu, ok := f.values[oid]
		if !ok {
			if f.statusErrorOnMissing {
				return nil, &SnmpStatusError{Status: gosnmp.NoSuchName, Index: 1}
			}
			pdu = gosnmp.SnmpPDU{Type: gosnmp.NoSuchInstance}
		}
		pdu.Name = "." + oid
		out = append(out, pdu)
	}
	return out, nil
}

func c64(v uint64) gosnmp.SnmpPDU   { return gosnmp.SnmpPDU{Type: gosnmp.Counter64, Value: v} }
func c32(v uint) gosnmp.SnmpPDU     { return gosnmp.SnmpPDU{Type: gosnmp.Counter32, Value: v} }
func g32(v uint) gosnmp.SnmpPDU     { return gosnmp.SnmpPDU{Type: gosnmp.Gauge32, Value: v} }
func ticks(v uint32) gosnmp.SnmpPDU { return gosnmp.SnmpPDU{Type: gosnmp.TimeTicks, Value: v} }
func integer(v int) gosnmp.SnmpPDU  { return gosnmp.SnmpPDU{Type: gosnmp.Integer, Value: v} }
func octets(v []byte) gosnmp.SnmpPDU {
	return gosnmp.SnmpPDU{Type: gosnmp.OctetString, Value: v}
}
func noSuchObject() gosnmp.SnmpPDU { return gosnmp.SnmpPDU{Type: gosnmp.NoSuchObject} }

// switchPort returns a complete, healthy 1 Gbit/s port under ifIndex idx.
func switchPort(values map[string]gosnmp.SnmpPDU, idx string, name string, mac []byte) {
	set := func(oid string, pdu gosnmp.SnmpPDU) { values[oid+"."+idx] = pdu }
	set(oidIfSpeed, g32(1000000000))
	set(oidIfPhysAddress, octets(mac))
	set(oidIfAdminStatus, integer(1))
	set(oidIfOperStatus, integer(1))
	set(oidIfInOctets, c32(100))
	set(oidIfInDiscards, c32(1))
	set(oidIfInErrors, c32(2))
	set(oidIfOutOctets, c32(200))
	set(oidIfOutDiscards, c32(3))
	set(oidIfOutErrors, c32(4))
	set(oidPollIfName, octets([]byte(name)))
	set(oidIfHCInOctets, c64(1000))
	set(oidIfHCInUcastPkts, c64(10))
	set(oidIfHCInMulticastPkts, c64(1))
	set(oidIfHCInBroadcastPkts, c64(1))
	set(oidIfHCOutOctets, c64(2000))
	set(oidIfHCOutUcastPkts, c64(20))
	set(oidIfHCOutMulticastPkts, c64(2))
	set(oidIfHCOutBroadcastPkts, c64(2))
	set(oidIfHighSpeed, g32(1000))
	set(oidIfCounterDiscontinuityTime, ticks(0))
}

var mac7 = []byte{0x00, 0x11, 0x22, 0x33, 0x44, 0x07}

func newFakeSwitch() *fakeInterfaceMetricReader {
	values := map[string]gosnmp.SnmpPDU{oidSysUpTime: ticks(123456)}
	switchPort(values, "7", "Gi0/7", mac7)
	return &fakeInterfaceMetricReader{values: values}
}

func port7() InterfacePollTarget {
	name, mac := "Gi0/7", "00:11:22:33:44:07"
	return InterfacePollTarget{InterfaceID: "11111111-1111-4111-8111-111111111111", InterfaceEpoch: "gen:1", IfIndex: 7, ExpectedName: &name, ExpectedPhysAddress: &mac}
}

// metricRequestForPort7 is one approved interface with an explicit epoch, a
// one-minute cadence and a bounded deadline.
func metricRequestForPort7() InterfaceMetricRequest {
	return InterfaceMetricRequest{Version: Version2c, Interfaces: []InterfacePollTarget{port7()}, Deadline: time.Now().Add(30 * time.Second)}
}

func sampleFor(t *testing.T, snap InterfaceMetricSnapshot, id string) InterfaceMetricSampleV1 {
	t.Helper()
	for _, s := range snap.Samples {
		if s.InterfaceID == id {
			return s
		}
	}
	t.Fatalf("no sample for %s in %#v", id, snap)
	return InterfaceMetricSampleV1{}
}

func ptrValue(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

// ---- collection ----

func TestInterfaceMetricsPreferHC(t *testing.T) {
	reader := newFakeSwitch()
	reader.values[oidIfHCInOctets+".7"] = c64(18446744073709551615)
	reader.values[oidIfHCOutOctets+".7"] = c64(0)
	got, err := CollectInterfaceMetrics(context.Background(), reader, metricRequestForPort7())
	if err != nil {
		t.Fatal(err)
	}
	s := got.Samples[0]
	if s.InOctets == nil || *s.InOctets != "18446744073709551615" {
		t.Fatalf("precision lost: %#v", got)
	}
	if ptrValue(s.OutOctets) != "0" {
		t.Fatalf("measured zero lost: %s", ptrValue(s.OutOctets))
	}
	if s.CounterWidth == nil || *s.CounterWidth != 64 {
		t.Fatalf("counter width = %v", s.CounterWidth)
	}
	if ptrValue(s.InPackets) != "12" || ptrValue(s.OutPackets) != "24" {
		t.Fatalf("packets = %s/%s", ptrValue(s.InPackets), ptrValue(s.OutPackets))
	}
	if ptrValue(s.CapacityBps) != "1000000000" || ptrValue(s.DeviceUptimeTicks) != "123456" || ptrValue(s.DiscontinuityTicks) != "0" {
		t.Fatalf("capacity/uptime/discontinuity = %s/%s/%s", ptrValue(s.CapacityBps), ptrValue(s.DeviceUptimeTicks), ptrValue(s.DiscontinuityTicks))
	}
	if s.AdminStatus != "up" || s.OperStatus != "up" || ptrValue(s.InErrors) != "2" || ptrValue(s.OutDiscards) != "3" {
		t.Fatalf("status/errors wrong: %#v", s)
	}
	if err := s.Validate(); err != nil {
		t.Fatalf("sample invalid: %v", err)
	}
	if got.Outcome != "complete" || got.ReasonCode != nil {
		t.Fatalf("outcome %s %v", got.Outcome, got.ReasonCode)
	}
}

func TestInterfaceMetricsFallBackTo32BitWithoutHC(t *testing.T) {
	reader := newFakeSwitch()
	for _, oid := range []string{oidIfHCInOctets, oidIfHCOutOctets, oidIfHCInUcastPkts, oidIfHCOutUcastPkts, oidIfHighSpeed} {
		reader.values[oid+".7"] = noSuchObject()
	}
	got, err := CollectInterfaceMetrics(context.Background(), reader, metricRequestForPort7())
	if err != nil {
		t.Fatal(err)
	}
	s := sampleFor(t, got, port7().InterfaceID)
	if s.CounterWidth == nil || *s.CounterWidth != 32 || ptrValue(s.InOctets) != "100" || ptrValue(s.OutOctets) != "200" {
		t.Fatalf("32-bit fallback wrong: %#v", s)
	}
	if s.InPackets != nil || s.Unavailable["inPackets"] == "" {
		t.Fatalf("packets must be unavailable without complete HC columns: %#v", s)
	}
	if err := s.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestInterfaceMetricsHighSpeedAboveIfSpeedCeiling(t *testing.T) {
	reader := newFakeSwitch()
	reader.values[oidIfSpeed+".7"] = g32(4294967295)
	reader.values[oidIfHighSpeed+".7"] = g32(100000)
	got, _ := CollectInterfaceMetrics(context.Background(), reader, metricRequestForPort7())
	if s := sampleFor(t, got, port7().InterfaceID); ptrValue(s.CapacityBps) != "100000000000" {
		t.Fatalf("capacity = %s", ptrValue(s.CapacityBps))
	}
}

func TestInterfaceMetricsMissingSpeedIsUnavailableNotZero(t *testing.T) {
	reader := newFakeSwitch()
	reader.values[oidIfSpeed+".7"] = noSuchObject()
	reader.values[oidIfHighSpeed+".7"] = g32(0)
	got, _ := CollectInterfaceMetrics(context.Background(), reader, metricRequestForPort7())
	s := sampleFor(t, got, port7().InterfaceID)
	if s.CapacityBps != nil || s.Unavailable["capacityBps"] == "" {
		t.Fatalf("missing speed must be null with a reason: %#v", s)
	}
}

func TestInterfaceMetricsAdminDown(t *testing.T) {
	reader := newFakeSwitch()
	reader.values[oidIfAdminStatus+".7"] = integer(2)
	reader.values[oidIfOperStatus+".7"] = integer(7)
	got, _ := CollectInterfaceMetrics(context.Background(), reader, metricRequestForPort7())
	s := sampleFor(t, got, port7().InterfaceID)
	if s.AdminStatus != "down" || s.OperStatus != "lower_layer_down" {
		t.Fatalf("status = %s/%s", s.AdminStatus, s.OperStatus)
	}
}

func TestInterfaceMetricsAbsentOIDIsUnsupportedNotTimeout(t *testing.T) {
	reader := newFakeSwitch()
	reader.values[oidIfInErrors+".7"] = noSuchObject()
	got, _ := CollectInterfaceMetrics(context.Background(), reader, metricRequestForPort7())
	s := sampleFor(t, got, port7().InterfaceID)
	if s.InErrors != nil || s.Unavailable["inErrors"] != "not_supported" {
		t.Fatalf("absent OID reason = %q", s.Unavailable["inErrors"])
	}
	if got.Outcome != "complete" {
		t.Fatalf("an unsupported column is not a partial collection: %s", got.Outcome)
	}
}

func TestInterfaceMetricsTimeoutOmitsPortsAndIsNotUnsupported(t *testing.T) {
	reader := newFakeSwitch()
	switchPort(reader.values, "8", "Gi0/8", []byte{0, 0x11, 0x22, 0x33, 0x44, 0x08})
	reader.failOIDs = map[string]error{oidPollIfName + ".8": errors.New("request timeout (after 1 retries)")}
	second := InterfacePollTarget{InterfaceID: "22222222-2222-4222-8222-222222222222", InterfaceEpoch: "gen:3", IfIndex: 8}
	req := metricRequestForPort7()
	req.Interfaces = append(req.Interfaces, second)
	got, err := CollectInterfaceMetrics(context.Background(), reader, req)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Samples) != 1 || got.Samples[0].InterfaceID != port7().InterfaceID {
		t.Fatalf("timed-out port must be omitted, got %#v", got.Samples)
	}
	if got.Outcome != "partial" || got.ReasonCode == nil || *got.ReasonCode != "timeout" {
		t.Fatalf("outcome %s reason %v", got.Outcome, got.ReasonCode)
	}
}

func TestInterfaceMetricsAuthFailureFailsTheCollection(t *testing.T) {
	reader := newFakeSwitch()
	reader.failOIDs = map[string]error{oidSysUpTime: errors.New("incoming packet is not authentic, discarding")}
	got, err := CollectInterfaceMetrics(context.Background(), reader, metricRequestForPort7())
	if err != nil {
		t.Fatal(err)
	}
	if got.Outcome != "failed" || got.ReasonCode == nil || *got.ReasonCode != "auth_failed" || len(got.Samples) != 0 {
		t.Fatalf("auth failure = %s %v %d", got.Outcome, got.ReasonCode, len(got.Samples))
	}
}

func TestInterfaceMetricsIfIndexReuseIsNotReported(t *testing.T) {
	reader := newFakeSwitch()
	reader.values[oidPollIfName+".7"] = octets([]byte("Te1/1"))
	got, _ := CollectInterfaceMetrics(context.Background(), reader, metricRequestForPort7())
	if len(got.Samples) != 0 || got.Outcome != "failed" || ptrValue(got.ReasonCode) != "interface_identity_changed" {
		t.Fatalf("reused ifIndex must not be attributed: %#v", got)
	}
	reader = newFakeSwitch()
	reader.values[oidIfPhysAddress+".7"] = octets([]byte{0, 0x11, 0x22, 0x33, 0x44, 0x99})
	got, _ = CollectInterfaceMetrics(context.Background(), reader, metricRequestForPort7())
	if len(got.Samples) != 0 || ptrValue(got.ReasonCode) != "interface_identity_changed" {
		t.Fatalf("MAC change must not be attributed: %#v", got)
	}
}

func TestInterfaceMetricsPartialBatchLeavesAbsentRowsUnavailable(t *testing.T) {
	reader := newFakeSwitch()
	gone := InterfacePollTarget{InterfaceID: "22222222-2222-4222-8222-222222222222", InterfaceEpoch: "gen:3", IfIndex: 9}
	req := metricRequestForPort7()
	req.Interfaces = append(req.Interfaces, gone)
	got, _ := CollectInterfaceMetrics(context.Background(), reader, req)
	if len(got.Samples) != 1 || got.Outcome != "partial" || ptrValue(got.ReasonCode) != "interface_not_present" {
		t.Fatalf("absent row = %#v", got)
	}
}

func TestInterfaceMetricsCancellation(t *testing.T) {
	reader := newFakeSwitch()
	ctx, cancel := context.WithCancel(context.Background())
	reader.onGet = cancel
	got, err := CollectInterfaceMetrics(ctx, reader, metricRequestForPort7())
	if err != nil {
		t.Fatal(err)
	}
	if got.Outcome != "failed" || ptrValue(got.ReasonCode) != "cancelled" || len(got.Samples) != 0 {
		t.Fatalf("cancelled = %#v", got)
	}
}

func TestInterfaceMetricsV1NeverAsksForCounter64AndSurvivesNoSuchName(t *testing.T) {
	reader := newFakeSwitch()
	reader.statusErrorOnMissing = true
	for oid := range reader.values {
		if strings.HasPrefix(oid, "1.3.6.1.2.1.31.") && !strings.HasPrefix(oid, oidPollIfName+".") {
			delete(reader.values, oid)
		}
	}
	delete(reader.values, oidPollIfName+".7")
	req := metricRequestForPort7()
	req.Version = Version1
	req.Interfaces[0].ExpectedName = nil
	got, err := CollectInterfaceMetrics(context.Background(), reader, req)
	if err != nil {
		t.Fatal(err)
	}
	for _, call := range reader.calls {
		for _, oid := range call {
			if strings.HasPrefix(oid, "1.3.6.1.2.1.31.1.1.1.") && !strings.HasPrefix(oid, oidPollIfName+".") {
				t.Fatalf("v1 asked for an ifXTable counter: %s", oid)
			}
		}
	}
	s := sampleFor(t, got, port7().InterfaceID)
	if s.CounterWidth == nil || *s.CounterWidth != 32 || ptrValue(s.InOctets) != "100" {
		t.Fatalf("v1 sample = %#v", s)
	}
}

func TestInterfaceMetricsBatchesStayUnderMaxOIDs(t *testing.T) {
	reader := newFakeSwitch()
	req := metricRequestForPort7()
	for i := 0; i < 40; i++ {
		req.Interfaces = append(req.Interfaces, InterfacePollTarget{InterfaceID: "44444444-4444-4444-8444-0000000000" + string(rune('a'+i/16)) + string("0123456789abcdef"[i%16]), InterfaceEpoch: "gen:1", IfIndex: 100 + i})
	}
	if _, err := CollectInterfaceMetrics(context.Background(), reader, req); err != nil {
		t.Fatal(err)
	}
	for _, call := range reader.calls {
		if len(call) > gosnmp.MaxOids {
			t.Fatalf("GET of %d OIDs exceeds %d", len(call), gosnmp.MaxOids)
		}
	}
}

func TestInterfaceMetricsRejectsOversizedRequest(t *testing.T) {
	req := metricRequestForPort7()
	for len(req.Interfaces) <= InterfaceMetricsMaxSamples {
		req.Interfaces = append(req.Interfaces, port7())
	}
	if _, err := CollectInterfaceMetrics(context.Background(), newFakeSwitch(), req); err == nil {
		t.Fatal("more than 256 interfaces must be refused")
	}
}

// ---- command contract (shared fixture parity with the TS schema) ----

type interfacePollFixtureFile struct {
	Valid    json.RawMessage `json:"valid"`
	ValidV2c json.RawMessage `json:"validV2c"`
	Erased   json.RawMessage `json:"erased"`
	Invalid  []struct {
		Name    string          `json:"name"`
		Command json.RawMessage `json:"command"`
	} `json:"invalid"`
}

func loadInterfacePollFixture(t *testing.T) interfacePollFixtureFile {
	t.Helper()
	raw, err := os.ReadFile(interfacePollFixture)
	if err != nil {
		t.Fatal(err)
	}
	var f interfacePollFixtureFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Valid) == 0 || len(f.Invalid) == 0 {
		t.Fatal("interface poll fixture is empty")
	}
	return f
}

func TestInterfacePollCommandContract(t *testing.T) {
	f := loadInterfacePollFixture(t)
	for name, raw := range map[string]json.RawMessage{"valid": f.Valid, "validV2c": f.ValidV2c, "erased": f.Erased} {
		if _, err := DecodeInterfacePollCommandV1(raw); err != nil {
			t.Fatalf("%s rejected: %v", name, err)
		}
	}
	for _, c := range f.Invalid {
		t.Run(c.Name, func(t *testing.T) {
			if _, err := DecodeInterfacePollCommandV1(c.Command); err == nil {
				t.Fatalf("accepted invalid command %s", c.Name)
			}
		})
	}
}

func TestInterfacePollCredentialsRequiredForDelivery(t *testing.T) {
	f := loadInterfacePollFixture(t)
	erased, _ := DecodeInterfacePollCommandV1(f.Erased)
	if _, err := erased.Device(); err == nil {
		t.Fatal("an erased command has no usable credentials")
	}
	valid, _ := DecodeInterfacePollCommandV1(f.Valid)
	device, err := valid.Device()
	if err != nil {
		t.Fatal(err)
	}
	if device.Version != Version3 || device.Auth.AuthProtocol != gosnmp.SHA256 || device.Auth.PrivProtocol != gosnmp.AES || device.Auth.AuthPassphrase != "auth-secret" {
		t.Fatalf("v3 device = %#v", device)
	}
	v2c, _ := DecodeInterfacePollCommandV1(f.ValidV2c)
	if device, err = v2c.Device(); err != nil || device.Auth.Community != "public-ro" || device.Version != Version2c {
		t.Fatalf("v2c device = %#v %v", device, err)
	}
}

func TestInterfacePollEnvelopeEchoesTheCommand(t *testing.T) {
	f := loadInterfacePollFixture(t)
	cmd, _ := DecodeInterfacePollCommandV1(f.ValidV2c)
	cmd.Interfaces = cmd.Interfaces[:1]
	start := time.Date(2026, 11, 2, 10, 0, 0, 123456789, time.UTC)
	tick := start
	req := cmd.Request(start.Add(10 * time.Second))
	req.Clock = func() time.Time { tick = tick.Add(time.Millisecond); return tick }
	snap, err := CollectInterfaceMetrics(context.Background(), newFakeSwitch(), req)
	if err != nil {
		t.Fatal(err)
	}
	envelope := cmd.Envelope("33333333-3333-4333-8333-333333333333", start, tick, snap)
	raw, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeInterfaceMetricEnvelopeV1(raw)
	if err != nil {
		t.Fatalf("built envelope is invalid: %v\n%s", err, raw)
	}
	if decoded.Sequence != cmd.Sequence || decoded.ProducerEpoch != cmd.ProducerEpoch || decoded.ConfigurationRevision != cmd.ConfigurationRevision ||
		decoded.ExpectedIntervalSeconds != cmd.ExpectedIntervalSeconds || decoded.CommandID == nil || *decoded.CommandID != "33333333-3333-4333-8333-333333333333" {
		t.Fatalf("envelope does not echo the command: %s", raw)
	}
	if decoded.Samples[0].InterfaceEpoch != "gen:1" {
		t.Fatalf("epoch = %s", decoded.Samples[0].InterfaceEpoch)
	}
}
