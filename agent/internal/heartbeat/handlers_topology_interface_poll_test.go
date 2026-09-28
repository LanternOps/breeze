package heartbeat

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/snmppoll"
	"github.com/gosnmp/gosnmp"
)

const interfacePollFixturePath = "../../../packages/shared/src/testing/topology-interface-poll-v1.json"

type stubInterfaceReader struct{ calls int }

func (s *stubInterfaceReader) Get(_ context.Context, oids []string) ([]gosnmp.SnmpPDU, error) {
	s.calls++
	out := make([]gosnmp.SnmpPDU, len(oids))
	for i, oid := range oids {
		out[i] = gosnmp.SnmpPDU{Name: "." + oid, Type: gosnmp.NoSuchInstance}
		switch {
		case oid == "1.3.6.1.2.1.1.3.0":
			out[i] = gosnmp.SnmpPDU{Name: "." + oid, Type: gosnmp.TimeTicks, Value: uint32(500)}
		case strings.HasPrefix(oid, "1.3.6.1.2.1.2.2.1.7."), strings.HasPrefix(oid, "1.3.6.1.2.1.2.2.1.8."):
			out[i] = gosnmp.SnmpPDU{Name: "." + oid, Type: gosnmp.Integer, Value: 1}
		case strings.HasPrefix(oid, "1.3.6.1.2.1.31.1.1.1.6."), strings.HasPrefix(oid, "1.3.6.1.2.1.31.1.1.1.10."):
			out[i] = gosnmp.SnmpPDU{Name: "." + oid, Type: gosnmp.Counter64, Value: uint64(18446744073709551615)}
		}
	}
	return out, nil
}

func interfacePollPayload(t *testing.T, key string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(interfacePollFixturePath)
	if err != nil {
		t.Fatal(err)
	}
	var f map[string]json.RawMessage
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(f[key], &payload); err != nil {
		t.Fatal(err)
	}
	// Identity assertions are exercised in snmppoll; the stub reports no ifName/MAC.
	for _, entry := range payload["interfaces"].([]any) {
		entry.(map[string]any)["expectedName"] = nil
		entry.(map[string]any)["expectedPhysAddress"] = nil
	}
	return payload
}

func withStubInterfaceReader(t *testing.T) *stubInterfaceReader {
	t.Helper()
	stub := &stubInterfaceReader{}
	previous := openInterfaceMetricReader
	openInterfaceMetricReader = func(snmppoll.SNMPDevice) (snmppoll.InterfaceMetricReader, func(), error) { return stub, func() {}, nil }
	t.Cleanup(func() { openInterfaceMetricReader = previous })
	return stub
}

func TestSNMPInterfaceMetricsHandlerAnswersWithAnEnvelope(t *testing.T) {
	stub := withStubInterfaceReader(t)
	cmd := Command{ID: "33333333-3333-4333-8333-333333333333", Type: tools.CmdTopologyInterfacePoll, Payload: interfacePollPayload(t, "validV2c")}
	result := handlerRegistry[tools.CmdTopologyInterfacePoll](nil, cmd)
	if result.Status != "completed" {
		t.Fatalf("status %s: %s", result.Status, result.Error)
	}
	envelope, err := snmppoll.DecodeInterfaceMetricEnvelopeV1([]byte(result.Stdout))
	if err != nil {
		t.Fatalf("result is not a valid envelope: %v\n%s", err, result.Stdout)
	}
	if envelope.CommandID == nil || *envelope.CommandID != cmd.ID || envelope.Sequence != "42" || len(envelope.Samples) != 2 || envelope.Outcome != "complete" {
		t.Fatalf("envelope = %s", result.Stdout)
	}
	if *envelope.Samples[0].InOctets != "18446744073709551615" || stub.calls == 0 {
		t.Fatalf("counter precision lost or no reads: %s", result.Stdout)
	}
	if strings.Contains(result.Stdout, "public-ro") {
		t.Fatal("the community must never be echoed")
	}
}

func TestSNMPInterfaceMetricsHandlerRefusesErasedOrMalformedCommands(t *testing.T) {
	stub := withStubInterfaceReader(t)
	for name, payload := range map[string]map[string]any{
		"erased":    interfacePollPayload(t, "erased"),
		"malformed": {"version": 1, "oids": []any{"1.3.6.1"}},
	} {
		result := handlerRegistry[tools.CmdTopologyInterfacePoll](nil, Command{ID: "33333333-3333-4333-8333-333333333333", Type: tools.CmdTopologyInterfacePoll, Payload: payload})
		if result.Status != "failed" {
			t.Fatalf("%s: status %s", name, result.Status)
		}
	}
	if stub.calls != 0 {
		t.Fatal("a refused command must not touch the device")
	}
}

func TestSNMPInterfaceMetricsHandlerBoundsConcurrency(t *testing.T) {
	withStubInterfaceReader(t)
	for i := 0; i < cap(interfacePollSlots); i++ {
		interfacePollSlots <- struct{}{}
	}
	defer func() {
		for len(interfacePollSlots) > 0 {
			<-interfacePollSlots
		}
	}()
	result := handlerRegistry[tools.CmdTopologyInterfacePoll](nil, Command{ID: "33333333-3333-4333-8333-333333333333", Type: tools.CmdTopologyInterfacePoll, Payload: interfacePollPayload(t, "validV2c")})
	if result.Status != "failed" || !strings.Contains(result.Error, "concurrency") {
		t.Fatalf("expected a concurrency refusal, got %s %s", result.Status, result.Error)
	}
}

func TestSNMPInterfaceMetricsCapabilityAdvertised(t *testing.T) {
	for _, capability := range topologyDiagnosticCapabilities(false) {
		if capability.Name == "topology_interface_poll" && capability.Version == 1 && capability.Supported {
			return
		}
	}
	t.Fatal("topology_interface_poll v1 must be advertised")
}
