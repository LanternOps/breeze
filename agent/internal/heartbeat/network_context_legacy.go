package heartbeat

import (
	"github.com/breeze-rmm/agent/internal/collectors/networkcontext"
	"time"
)

func (h *Heartbeat) legacyContextGateway(name, family string) string {
	h.networkContextMu.Lock()
	manager := h.networkContext
	h.networkContextMu.Unlock()
	if manager == nil {
		return ""
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if !manager.enabled || manager.latestSnapshot == nil || time.Since(manager.captured) > 10*time.Minute {
		return ""
	}
	return unambiguousLegacyGateway(*manager.latestSnapshot, name, family)
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
