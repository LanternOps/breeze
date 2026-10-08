package branding

import "strings"

// CanonicalServiceName returns the fixed service name (AgentServiceName or
// WatchdogServiceName) when name is the configured display name of the agent's
// or the watchdog's own service; any other name comes back unchanged.
//
// The Windows Service Control Manager quotes a service's display name in its
// failure events, so a branded service would otherwise reach the API under the
// operator's name and stop being recognised as ours. Without a brand
// configured, nothing is mapped and the name is returned as it came in.
func CanonicalServiceName(name string) string {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return name
	}
	if matchesBrand(trimmed, AgentServiceDisplayName) {
		return AgentServiceName
	}
	if matchesBrand(trimmed, WatchdogServiceDisplayName) {
		return WatchdogServiceName
	}
	return name
}

func matchesBrand(name, brand string) bool {
	brand = strings.TrimSpace(brand)
	return brand != "" && strings.EqualFold(name, brand)
}
