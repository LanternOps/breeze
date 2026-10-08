package agentapp

import "github.com/breeze-rmm/agent/internal/branding"

// agentRootShort is the help text of the root command: the operator's brand
// when the build carries one (see internal/branding), else the default.
// Display only.
func agentRootShort() string {
	return branding.Or(branding.AgentCLIShort, "Breeze RMM Agent")
}
