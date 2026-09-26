package snmppoll

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"strconv"
	"time"
	"unicode/utf8"
)

// Interface measurement transport v1 (topology M3 Task 1). This mirrors
// packages/shared/src/validators/topologyTelemetry.ts: both parsers are tested
// against packages/shared/src/testing/topology-interface-metrics-v1.json.
//
// Counters are unsigned decimal strings so a uint64 never passes through a
// float. A reading the device did not report is nil plus a reason in
// Unavailable, never 0. The envelope carries no org/site/device identity: the
// server derives scope from the stored poll authority.

const (
	InterfaceMetricsSchemaVersion = 1
	InterfaceMetricsFamily        = "if_metrics"
	InterfaceMetricsMaxSamples    = 256
	InterfaceMetricsMaxBytes      = 512 * 1024
	InterfaceMetricsMinInterval   = 30
	InterfaceMetricsMaxInterval   = 300
	// InterfaceMetricNotReported is the reason recorded for a supported field
	// that was absent from a sample.
	InterfaceMetricNotReported = "not_reported"
)

// InterfaceMetricSampleV1 is one interface's readings at one instant.
type InterfaceMetricSampleV1 struct {
	InterfaceID        string            `json:"interfaceId"`
	InterfaceEpoch     string            `json:"interfaceEpoch"`
	SampledAt          string            `json:"sampledAt"`
	CounterWidth       *int              `json:"counterWidth"`
	InOctets           *string           `json:"inOctets"`
	OutOctets          *string           `json:"outOctets"`
	InErrors           *string           `json:"inErrors"`
	OutErrors          *string           `json:"outErrors"`
	InDiscards         *string           `json:"inDiscards"`
	OutDiscards        *string           `json:"outDiscards"`
	InPackets          *string           `json:"inPackets"`
	OutPackets         *string           `json:"outPackets"`
	CapacityBps        *string           `json:"capacityBps"`
	DiscontinuityTicks *string           `json:"discontinuityTicks"`
	DeviceUptimeTicks  *string           `json:"deviceUptimeTicks"`
	ReportedInBps      *float64          `json:"reportedInBps"`
	ReportedOutBps     *float64          `json:"reportedOutBps"`
	AdminStatus        string            `json:"adminStatus"`
	OperStatus         string            `json:"operStatus"`
	Unavailable        map[string]string `json:"unavailable"`
}

// InterfaceMetricEnvelopeV1 is one bounded if_metrics batch from one source.
type InterfaceMetricEnvelopeV1 struct {
	SchemaVersion           int                       `json:"schemaVersion"`
	Family                  string                    `json:"family"`
	ProducerEpoch           string                    `json:"producerEpoch"`
	Sequence                string                    `json:"sequence"`
	CommandID               *string                   `json:"commandId"`
	ConfigurationRevision   string                    `json:"configurationRevision"`
	StartedAt               string                    `json:"startedAt"`
	FinishedAt              string                    `json:"finishedAt"`
	CaptureAgeAtSendMs      *int64                    `json:"captureAgeAtSendMs"`
	ExpectedIntervalSeconds int                       `json:"expectedIntervalSeconds"`
	Outcome                 string                    `json:"outcome"`
	ReasonCode              *string                   `json:"reasonCode"`
	Samples                 []InterfaceMetricSampleV1 `json:"samples"`
}

