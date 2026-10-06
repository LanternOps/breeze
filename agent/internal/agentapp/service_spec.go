package agentapp

import (
	"github.com/breeze-rmm/agent/internal/branding"
	"github.com/breeze-rmm/agent/internal/winsvcinstall"
)

// agentServiceSpec is what `service install` registers with the Windows
// Service Control Manager. name is the fixed service identifier and the
// arguments never change; the display name and the description are the
// operator's brand when the build carries one (see internal/branding), else
// today's text. It lives outside the Windows-only file so it is tested on
// every platform.
func agentServiceSpec(name string) winsvcinstall.Spec {
	return winsvcinstall.Spec{
		Name:        name,
		DisplayName: branding.Or(branding.AgentServiceDisplayName, "Breeze RMM Agent"),
		Description: branding.Or(branding.AgentServiceDescription, "Breeze Remote Monitoring and Management Agent"),
		Args:        []string{"run"},
	}
}
