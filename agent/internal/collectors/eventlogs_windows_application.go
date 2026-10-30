package collectors

import (
	"regexp"
	"strings"
)

// This file intentionally carries no build constraint ("application" is not a
// GOOS/GOARCH, so Go's filename matching does not apply) so the Windows
// Application-log query construction can be unit-tested on macOS/Linux CI.

// applicationInfoProviderAllowlist lists the Application-log providers whose
// Warning and Information events the Windows agent always collects (#8174).
// The winning Event Logs policy can add up to 20 providers. Every other
// provider is collected at Error/Critical only: shipping all
// Information events would be far too much volume. Collected events still pass
// the collector's server-configured minimumLevel filter (default "info"), so a
// policy minimum of "warning" drops their Information events; "error" or higher
// drops all of them.
//
// Keep this list small and add a provider only for a specific use case.
// MsiInstaller covers install/uninstall (1033/1034, 11707/11724).
// APCPBEAgent (APC PowerChute Business Edition): all of its Warning and Information
// events; the motivating case is UPS alerts such as "UPS On Battery"
// (EventID 2000, Warning; #10493).
//
// The API warns at rule save when an event_log rule targets an Information-
// or Warning-level Application source outside the built-ins and policy lists. Its copy lives in
// packages/shared/src/validators/eventLogProviders.ts; keep it and the provider list in
// apps/docs/src/content/docs/features/event-log-forwarding.mdx in sync with this list.
// apps/api/src/services/eventLogProviderAllowlistParity.test.ts checks Go/shared parity only.
var applicationInfoProviderAllowlist = []string{
	"MsiInstaller",
	"APCPBEAgent",
}

// Keep this raw source in parity with the shared policy validator.
const applicationProviderNamePatternSource = `^[A-Za-z0-9][A-Za-z0-9 ._$()-]*$`

var applicationProviderNamePattern = regexp.MustCompile(applicationProviderNamePatternSource)

const maxPolicyApplicationProviders = 20

func validApplicationProviderName(name string) bool {
	return len(name) <= 256 && applicationProviderNamePattern.MatchString(name)
}

func effectiveApplicationProviders(policy []string) []string {
	providers := append([]string(nil), applicationInfoProviderAllowlist...)
	seen := make(map[string]bool, len(providers)+len(policy))
	for _, name := range providers {
		seen[strings.ToLower(name)] = true
	}
	added := 0
	for _, name := range policy {
		key := strings.ToLower(name)
		if !validApplicationProviderName(name) || seen[key] {
			continue
		}
		if added == maxPolicyApplicationProviders {
			break
		}
		providers = append(providers, name)
		seen[key] = true
		added++
	}
	return providers
}

// UpdateApplicationProviders replaces the policy list; an empty list restores
// built-ins only. Invalid or excess entries are returned for caller diagnostics.
func (c *EventLogCollector) UpdateApplicationProviders(providers []string) (changed bool, rejected []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.applicationProvidersConfigured = true
	var accepted []string
	seen := make(map[string]bool)
	for _, raw := range providers {
		name := strings.TrimSpace(raw)
		key := strings.ToLower(name)
		if !validApplicationProviderName(name) {
			rejected = append(rejected, raw)
			continue
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		if len(accepted) == maxPolicyApplicationProviders {
			rejected = append(rejected, raw)
			continue
		}
		accepted = append(accepted, name)
	}
	if !slicesEqual(c.policyApplicationProviders, accepted) {
		c.policyApplicationProviders = accepted
		changed = true
	}
	return changed, rejected
}

// ApplicationProviders returns a copy of the configured policy additions.
func (c *EventLogCollector) ApplicationProviders() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.policyApplicationProviders...)
}

// addedApplicationProviders compares sets case-insensitively, retaining current spelling.
func addedApplicationProviders(current, stored []string) []string {
	seen := make(map[string]bool, len(stored))
	for _, name := range stored {
		seen[strings.ToLower(name)] = true
	}
	var added []string
	for _, name := range current {
		if !seen[strings.ToLower(name)] {
			added = append(added, name)
		}
	}
	return added
}