var (
	decimalUint64Pattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,19})$`)
	reasonPattern        = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
	uuidPattern          = regexp.MustCompile(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$`)
	utcTimestampPattern  = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$`)
	adminStatuses        = map[string]bool{"up": true, "down": true, "testing": true, "unknown": true}
	operStatuses         = map[string]bool{"up": true, "down": true, "testing": true, "unknown": true, "dormant": true, "not_present": true, "lower_layer_down": true}
	collectionOutcomes   = map[string]bool{"complete": true, "partial": true, "failed": true, "unsupported": true, "not_attempted": true}
)

// DecimalCounter renders a counter without any float conversion.
func DecimalCounter(value uint64) string { return strconv.FormatUint(value, 10) }

// HighSpeedBps converts IF-MIB ifHighSpeed (Mbit/s) to bits/second in uint64.
func HighSpeedBps(value uint32) string { return strconv.FormatUint(uint64(value)*1000000, 10) }

type measuredField struct {
	name    string
	counter func(*InterfaceMetricSampleV1) **string
	rate    func(*InterfaceMetricSampleV1) **float64
	// bits bounds the value: 64, 32, or 0 for "per counterWidth".
	bits int
}

var measuredFields = []measuredField{
	{name: "inOctets", counter: func(s *InterfaceMetricSampleV1) **string { return &s.InOctets }},
	{name: "outOctets", counter: func(s *InterfaceMetricSampleV1) **string { return &s.OutOctets }},
	{name: "inErrors", counter: func(s *InterfaceMetricSampleV1) **string { return &s.InErrors }, bits: 32},
	{name: "outErrors", counter: func(s *InterfaceMetricSampleV1) **string { return &s.OutErrors }, bits: 32},
	{name: "inDiscards", counter: func(s *InterfaceMetricSampleV1) **string { return &s.InDiscards }, bits: 32},
	{name: "outDiscards", counter: func(s *InterfaceMetricSampleV1) **string { return &s.OutDiscards }, bits: 32},
	{name: "inPackets", counter: func(s *InterfaceMetricSampleV1) **string { return &s.InPackets }},
	{name: "outPackets", counter: func(s *InterfaceMetricSampleV1) **string { return &s.OutPackets }},
	{name: "capacityBps", counter: func(s *InterfaceMetricSampleV1) **string { return &s.CapacityBps }, bits: 64},
	{name: "discontinuityTicks", counter: func(s *InterfaceMetricSampleV1) **string { return &s.DiscontinuityTicks }, bits: 32},
	{name: "deviceUptimeTicks", counter: func(s *InterfaceMetricSampleV1) **string { return &s.DeviceUptimeTicks }, bits: 32},
	{name: "reportedInBps", rate: func(s *InterfaceMetricSampleV1) **float64 { return &s.ReportedInBps }},
	{name: "reportedOutBps", rate: func(s *InterfaceMetricSampleV1) **float64 { return &s.ReportedOutBps }},
}

func (f measuredField) present(s *InterfaceMetricSampleV1) bool {
	if f.counter != nil {
		return *f.counter(s) != nil
	}
	return *f.rate(s) != nil
}

// Normalize records the not_reported reason for every unmeasured field that
// has no reason yet. Producers call it before encoding.
func (s *InterfaceMetricSampleV1) Normalize() {
	if s.Unavailable == nil {
		s.Unavailable = map[string]string{}
	}
	for _, f := range measuredFields {
		if _, ok := s.Unavailable[f.name]; !f.present(s) && !ok {
			s.Unavailable[f.name] = InterfaceMetricNotReported
		}
	}
}

func validKey(v string) bool { return v != "" && len(v) <= 255 && utf8.ValidString(v) }
func validReason(v string) bool {
	return len(v) <= 64 && reasonPattern.MatchString(v)
}
func parseUTC(v string) (time.Time, error) {
	if !utcTimestampPattern.MatchString(v) {
		return time.Time{}, fmt.Errorf("timestamp %q must be UTC ISO-8601", v)
	}
	return time.Parse(time.RFC3339Nano, v)
}
func parseDecimal(v string) (uint64, error) {
	if !decimalUint64Pattern.MatchString(v) {
		return 0, fmt.Errorf("%q is not an unsigned decimal", v)
	}
	return strconv.ParseUint(v, 10, 64)
}

// Validate enforces the same rules as the shared TypeScript schema.
func (s *InterfaceMetricSampleV1) Validate() error {
	if !uuidPattern.MatchString(s.InterfaceID) {
		return errors.New("interfaceId must be a UUID")
	}
	if !validKey(s.InterfaceEpoch) {
		return errors.New("interfaceEpoch must be 1-255 UTF-8 bytes")
	}
	if _, err := parseUTC(s.SampledAt); err != nil {
		return fmt.Errorf("sampledAt: %w", err)
	}
	if s.CounterWidth != nil && *s.CounterWidth != 32 && *s.CounterWidth != 64 {
		return fmt.Errorf("counterWidth %d is unsupported", *s.CounterWidth)
	}
	if !adminStatuses[s.AdminStatus] {
		return fmt.Errorf("adminStatus %q is unknown", s.AdminStatus)
	}
	if !operStatuses[s.OperStatus] {
		return fmt.Errorf("operStatus %q is unknown", s.OperStatus)
	}
	known := map[string]bool{}
	wide := false
	for _, f := range measuredFields {
		known[f.name] = true
		if f.rate != nil {
			if r := *f.rate(s); r != nil && (math.IsNaN(*r) || math.IsInf(*r, 0) || *r < 0 || *r > 9007199254740991) {
				return fmt.Errorf("%s must be a finite nonnegative rate", f.name)
			}
			continue
		}
		p := *f.counter(s)
		if p == nil {
			continue
		}
		value, err := parseDecimal(*p)
		if err != nil {
			return fmt.Errorf("%s: %w", f.name, err)
		}
		limit := uint64(math.MaxUint64)
		switch {
		case f.bits == 32:
			limit = math.MaxUint32
		case f.bits == 0:
			wide = true
			if s.CounterWidth != nil && *s.CounterWidth == 32 {
				limit = math.MaxUint32
			}
		}
		if value > limit {
			return fmt.Errorf("%s exceeds its width", f.name)
		}
	}
	if wide && s.CounterWidth == nil {
		return errors.New("counterWidth is required with octet/packet counters")
	}
	for name, reason := range s.Unavailable {
		if !known[name] {
			return fmt.Errorf("unavailable names unknown field %q", name)
		}
		if !validReason(reason) {
			return fmt.Errorf("unavailable reason %q is invalid", reason)
		}
	}
	for _, f := range measuredFields {
		if _, ok := s.Unavailable[f.name]; ok && f.present(s) {
			return fmt.Errorf("%s is measured and unavailable", f.name)
		}
	}
	return nil
}

// Validate enforces the envelope rules, including every sample.
func (e *InterfaceMetricEnvelopeV1) Validate() error {
	if e.SchemaVersion != InterfaceMetricsSchemaVersion {
		return fmt.Errorf("unsupported schemaVersion %d", e.SchemaVersion)
	}
	if e.Family != InterfaceMetricsFamily {
		return fmt.Errorf("family %q is not %s", e.Family, InterfaceMetricsFamily)
	}
	if !validKey(e.ProducerEpoch) || !validKey(e.ConfigurationRevision) {
		return errors.New("producerEpoch and configurationRevision must be 1-255 UTF-8 bytes")
	}
	if _, err := parseDecimal(e.Sequence); err != nil {
		return fmt.Errorf("sequence: %w", err)
	}
	if e.CommandID != nil && !uuidPattern.MatchString(*e.CommandID) {
		return errors.New("commandId must be a UUID")
	}
	started, err := parseUTC(e.StartedAt)
	if err != nil {
		return fmt.Errorf("startedAt: %w", err)
	}
	finished, err := parseUTC(e.FinishedAt)
	if err != nil {
		return fmt.Errorf("finishedAt: %w", err)
	}
	if e.CaptureAgeAtSendMs != nil && (*e.CaptureAgeAtSendMs < 0 || *e.CaptureAgeAtSendMs > 86400000) {
		return errors.New("captureAgeAtSendMs is out of range")
	}
	if e.ExpectedIntervalSeconds < InterfaceMetricsMinInterval || e.ExpectedIntervalSeconds > InterfaceMetricsMaxInterval {
		return fmt.Errorf("expectedIntervalSeconds %d is out of range", e.ExpectedIntervalSeconds)
	}
	window := finished.Sub(started)
	if window < 0 || window > time.Duration(e.ExpectedIntervalSeconds)*time.Second {
		return errors.New("invalid collection window")
	}
	if !collectionOutcomes[e.Outcome] {
		return fmt.Errorf("outcome %q is unknown", e.Outcome)
	}
	if e.ReasonCode != nil && !validReason(*e.ReasonCode) {
		return errors.New("reasonCode is invalid")
	}
	if (e.Outcome == "complete") != (e.ReasonCode == nil) {
		return errors.New("only a complete collection omits its reason")
	}
	if e.Samples == nil {
		return errors.New("samples are required")
	}
	if len(e.Samples) > InterfaceMetricsMaxSamples {
		return fmt.Errorf("samples exceed %d", InterfaceMetricsMaxSamples)
	}
	if len(e.Samples) > 0 && (e.Outcome == "failed" || e.Outcome == "unsupported" || e.Outcome == "not_attempted") {
		return errors.New("a failed collection carries no samples")
	}
	seen := map[string]bool{}
	for i := range e.Samples {
		s := &e.Samples[i]
		if err := s.Validate(); err != nil {
			return fmt.Errorf("samples[%d]: %w", i, err)
		}
		at, _ := parseUTC(s.SampledAt)
		if at.Before(started) || at.After(finished) {
			return fmt.Errorf("samples[%d]: sampledAt is outside the collection window", i)
		}
		if seen[s.InterfaceID] {
			return fmt.Errorf("samples[%d]: duplicate interface sample", i)
		}
		seen[s.InterfaceID] = true
	}
	return nil
}

func strictDecode(data []byte, into any) error {
	if len(data) > InterfaceMetricsMaxBytes {
		return fmt.Errorf("payload exceeds %d bytes", InterfaceMetricsMaxBytes)
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(into); err != nil {
		return err
	}
	if _, err := d.Token(); !errors.Is(err, io.EOF) {
		return errors.New("trailing data after JSON value")
	}
	return nil
}

// DecodeInterfaceMetricSampleV1 strictly decodes, normalizes and validates one sample.
func DecodeInterfaceMetricSampleV1(data []byte) (InterfaceMetricSampleV1, error) {
	var s InterfaceMetricSampleV1
	if err := strictDecode(data, &s); err != nil {
		return InterfaceMetricSampleV1{}, err
	}
	s.Normalize()
	if err := s.Validate(); err != nil {
		return InterfaceMetricSampleV1{}, err
	}
	return s, nil
}

// DecodeInterfaceMetricEnvelopeV1 strictly decodes, normalizes and validates a batch.
func DecodeInterfaceMetricEnvelopeV1(data []byte) (InterfaceMetricEnvelopeV1, error) {
	var e InterfaceMetricEnvelopeV1
	if err := strictDecode(data, &e); err != nil {
		return InterfaceMetricEnvelopeV1{}, err
	}
	for i := range e.Samples {
		e.Samples[i].Normalize()
	}
	if err := e.Validate(); err != nil {
		return InterfaceMetricEnvelopeV1{}, err
	}
	return e, nil
}
