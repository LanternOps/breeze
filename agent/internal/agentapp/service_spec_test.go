package agentapp

import (
	"reflect"
	"testing"

	"github.com/breeze-rmm/agent/internal/branding"
	"github.com/breeze-rmm/agent/internal/winsvcinstall"
)

// Golden: what `service install` registers with the Windows SCM today. Without
// branding it must not change.
func TestAgentServiceSpecDefaultIsGolden(t *testing.T) {
	restore := branding.SetForTest(branding.Values{})
	defer restore()
	want := winsvcinstall.Spec{
		Name:        "BreezeAgent",
		DisplayName: "Breeze RMM Agent",
		Description: "Breeze Remote Monitoring and Management Agent",
		Args:        []string{"run"},
	}
	if got := agentServiceSpec("BreezeAgent"); !reflect.DeepEqual(got, want) {
		t.Fatalf("agentServiceSpec() = %+v, want %+v", got, want)
	}
}

func TestAgentServiceSpecUsesBrand(t *testing.T) {
	restore := branding.SetForTest(branding.Values{
		AgentServiceDisplayName: "Example MSP Agent",
		AgentServiceDescription: "Example MSP endpoint agent",
	})
	defer restore()
	got := agentServiceSpec("BreezeAgent")
	if got.DisplayName != "Example MSP Agent" || got.Description != "Example MSP endpoint agent" {
		t.Fatalf("agentServiceSpec() did not use the brand: %+v", got)
	}
}

// The service name is an identifier the updater, the MSI and the API key on;
// a brand must never reach it, nor the arguments.
func TestAgentServiceSpecNeverBrandsTheNameOrArgs(t *testing.T) {
	restore := branding.SetForTest(branding.Values{
		AgentServiceDisplayName: "Example MSP Agent",
		AgentServiceDescription: "Example MSP endpoint agent",
	})
	defer restore()
	got := agentServiceSpec("BreezeAgent")
	if got.Name != "BreezeAgent" {
		t.Fatalf("Name = %q, want BreezeAgent", got.Name)
	}
	if !reflect.DeepEqual(got.Args, []string{"run"}) {
		t.Fatalf("Args = %v, want [run]", got.Args)
	}
}
