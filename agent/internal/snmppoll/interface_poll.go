package snmppoll

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"net"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gosnmp/gosnmp"
)

// Topology interface poll (M3 Task 3, amendment M3-D2).
//
// The server's telemetry-arm dispatcher sends a `topology_interface_poll`
// command naming exactly which ifIndexes to read and which canonical interface
// (UUID + epoch) each one is. The agent reads IF-MIB state and counters for
// those indexes only — one bounded GET per interface, never a table walk — and
// answers with an if_metrics envelope (interface_metrics.go). It never chooses
// an interface identity: a sample is attributed only to the UUID the server
// bound to that ifIndex, and only while the port still carries the identity
// (ifName / ifPhysAddress) the server expected, so ifIndex reuse after a reboot
// or line-card swap cannot be misattributed.
//
// Contract: packages/shared/src/validators/topologyTelemetry.ts
// (topologyInterfacePollCommandV1Schema), fixture
// packages/shared/src/testing/topology-interface-poll-v1.json.

// CmdTopologyInterfacePoll is the command type (mirrors TOPOLOGY_INTERFACE_POLL_COMMAND_TYPE).
const CmdTopologyInterfacePoll = "topology_interface_poll"

// IF-MIB (RFC 2863) and SNMPv2-MIB objects read per interface.
const (
	oidSysUpTime                  = "1.3.6.1.2.1.1.3.0"
	oidIfSpeed                    = "1.3.6.1.2.1.2.2.1.5"
	oidIfPhysAddress              = "1.3.6.1.2.1.2.2.1.6"
	oidIfAdminStatus              = "1.3.6.1.2.1.2.2.1.7"
	oidIfOperStatus               = "1.3.6.1.2.1.2.2.1.8"
	oidIfInOctets                 = "1.3.6.1.2.1.2.2.1.10"
	oidIfInDiscards               = "1.3.6.1.2.1.2.2.1.13"
	oidIfInErrors                 = "1.3.6.1.2.1.2.2.1.14"
	oidIfOutOctets                = "1.3.6.1.2.1.2.2.1.16"
	oidIfOutDiscards              = "1.3.6.1.2.1.2.2.1.19"
	oidIfOutErrors                = "1.3.6.1.2.1.2.2.1.20"
	oidPollIfName                 = "1.3.6.1.2.1.31.1.1.1.1"
	oidIfHCInOctets               = "1.3.6.1.2.1.31.1.1.1.6"
	oidIfHCInUcastPkts            = "1.3.6.1.2.1.31.1.1.1.7"
	oidIfHCInMulticastPkts        = "1.3.6.1.2.1.31.1.1.1.8"
	oidIfHCInBroadcastPkts        = "1.3.6.1.2.1.31.1.1.1.9"
	oidIfHCOutOctets              = "1.3.6.1.2.1.31.1.1.1.10"
	oidIfHCOutUcastPkts           = "1.3.6.1.2.1.31.1.1.1.11"
	oidIfHCOutMulticastPkts       = "1.3.6.1.2.1.31.1.1.1.12"
	oidIfHCOutBroadcastPkts       = "1.3.6.1.2.1.31.1.1.1.13"
	oidIfHighSpeed                = "1.3.6.1.2.1.31.1.1.1.15"
	oidIfCounterDiscontinuityTime = "1.3.6.1.2.1.31.1.1.1.19"
)

// ifTable columns every SNMP version can read.
var interfaceBaseColumns = []string{oidIfSpeed, oidIfPhysAddress, oidIfAdminStatus, oidIfOperStatus, oidIfInOctets, oidIfInDiscards,
	oidIfInErrors, oidIfOutOctets, oidIfOutDiscards, oidIfOutErrors, oidPollIfName}

// ifXTable Counter64/Gauge columns; SNMPv1 cannot carry Counter64, so v1 never asks.
var interfaceHCColumns = []string{oidIfHCInOctets, oidIfHCInUcastPkts, oidIfHCInMulticastPkts, oidIfHCInBroadcastPkts, oidIfHCOutOctets,
	oidIfHCOutUcastPkts, oidIfHCOutMulticastPkts, oidIfHCOutBroadcastPkts, oidIfHighSpeed, oidIfCounterDiscontinuityTime}

