package main

import "github.com/breeze-rmm/agent/internal/config"

// missingShipperKeys names the agent.yaml keys the helper log shipper needs
// but did not find. Names only — the values are secrets and never logged.
func missingShipperKeys(cfg *config.Config) []string {
	var missing []string
	if cfg.AgentID == "" {
		missing = append(missing, "agent_id")
	}
	if cfg.ServerURL == "" {
		missing = append(missing, "server_url")
	}
	if cfg.HelperAuthToken == "" {
		missing = append(missing, "helper_auth_token")
	}
	return missing
}
