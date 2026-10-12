package heartbeat

import (
	"github.com/breeze-rmm/agent/internal/collectors/networkcontext"
	"time"
)

func (h *Heartbeat) legacyContextGateway(name, family string) string {
	snapshot := h.freshNetworkContextSnapshot()
	if snapshot == nil {
		return ""
	}
	return unambiguousLegacyGateway(*snapshot, name, family)
}

// legacyContextDNSServers returns the resolvers configured for the named
// adapter, or nil when that is unknown (network context disabled, stale, or
// the snapshot cannot attribute resolvers to this adapter).
func (h *Heartbeat) legacyContextDNSServers(name string) []string {
	snapshot := h.freshNetworkContextSnapshot()
	if snapshot == nil {
		return nil
	}
	return legacyResolverAddresses(*snapshot, name)
}

// freshNetworkContextSnapshot returns a copy of the latest snapshot when
// network context is enabled and the capture is under 10 minutes old.
func (h *Heartbeat) freshNetworkContextSnapshot() *networkcontext.Snapshot {
	h.networkContextMu.Lock()
	manager := h.networkContext
	h.networkContextMu.Unlock()
	if manager == nil {
		return nil
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if !manager.enabled || manager.latestSnapshot == nil || time.Since(manager.captured) > 10*time.Minute {
		return nil
	}
	snapshot := *manager.latestSnapshot
	return &snapshot
}

// maxLegacyDNSServers matches the API's dnsServers schema (.max(8)); the
// WebSocket ingest path rejects the whole payload above that.
const maxLegacyDNSServers = 8

// windowsPlaceholderResolvers are the deprecated site-local DNS addresses
// Windows reports on every IPv6-enabled adapter that has no IPv6 resolver
// configured. They are not configured servers; counting them would hide an
// adapter that has no resolver at all (#5803).
var windowsPlaceholderResolvers = map[string]bool{
	"fec0:0:0:ffff::1": true,
	"fec0:0:0:ffff::2": true,
	"fec0:0:0:ffff::3": true,
}

// legacyResolverAddresses maps the snapshot's resolver rows onto one adapter
// name for the IP-history wire shape. Rows scoped to the adapter and unscoped
// (system-wide, e.g. resolv.conf) rows both apply; OS order is preserved
// because it is the resolver preference order. Returns nil when unknown and a
// non-nil empty slice when the adapter positively has no resolver.
func legacyResolverAddresses(snapshot networkcontext.Snapshot, name string) []string {
	if len(snapshot.ContextManifest.Contexts) != 1 || len(snapshot.Resolvers) == 0 {
		return nil
	}
	iface := ""
	for _, s := range snapshot.Interfaces {
		for _, r := range s.Rows {
			if r.Name != name {
				continue
			}
			if iface != "" && iface != r.InterfaceKey {
				return nil
			}
			iface = r.InterfaceKey
		}
	}
	if iface == "" {
		return nil
	}
	out := []string{}
	seen := map[string]bool{}
	for _, s := range snapshot.Resolvers {
		// Partial sections still carry usable rows (resolv.conf is always
		// Partial: split DNS is unavailable); a section with no rows that
		// did not complete means the read failed and the answer is unknown.
		if s.Outcome != networkcontext.Complete && s.Outcome != networkcontext.Partial {
			return nil
		}
		for _, r := range s.Rows {
			if r.InterfaceKey != nil && *r.InterfaceKey != iface {
				continue
			}
			if windowsPlaceholderResolvers[r.Address] || r.Address == "" || seen[r.Address] {
				continue
			}
			seen[r.Address] = true
			out = append(out, r.Address)
			if len(out) == maxLegacyDNSServers {
				return out
			}
		}
	}
	return out
}

// Legacy inventory has no table, context or ECMP fields. Populate a gateway
// only when the complete observed scope has exactly one default next hop.
func unambiguousLegacyGateway(snapshot networkcontext.Snapshot, name, family string) string {
	if snapshot.ContextManifest.Outcome != networkcontext.Complete || len(snapshot.ContextManifest.Contexts) != 1 {
		return ""
	}
	iface := ""
	for _, s := range snapshot.Interfaces {
		if s.Outcome != networkcontext.Complete {
			return ""
		}
		for _, r := range s.Rows {
			if r.Name == name {
				if iface != "" {
					return ""
				}
				iface = r.InterfaceKey
			}
		}
	}
	if iface == "" {
		return ""
	}
	rulesSeen := false
	for _, s := range snapshot.Rules {
		if s.AddressFamily != family {
			continue
		}
		rulesSeen = true
		if s.Outcome != networkcontext.Complete {
			return ""
		}
		for _, r := range s.Rows {
			if r.SelectorCoverage != "complete" || len(r.Selectors) > 0 || r.Action != "lookup" || r.TableKey == nil {
				return ""
			}
			if *r.TableKey != "254" && *r.TableKey != "255" && *r.TableKey != "253" {
				return ""
			}
		}
	}
	if !rulesSeen {
		return ""
	}
	gateway := ""
	for _, s := range snapshot.Routes {
		if s.AddressFamily != family {
			continue
		}
		if s.Outcome != networkcontext.Complete {
			return ""
		}
		for _, r := range s.Rows {
			if r.DestinationPrefix != "0.0.0.0/0" && r.DestinationPrefix != "::/0" {
				continue
			}
			if gateway != "" || len(r.NextHops) != 1 || r.SourcePrefix != "" || r.TableKey != "254" {
				return ""
			}
			hop := r.NextHops[0]
			if hop.InterfaceKey == nil || *hop.InterfaceKey != iface || hop.Address == nil {
				return ""
			}
			gateway = *hop.Address
		}
	}
	return gateway
}
