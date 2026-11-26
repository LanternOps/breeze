package agentapp

import (
	"net/http"

	"github.com/breeze-rmm/agent/internal/authstate"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/secmem"
	"github.com/breeze-rmm/agent/internal/workspaceindex"
)

// workspaceIndexClientConfig wires the workspace-index client from the agent
// config. serverURL is a provider, not a copied string, so backup-server-URL
// promotion is followed (#2423). The agent ID builds the default endpoint
// base, which the extension gateway authenticates by (#12690).
func workspaceIndexClientConfig(
	cfg *config.Config,
	serverURL func() string,
	token *secmem.SecureString,
	httpClient *http.Client,
	authMon *authstate.Monitor,
) workspaceindex.ClientConfig {
	return workspaceindex.ClientConfig{
		ServerURL:    serverURL,
		AgentID:      cfg.AgentID,
		EndpointBase: cfg.WorkspaceIndex.EndpointBase,
		AuthToken:    token,
		HTTPClient:   httpClient,
		AuthMonitor:  authMon,
	}
}