// Reasons recorded on the envelope or in a sample's Unavailable map.
const (
	reasonNotSupported       = "not_supported"
	reasonTimeout            = "timeout"
	reasonAuthFailed         = "auth_failed"
	reasonSNMPError          = "snmp_error"
	reasonCancelled          = "cancelled"
	reasonDeadline           = "deadline_exceeded"
	reasonNotPresent         = "interface_not_present"
	reasonIdentityChanged    = "interface_identity_changed"
	reasonPacketsIncomplete  = "packet_counters_incomplete"
	reasonSpeedNotReported   = "speed_not_reported"
	reasonCounterUnavailable = "counter_width_unavailable"
)

// InterfaceMetricReader is the SNMP transport the collector needs. *SNMPClient
// satisfies it through ClientInterfaceMetricReader; tests inject a fake.
type InterfaceMetricReader interface {
	Get(ctx context.Context, oids []string) ([]gosnmp.SnmpPDU, error)
}

// ClientInterfaceMetricReader adapts the (context-unaware) gosnmp client: the
// context is honoured between requests and each request is already bounded by
// the client's timeout and retry count.
type ClientInterfaceMetricReader struct{ Client *SNMPClient }

func (r ClientInterfaceMetricReader) Get(ctx context.Context, oids []string) ([]gosnmp.SnmpPDU, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return r.Client.GetMulti(oids)
}

// InterfacePollTarget is one server-approved port: ifIndex bound to exactly
// one canonical interface identity.
type InterfacePollTarget struct {
	InterfaceID         string  `json:"interfaceId"`
	InterfaceEpoch      string  `json:"interfaceEpoch"`
	IfIndex             int     `json:"ifIndex"`
	ExpectedName        *string `json:"expectedName"`
	ExpectedPhysAddress *string `json:"expectedPhysAddress"`
}

// InterfaceMetricRequest bounds one collection.
type InterfaceMetricRequest struct {
	Version    SNMPVersion
	Interfaces []InterfacePollTarget
	Deadline   time.Time
	// Clock stamps samples; defaults to time.Now.
	Clock func() time.Time
}

// InterfaceMetricSnapshot is what one poll observed.
type InterfaceMetricSnapshot struct {
	Samples []InterfaceMetricSampleV1
	// Outcome is the source collection outcome (complete/partial/failed).
	Outcome    string
	ReasonCode *string
	// Omitted counts approved interfaces without a sample, by reason.
	Omitted map[string]int
}

func strPtr(v string) *string { return &v }
func intPtr(v int) *int       { return &v }

// isAuthError recognises gosnmp's SNMPv3 USM failures (bad digest/key, unknown user).
func classifyGetError(err error) string {
	if errors.Is(err, context.Canceled) {
		return reasonCancelled
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return reasonDeadline
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "timeout"), strings.Contains(msg, "i/o timeout"):
		return reasonTimeout
	case strings.Contains(msg, "authentic"), strings.Contains(msg, "digest"), strings.Contains(msg, "unknown user"),
		strings.Contains(msg, "usmstats"), strings.Contains(msg, "decrypt"), strings.Contains(msg, "authentication"):
		return reasonAuthFailed
	default:
		return reasonSNMPError
	}
}

