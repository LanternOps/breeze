package snmppoll

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
)

const interfaceMetricFixture = "../../../packages/shared/src/testing/topology-interface-metrics-v1.json"

type interfaceMetricFixtureFile struct {
	Valid         json.RawMessage `json:"valid"`
	Normalization []struct {
		Name     string          `json:"name"`
		Sample   json.RawMessage `json:"sample"`
		Expected json.RawMessage `json:"expected"`
	} `json:"normalization"`
	Invalid []struct {
		Name     string          `json:"name"`
		Envelope json.RawMessage `json:"envelope"`
	} `json:"invalid"`
}

func loadInterfaceMetricFixture(t *testing.T) interfaceMetricFixtureFile {
	t.Helper()
	raw, err := os.ReadFile(interfaceMetricFixture)
	if err != nil {
		t.Fatal(err)
	}
	var f interfaceMetricFixtureFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Valid) == 0 || len(f.Invalid) == 0 || len(f.Normalization) == 0 {
		t.Fatal("interface metric fixture is empty")
	}
	return f
}

// Semantic JSON equality: both sides decoded with UseNumber so uint64 strings
// and float rates compare exactly.
func jsonEqual(t *testing.T, a, b []byte) bool {
	t.Helper()
	decode := func(data []byte) any {
		d := json.NewDecoder(bytes.NewReader(data))
		d.UseNumber()
		var v any
		if err := d.Decode(&v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	return reflect.DeepEqual(decode(a), decode(b))
}

func TestInterfaceMetricContractValidRoundTrip(t *testing.T) {
	f := loadInterfaceMetricFixture(t)
	envelope, err := DecodeInterfaceMetricEnvelopeV1(f.Valid)
	if err != nil {
		t.Fatalf("valid fixture rejected: %v", err)
	}
	if envelope.Samples[0].InOctets == nil || *envelope.Samples[0].InOctets != "18446744073709551615" {
		t.Fatalf("uint64 precision lost: %#v", envelope.Samples[0].InOctets)
	}
	if envelope.Samples[0].OutOctets == nil || *envelope.Samples[0].OutOctets != "0" {
		t.Fatal("a measured zero must stay a measured zero")
	}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if !jsonEqual(t, encoded, f.Valid) {
		t.Fatalf("round trip changed the envelope:\n%s", encoded)
	}
}

func TestInterfaceMetricContractNormalizesAbsentFields(t *testing.T) {
	f := loadInterfaceMetricFixture(t)
	for _, c := range f.Normalization {
		t.Run(c.Name, func(t *testing.T) {
			sample, err := DecodeInterfaceMetricSampleV1(c.Sample)
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(sample)
			if err != nil {
				t.Fatal(err)
			}
			if !jsonEqual(t, encoded, c.Expected) {
				t.Fatalf("got %s want %s", encoded, c.Expected)
			}
		})
	}
}

func TestInterfaceMetricContractRejectsInvalid(t *testing.T) {
	f := loadInterfaceMetricFixture(t)
	for _, c := range f.Invalid {
		t.Run(c.Name, func(t *testing.T) {
			if _, err := DecodeInterfaceMetricEnvelopeV1(c.Envelope); err == nil {
				t.Fatalf("accepted invalid envelope %s", c.Name)
			}
		})
	}
}

func TestInterfaceMetricContractSampleBound(t *testing.T) {
	f := loadInterfaceMetricFixture(t)
	base, err := DecodeInterfaceMetricEnvelopeV1(f.Valid)
	if err != nil {
		t.Fatal(err)
	}
	build := func(n int) []byte {
		e := base
		e.Samples = make([]InterfaceMetricSampleV1, n)
		for i := range e.Samples {
			s := base.Samples[0]
			s.InterfaceID = fmt.Sprintf("44444444-4444-4444-8444-%012x", i)
			e.Samples[i] = s
		}
		out, err := json.Marshal(e)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	if _, err := DecodeInterfaceMetricEnvelopeV1(build(InterfaceMetricsMaxSamples)); err != nil {
		t.Fatalf("256 samples must be accepted: %v", err)
	}
	if _, err := DecodeInterfaceMetricEnvelopeV1(build(InterfaceMetricsMaxSamples + 1)); err == nil || !strings.Contains(err.Error(), "samples") {
		t.Fatalf("257 samples must be rejected, got %v", err)
	}
}

func TestInterfaceMetricDecimalHelpers(t *testing.T) {
	if got := DecimalCounter(18446744073709551615); got != "18446744073709551615" {
		t.Fatalf("DecimalCounter = %s", got)
	}
	if got := HighSpeedBps(4294967295); got != "4294967295000000" {
		t.Fatalf("HighSpeedBps = %s", got)
	}
}
