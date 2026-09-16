package networkdiagnostic

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/breeze-rmm/agent/internal/collectors/networkcontext"
	"net/netip"
	"os"
	"testing"
)

func TestDiagnosticPlanVector(t *testing.T) {
	b, e := os.ReadFile("../../../packages/shared/src/testing/topology-diagnostic-vectors.json")
	if e != nil {
		t.Fatal(e)
	}
	var data struct {
		Vectors []struct {
			Plan   json.RawMessage `json:"plan"`
			Digest string          `json:"digest"`
		}
	}
	if e = json.Unmarshal(b, &data); e != nil {
		t.Fatal(e)
	}
	if len(data.Vectors) == 0 {
		t.Fatal("no vectors")
	}
	for _, v := range data.Vectors {
		canonical, e := canonicalPlan(v.Plan)
		if e != nil {
			t.Fatal(e)
		}
		sum := sha256.Sum256(canonical)
		var plan struct {
			Digest string `json:"digest"`
		}
		_ = json.Unmarshal(v.Plan, &plan)
		if hex.EncodeToString(sum[:]) != plan.Digest {
			t.Fatal(hex.EncodeToString(sum[:]), plan.Digest)
		}
	}
}
func TestDestinationPolicy(t *testing.T) {
	route := networkcontext.RouteSelection{InterfaceKey: "if-1", ContextKey: "ctx", Attribution: "observed", NextHop: ptr("fe80::1")}
	for _, address := range []string{"127.0.0.1", "::1", "0.0.0.0", "::", "224.0.0.1", "ff02::1", "169.254.169.254", "169.254.170.2", "100.100.100.200", "fd00:ec2::254", "255.255.255.255"} {
		if e := ValidateDestination(Target{Kind: "configured_target"}, netip.MustParseAddr(address), route); e == nil {
			t.Fatal(address)
		}
	}
	if e := ValidateDestination(Target{Kind: "observed_gateway", Zone: ptr("if-1")}, netip.MustParseAddr("fe80::1"), route); e != nil {
		t.Fatal(e)
	}
	if e := ValidateDestination(Target{Kind: "observed_gateway", Zone: ptr("if-2")}, netip.MustParseAddr("fe80::1"), route); e == nil {
		t.Fatal("foreign zone")
	}
}
