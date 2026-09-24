package hwhealth

import (
	"encoding/json"
	"strings"
	"time"
)

type smartCacheEntry struct {
	ObservedAt time.Time `json:"observedAt"`
	Component  Component `json:"component"`
}

func serial(c Component) string {
	if c.Serial == nil {
		return ""
	}
	return strings.TrimSpace(*c.Serial)
}

func vendorSource(k Kind) bool {
	switch k {
	case "storcli", "perccli", "megacli", "ssacli", "arcconf", "omreport", "mdadm", "zfs", "storage_spaces":
		return true
	}
	return false
}

type vendorIdentity struct {
	Source     Kind          `json:"source"`
	Type       ComponentType `json:"type"`
	Serial     string        `json:"serial"`
	Model      string        `json:"model"`
	ObservedAt time.Time     `json:"observedAt"`
}

type vendorTopology map[string]vendorIdentity

const maxVendorIdentities = 2000
const maxVendorTopologyBytes = 2 * 1024 * 1024

func updateVendorTopology(previous vendorTopology, rows []Component, reports []SourceReport, now time.Time, interval time.Duration) vendorTopology {
	next, _ := boundedVendorTopology(previous, rows, reports, now, interval)
	return next
}

func boundedVendorTopology(previous vendorTopology, rows []Component, reports []SourceReport, now time.Time, interval time.Duration) (vendorTopology, bool) {
	next := vendorTopology{}
	sizes := map[string]int{}
	used := 2
	add := func(key string, e vendorIdentity) bool {
		if key == "" || wireStringLen(key) > 200 || wireStringLen(e.Serial) > 200 || wireStringLen(e.Model) > 200 {
			return false
		}
		if !vendorSource(e.Source) || (e.Type != "physical_disk" && e.Type != "virtual_disk") {
			return false
		}
		// Include JSON escaping, field names and map-key bytes, not just the raw string lengths.
		b, err := json.Marshal(map[string]vendorIdentity{key: e})
		if err != nil {
			return false
		}
		size := len(b) - 2
		old, exists := sizes[key]
		count := len(next)
		bytes := used - old + size
		if !exists {
			count++
			if len(next) > 0 {
				bytes++
			}
		}
		if count > maxVendorIdentities || bytes > maxVendorTopologyBytes {
			return false
		}
		next[key] = e
		sizes[key] = size
		used = bytes
		return true
	}
	replaced := func(source Kind) bool {
		for _, r := range reports {
			if r.Source == source && r.Status == "ok" && r.Complete != nil && *r.Complete {
				return true
			}
		}
		return false
	}
	for key, e := range previous {
		if now.Before(e.ObservedAt) || now.Sub(e.ObservedAt) >= 2*interval || replaced(e.Source) {
			continue
		}
		if !add(key, e) {
			return vendorTopology{}, true
		}
	}
	for _, c := range rows {
		if !vendorSource(c.Source) || (c.ComponentType != "physical_disk" && c.ComponentType != "virtual_disk") {
			continue
		}
		model := ""
		if c.Model != nil {
			model = *c.Model
		}
		if !add(c.ComponentKey, vendorIdentity{Source: c.Source, Type: c.ComponentType, Serial: serial(c), Model: model, ObservedAt: now}) {
			return vendorTopology{}, true
		}
	}
	return next, false
}

func merge(rows []Component, cache map[string]smartCacheEntry, now time.Time, interval time.Duration, topologies ...vendorTopology) []Component {
	vendors, smarts, wins := map[string]int{}, map[string]int{}, map[string]int{}
	var topology vendorTopology
	if len(topologies) > 0 {
		topology = topologies[0]
	} else {
		topology = updateVendorTopology(nil, rows, nil, now, interval)
	}
	windowsVendors := map[string]int{}
	hasVD := false
	for _, e := range topology {
		if e.Type == "virtual_disk" {
			hasVD = true
		}
		if e.Type == "physical_disk" && e.Serial != "" {
			windowsVendors[e.Serial]++
		}
	}
	for _, c := range rows {
		if c.ComponentType != "physical_disk" {
			continue
		}
		s := serial(c)
		if s == "" {
			continue
		}
		if vendorSource(c.Source) {
			vendors[s]++
		}
		if c.Source == "smartctl" {
			smarts[s]++
		}
		if c.Source == "windows_physical_disk" {
			wins[s]++
		}
	}
	for s, e := range cache {
		if now.Before(e.ObservedAt) || now.Sub(e.ObservedAt) >= 2*interval || smarts[s] > 1 || vendors[s] > 1 {
			delete(cache, s)
		}
	}
	for _, c := range rows {
		if c.Source != "smartctl" || serial(c) == "" || smarts[serial(c)] != 1 {
			continue
		}
		observed := now
		if obj, ok := c.Attributes["smart"].(map[string]any); ok {
			if raw, ok := obj["observedAt"].(string); ok {
				if t, e := time.Parse(time.RFC3339Nano, raw); e == nil {
					observed = t
				}
			}
		}
		cache[serial(c)] = smartCacheEntry{ObservedAt: observed, Component: c}
	}
	out := []Component{}
	for _, input := range rows {
		c := input
		c.Attributes = map[string]any{}
		for k, v := range input.Attributes {
			c.Attributes[k] = v
		}
		s := serial(c)
		if c.ComponentType == "physical_disk" && vendorSource(c.Source) && s != "" && vendors[s] == 1 {
			if e, ok := cache[s]; ok && smarts[s] <= 1 && now.Sub(e.ObservedAt) < 2*interval {
				c.PredictiveFailure = c.PredictiveFailure || e.Component.PredictiveFailure
				c.SmartPassed = e.Component.SmartPassed
				if e.Component.TemperatureC != nil {
					c.TemperatureC = e.Component.TemperatureC
				}
				c.Attributes["smart"] = e.Component.Attributes["smart"]
			}
		}
		if c.Source == "smartctl" && s != "" && smarts[s] == 1 && vendors[s] == 1 {
			continue
		}
		if c.Source == "windows_physical_disk" {
			if s != "" && wins[s] == 1 && windowsVendors[s] == 1 {
				continue
			}
			c.AlertExempt = false
			delete(c.Attributes, "backedByVd")
			if hasVD && c.Model != nil {
				model := strings.ToUpper(*c.Model)
				for _, pattern := range []string{"PERC", "LOGICAL VOLUME", "VIRTUAL DISK", "MR9", "SMART ARRAY", "RAID"} {
					if strings.Contains(model, pattern) {
						c.AlertExempt = true
						c.Attributes["backedByVd"] = true
						break
					}
				}
			}
		}
		out = append(out, c)
	}
	return out
}

// Explicit null clears expired SMART fields; all other tags remain the §C tags.
func (c Component) MarshalJSON() ([]byte, error) {
	type wire Component
	return json.Marshal(struct {
		wire
		TemperatureC *int  `json:"temperatureC"`
		SmartPassed  *bool `json:"smartPassed"`
	}{wire: wire(c), TemperatureC: c.TemperatureC, SmartPassed: c.SmartPassed})
}
