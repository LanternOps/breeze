package agentapp

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/branding"
)

// Golden: the root command help text today. Without branding it must not change.
func TestRootCmdShortDefaultIsGolden(t *testing.T) {
	if rootCmd.Short != "Breeze RMM Agent" {
		t.Fatalf("rootCmd.Short = %q, want %q", rootCmd.Short, "Breeze RMM Agent")
	}
}

func TestAgentRootShortWithoutBranding(t *testing.T) {
	restore := branding.SetForTest(branding.Values{})
	defer restore()
	if got := agentRootShort(); got != "Breeze RMM Agent" {
		t.Fatalf("agentRootShort() = %q, want the default", got)
	}
}

func TestAgentRootShortUsesBrand(t *testing.T) {
	restore := branding.SetForTest(branding.Values{AgentCLIShort: "Example MSP Agent"})
	defer restore()
	if got := agentRootShort(); got != "Example MSP Agent" {
		t.Fatalf("agentRootShort() = %q, want the brand", got)
	}
}