// getAll performs one GET; on an SNMPv1-style whole-PDU status error it retries
// each OID alone so one unsupported column cannot hide the rest.
func getAll(ctx context.Context, reader InterfaceMetricReader, oids []string) (map[string]gosnmp.SnmpPDU, error) {
	pdus, err := reader.Get(ctx, oids)
	var status *SnmpStatusError
	if errors.As(err, &status) {
		out := map[string]gosnmp.SnmpPDU{}
		for _, oid := range oids {
			one, oneErr := reader.Get(ctx, []string{oid})
			if errors.As(oneErr, &status) {
				out[oid] = gosnmp.SnmpPDU{Name: oid, Type: gosnmp.NoSuchObject}
				continue
			}
			if oneErr != nil {
				return nil, oneErr
			}
			if len(one) == 1 {
				out[oid] = one[0]
			}
		}
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	out := make(map[string]gosnmp.SnmpPDU, len(pdus))
	for i, pdu := range pdus {
		name := strings.TrimPrefix(pdu.Name, ".")
		if name == "" && i < len(oids) {
			name = oids[i]
		}
		out[name] = pdu
	}
	return out, nil
}

// pduState classifies one varbind.
type pduValue struct {
	present bool
	reason  string
	pdu     gosnmp.SnmpPDU
}

func valueOf(pdus map[string]gosnmp.SnmpPDU, oid string) pduValue {
	pdu, ok := pdus[oid]
	if !ok {
		return pduValue{reason: reasonNotSupported}
	}
	switch pdu.Type {
	case gosnmp.NoSuchObject, gosnmp.EndOfMibView:
		return pduValue{reason: reasonNotSupported}
	case gosnmp.NoSuchInstance, gosnmp.Null:
		return pduValue{reason: "no_such_instance"}
	}
	if pdu.Value == nil {
		return pduValue{reason: reasonNotSupported}
	}
	return pduValue{present: true, pdu: pdu}
}

// unsigned returns the value of an unsigned numeric PDU of an allowed type.
func (v pduValue) unsigned(types ...gosnmp.Asn1BER) (uint64, bool) {
	if !v.present {
		return 0, false
	}
	allowed := false
	for _, t := range types {
		if v.pdu.Type == t {
			allowed = true
		}
	}
	if !allowed {
		return 0, false
	}
	n := gosnmp.ToBigInt(v.pdu.Value)
	if n == nil || n.Sign() < 0 || n.Cmp(new(big.Int).SetUint64(^uint64(0))) > 0 {
		return 0, false
	}
	return n.Uint64(), true
}

func (v pduValue) octets() ([]byte, bool) {
	if !v.present || v.pdu.Type != gosnmp.OctetString {
		return nil, false
	}
	b, ok := v.pdu.Value.([]byte)
	return b, ok
}

func (v pduValue) integer() (int64, bool) {
	if !v.present || v.pdu.Type != gosnmp.Integer {
		return 0, false
	}
	n := gosnmp.ToBigInt(v.pdu.Value)
	if n == nil || !n.IsInt64() {
		return 0, false
	}
	return n.Int64(), true
}

var adminStatusNames = map[int64]string{1: "up", 2: "down", 3: "testing"}
var operStatusNames = map[int64]string{1: "up", 2: "down", 3: "testing", 4: "unknown", 5: "dormant", 6: "not_present", 7: "lower_layer_down"}

func formatMAC(b []byte) string { return net.HardwareAddr(b).String() }

func oidsFor(version SNMPVersion, ifIndex int) []string {
	suffix := "." + strconv.Itoa(ifIndex)
	columns := interfaceBaseColumns
	if version != Version1 {
		columns = append(append([]string(nil), interfaceBaseColumns...), interfaceHCColumns...)
	}
	out := make([]string, len(columns))
	for i, column := range columns {
		out[i] = column + suffix
	}
	return out
}

// buildSample turns one interface's varbinds into a sample, or a skip reason.
func buildSample(target InterfacePollTarget, pdus map[string]gosnmp.SnmpPDU, uptime *string, at time.Time) (InterfaceMetricSampleV1, string) {
	suffix := "." + strconv.Itoa(target.IfIndex)
	get := func(column string) pduValue { return valueOf(pdus, column+suffix) }

	anyPresent := false
	for oid, pdu := range pdus {
		if strings.HasSuffix(oid, suffix) && valueOf(pdus, oid).present && pdu.Type != gosnmp.NoSuchInstance {
			anyPresent = true
			break
		}
	}
	if !anyPresent {
		return InterfaceMetricSampleV1{}, reasonNotPresent
	}
	// Identity first: a port that no longer carries the bound identity is not reported.
	if target.ExpectedName != nil {
		name, ok := get(oidPollIfName).octets()
		if !ok || string(name) != *target.ExpectedName {
			return InterfaceMetricSampleV1{}, reasonIdentityChanged
		}
	}
	if target.ExpectedPhysAddress != nil {
		mac, ok := get(oidIfPhysAddress).octets()
		if !ok || len(mac) != 6 || formatMAC(mac) != strings.ToLower(*target.ExpectedPhysAddress) {
			return InterfaceMetricSampleV1{}, reasonIdentityChanged
		}
	}

	s := InterfaceMetricSampleV1{InterfaceID: target.InterfaceID, InterfaceEpoch: target.InterfaceEpoch,
		SampledAt: at.UTC().Format("2006-01-02T15:04:05.000Z"), Unavailable: map[string]string{}, DeviceUptimeTicks: uptime}
	if uptime == nil {
		s.Unavailable["deviceUptimeTicks"] = reasonNotSupported
	}
	mark := func(field, reason string) { s.Unavailable[field] = reason }

	// Octets and packets share one width: HC (64) when both HC octet columns exist, else legacy 32-bit.
	hcIn, okHCIn := get(oidIfHCInOctets).unsigned(gosnmp.Counter64)
	hcOut, okHCOut := get(oidIfHCOutOctets).unsigned(gosnmp.Counter64)
	in32, okIn32 := get(oidIfInOctets).unsigned(gosnmp.Counter32)
	out32, okOut32 := get(oidIfOutOctets).unsigned(gosnmp.Counter32)
	switch {
	case okHCIn && okHCOut:
		s.CounterWidth = intPtr(64)
		s.InOctets, s.OutOctets = strPtr(DecimalCounter(hcIn)), strPtr(DecimalCounter(hcOut))
		packets := func(columns ...string) (*string, bool) {
			var sum uint64 // wraps modulo 2^64 exactly like its Counter64 terms
			for _, column := range columns {
				v, ok := get(column).unsigned(gosnmp.Counter64)
				if !ok {
					return nil, false
				}
				sum += v
			}
			return strPtr(DecimalCounter(sum)), true
		}
		var ok bool
		if s.InPackets, ok = packets(oidIfHCInUcastPkts, oidIfHCInMulticastPkts, oidIfHCInBroadcastPkts); !ok {
			mark("inPackets", reasonPacketsIncomplete)
		}
		if s.OutPackets, ok = packets(oidIfHCOutUcastPkts, oidIfHCOutMulticastPkts, oidIfHCOutBroadcastPkts); !ok {
			mark("outPackets", reasonPacketsIncomplete)
		}
	case okIn32 && okOut32:
		s.CounterWidth = intPtr(32)
		s.InOctets, s.OutOctets = strPtr(DecimalCounter(in32)), strPtr(DecimalCounter(out32))
		mark("inPackets", reasonPacketsIncomplete)
		mark("outPackets", reasonPacketsIncomplete)
	default:
		for _, field := range []string{"inOctets", "outOctets", "inPackets", "outPackets"} {
			mark(field, reasonCounterUnavailable)
		}
	}

	counter32 := func(column, field string, into **string) {
		v := get(column)
		if n, ok := v.unsigned(gosnmp.Counter32); ok {
			*into = strPtr(DecimalCounter(n))
			return
		}
		reason := v.reason
		if reason == "" {
			reason = reasonNotSupported
		}
		mark(field, reason)
	}
	counter32(oidIfInErrors, "inErrors", &s.InErrors)
	counter32(oidIfOutErrors, "outErrors", &s.OutErrors)
	counter32(oidIfInDiscards, "inDiscards", &s.InDiscards)
	counter32(oidIfOutDiscards, "outDiscards", &s.OutDiscards)

	// Capacity: ifSpeed below its 2^32-1 ceiling, else ifHighSpeed (Mbit/s). Zero is "not reported", never 0 bps.
	// A saturated ifSpeed (2^32-1) is only a floor (RFC 2863): without a usable
	// ifHighSpeed the capacity is unknown, never 4,294,967,295 bps.
	speed, okSpeed := get(oidIfSpeed).unsigned(gosnmp.Gauge32, gosnmp.Uinteger32)
	high, okHigh := get(oidIfHighSpeed).unsigned(gosnmp.Gauge32, gosnmp.Uinteger32)
	switch {
	case okSpeed && speed > 0 && speed < 4294967295:
		s.CapacityBps = strPtr(DecimalCounter(speed))
	case okHigh && high > 0 && high <= 4294967295:
		s.CapacityBps = strPtr(HighSpeedBps(uint32(high)))
	default:
		mark("capacityBps", reasonSpeedNotReported)
	}

	if t, ok := get(oidIfCounterDiscontinuityTime).unsigned(gosnmp.TimeTicks); ok {
		s.DiscontinuityTicks = strPtr(DecimalCounter(t))
	} else {
		mark("discontinuityTicks", reasonNotSupported)
	}

	s.AdminStatus, s.OperStatus = "unknown", "unknown"
	if n, ok := get(oidIfAdminStatus).integer(); ok && adminStatusNames[n] != "" {
		s.AdminStatus = adminStatusNames[n]
	}
	if n, ok := get(oidIfOperStatus).integer(); ok && operStatusNames[n] != "" {
		s.OperStatus = operStatusNames[n]
	}
	mark("reportedInBps", reasonNotSupported)
	mark("reportedOutBps", reasonNotSupported)
	s.Normalize()
	return s, ""
}

// CollectInterfaceMetrics reads the approved interfaces, one bounded GET each.
// It returns an error only for a request the server should never have sent;
// device failures become the snapshot's outcome and reason.
func CollectInterfaceMetrics(ctx context.Context, reader InterfaceMetricReader, request InterfaceMetricRequest) (InterfaceMetricSnapshot, error) {
	if len(request.Interfaces) == 0 || len(request.Interfaces) > InterfaceMetricsMaxSamples {
		return InterfaceMetricSnapshot{}, fmt.Errorf("interface poll needs 1-%d interfaces", InterfaceMetricsMaxSamples)
	}
	clock := request.Clock
	if clock == nil {
		clock = time.Now
	}
	if !request.Deadline.IsZero() {
		var cancel context.CancelFunc
		ctx, cancel = context.WithDeadline(ctx, request.Deadline)
		defer cancel()
	}
	snap := InterfaceMetricSnapshot{Omitted: map[string]int{}}
	fail := func(reason string) (InterfaceMetricSnapshot, error) {
		snap.Samples = nil
		snap.Outcome = "failed"
		snap.ReasonCode = strPtr(reason)
		return snap, nil
	}

	// sysUpTime first: it anchors counter continuity and proves reachability/auth.
	var uptime *string
	head, err := getAll(ctx, reader, []string{oidSysUpTime})
	if err != nil {
		return fail(classifyGetError(err))
	}
	if t, ok := valueOf(head, oidSysUpTime).unsigned(gosnmp.TimeTicks); ok {
		uptime = strPtr(DecimalCounter(t))
	}

	for _, target := range request.Interfaces {
		if err := ctx.Err(); err != nil {
			snap.Omitted[classifyGetError(err)]++
			continue
		}
		pdus, err := getAll(ctx, reader, oidsFor(request.Version, target.IfIndex))
		if err != nil {
			snap.Omitted[classifyGetError(err)]++
			continue
		}
		sample, skip := buildSample(target, pdus, uptime, clock())
		if skip != "" {
			snap.Omitted[skip]++
			continue
		}
		snap.Samples = append(snap.Samples, sample)
	}

	if len(snap.Omitted) == 0 {
		snap.Outcome = "complete"
		return snap, nil
	}
	// The dominant omission reason (ties broken by name) explains the outcome.
	reasons := make([]string, 0, len(snap.Omitted))
	for reason := range snap.Omitted {
		reasons = append(reasons, reason)
	}
	sort.Slice(reasons, func(i, j int) bool {
		if snap.Omitted[reasons[i]] != snap.Omitted[reasons[j]] {
			return snap.Omitted[reasons[i]] > snap.Omitted[reasons[j]]
		}
		return reasons[i] < reasons[j]
	})
	if len(snap.Samples) == 0 {
		omitted := snap.Omitted
		out, _ := fail(reasons[0])
		out.Omitted = omitted
		return out, nil
	}
	snap.Outcome = "partial"
	snap.ReasonCode = strPtr(reasons[0])
	return snap, nil
}
