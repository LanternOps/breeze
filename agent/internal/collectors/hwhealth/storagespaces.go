package hwhealth

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// poolMemberGUID extracts the pool-member identity from a SPACES_PhysicalDisk
// CIM ObjectId (`...SPACES_PhysicalDisk.ObjectId="{subsystem}:PD:{guid}"`).
// Unlike UniqueId it survives Lost Communication: Windows then reports a
// stand-in PhysicalDisk whose UniqueId IS this GUID (verified on Server 2022,
// #6895). Only the GUID is used, never the whole ObjectId, which embeds the
// host name.
var poolMemberGUID = regexp.MustCompile(`(?i):PD:(\{[0-9a-f-]{36}\})`)

// maxSpacesMembers bounds the persisted pool-member identity map.
const maxSpacesMembers = 512

func memberGUID(objectID string) string {
	m := poolMemberGUID.FindStringSubmatch(objectID)
	if m == nil {
		return ""
	}
	return strings.ToLower(m[1])
}

// memberUniqueID returns the UniqueId a disk's component key is derived from.
// A disk reporting its real UniqueId keeps it, so healthy members never change
// key on upgrade. A Lost Communication stand-in (UniqueId equal to its pool
// member GUID) is mapped back to the UniqueId its member last reported, read
// from remembered (the persisted GUID -> UniqueId map); without an entry it
// falls back to the stand-in's own UniqueId, the pre-#6895 behaviour. When
// record is set (the Storage Spaces source, which owns the map) a real
// UniqueId is remembered for its member GUID.
func memberUniqueID(d windowsDisk, remembered map[string]string, record bool) string {
	guid := memberGUID(d.ObjectId)
	if guid == "" {
		return d.UniqueId
	}
	if strings.EqualFold(strings.TrimSpace(d.UniqueId), guid) {
		if known := remembered[guid]; known != "" {
			return known
		}
		return d.UniqueId
	}
	if record && remembered != nil && (len(remembered) < maxSpacesMembers || remembered[guid] != "") {
		remembered[guid] = d.UniqueId
	}
	return d.UniqueId
}

type windowsDisk struct {
	UniqueId, ObjectId, SerialNumber, FriendlyName, Model, FirmwareVersion, HealthStatus, Usage string
	OperationalStatus                                                                           []string
	Size                                                                                        int64
	Temperature, Wear                                                                           *int
	ReadErrorsTotal, WriteErrorsTotal                                                           *int64
}

func osHealth(raw string) *string {
	v := map[string]string{"Healthy": "healthy", "Warning": "warning", "Unhealthy": "unhealthy"}[raw]
	if v == "" {
		return nil
	}
	return &v
}

func windowsState(typ ComponentType, ops []string, usage, health string) string {
	if typ == "physical_disk" {
		if health == "Unhealthy" {
			return "failed"
		}
		if usage == "Retired" {
			return "offline"
		}
		if usage == "HotSpare" {
			return "hotspare"
		}
	}
	maps := map[ComponentType]map[string]string{
		"virtual_disk":  {"OK": "optimal", "InService": "rebuilding", "Degraded": "degraded", "Detached": "offline", "Incomplete": "degraded", "No Redundancy": "degraded"},
		"physical_disk": {"OK": "online", "Predictive Failure": "predictive_failure", "Lost Communication": "missing", "Transient Error": "degraded", "Starting": "online"},
	}
	priority := []string{"Lost Communication", "Detached", "No Redundancy", "Incomplete", "Degraded", "Predictive Failure", "Transient Error", "InService", "Starting", "OK"}
	for _, s := range priority {
		for _, raw := range ops {
			if raw == s {
				if out, ok := maps[typ][raw]; ok {
					return out
				}
			}
		}
	}
	return "unknown"
}

func diskComponent(k Kind, key, parent string, d windowsDisk) Component {
	raw := strings.Join(d.OperationalStatus, ", ")
	c := component(k, "physical_disk", key, parent, d.FriendlyName, raw, windowsState("physical_disk", d.OperationalStatus, d.Usage, d.HealthStatus))
	if c.Name == "" {
		c.Name = d.UniqueId
	}
	c.Serial = ptr(strings.TrimSpace(d.SerialNumber))
	c.Model = ptr(d.Model)
	c.Firmware = ptr(d.FirmwareVersion)
	c.SizeBytes = ptr(d.Size)
	c.OSHealthStatus = osHealth(d.HealthStatus)
	c.TemperatureC = d.Temperature
	c.PredictiveFailure = c.State == "predictive_failure"
	c.Attributes["wearPercent"] = d.Wear
	c.Attributes["readErrors"] = d.ReadErrorsTotal
	c.Attributes["writeErrors"] = d.WriteErrorsTotal
	return c
}

func parseSpaces(b []byte, remembered map[string]string) (Result, error) {
	var doc struct {
		Pools []struct {
			ObjectId, FriendlyName, HealthStatus string
		}
		VirtualDisks []struct {
			ObjectId, FriendlyName, HealthStatus string
			OperationalStatus                    []string
			Size                                 int64
			MemberIds                            []string
			Progress                             *int
		}
		PhysicalDisks []windowsDisk
		Warnings      []string
	}
	if e := json.Unmarshal(b, &doc); e != nil {
		return Result{}, e
	}
	if doc.Pools == nil || doc.VirtualDisks == nil || doc.PhysicalDisks == nil {
		return Result{}, fmt.Errorf("incomplete Storage Spaces response")
	}
	r := Result{Complete: len(doc.Warnings) == 0, Warnings: doc.Warnings}
	if len(doc.Pools) == 0 {
		return r, nil
	}
	ck := "storage_spaces:ctrl"
	r.Components = append(r.Components, component("storage_spaces", "controller", ck, "", "Storage Spaces", "OK", "ok"))
	for _, p := range doc.Pools {
		if p.ObjectId == "" {
			r.Complete = false
			r.Warnings = append(r.Warnings, "pool ObjectId missing")
			continue
		}
		state := map[string]string{"Healthy": "ok", "Warning": "degraded", "Unhealthy": "failed", "Unknown": "unknown"}[p.HealthStatus]
		if state == "" {
			state = "unknown"
		}
		r.Components = append(r.Components, component("storage_spaces", "enclosure", ck+":enc"+objectHash(p.ObjectId), ck, p.FriendlyName, p.HealthStatus, state))
	}
	vdMembers := map[int][]string{}
	for _, v := range doc.VirtualDisks {
		if v.ObjectId == "" {
			r.Complete = false
			r.Warnings = append(r.Warnings, "VD ObjectId missing")
			continue
		}
		key := "storage_spaces:vd:" + objectHash(v.ObjectId)
		c := component("storage_spaces", "virtual_disk", key, ck, v.FriendlyName, strings.Join(v.OperationalStatus, ", "), windowsState("virtual_disk", v.OperationalStatus, "", v.HealthStatus))
		c.SizeBytes = ptr(v.Size)
		c.OSHealthStatus = osHealth(v.HealthStatus)
		if v.Progress != nil && *v.Progress >= 0 && *v.Progress <= 100 {
			c.ProgressPercent = v.Progress
		}
		vdMembers[len(r.Components)] = v.MemberIds
		r.Components = append(r.Components, c)
	}
	// Disk keys first: a VD's MemberIds are the same UniqueIds Get-PhysicalDisk
	// reports in this snapshot, so a stand-in member resolves to the key its
	// disk row uses.
	byUniqueID := map[string]string{}
	seen := map[string]bool{}
	mapFullWarned := false
	for _, d := range doc.PhysicalDisks {
		if d.UniqueId == "" {
			r.Complete = false
			r.Warnings = append(r.Warnings, "PD UniqueId missing")
			continue
		}
		// Surface the two cases where a missing member would still land on a
		// new key: an ObjectId without a PD:{guid} segment, and a full map.
		if g := memberGUID(d.ObjectId); g == "" {
			for _, s := range d.OperationalStatus {
				if s == "Lost Communication" {
					r.Warnings = append(r.Warnings, "pool member identity unavailable for a lost-communication disk; it may appear under a new key")
					break
				}
			}
		} else if !strings.EqualFold(strings.TrimSpace(d.UniqueId), g) && remembered != nil && remembered[g] == "" && len(remembered) >= maxSpacesMembers && !mapFullWarned {
			mapFullWarned = true
			r.Warnings = append(r.Warnings, fmt.Sprintf("pool member identity map full (%d); new members are not tracked", maxSpacesMembers))
		}
		key := slotKey(ck, "-", objectHash(memberUniqueID(d, remembered, true)))
		byUniqueID[d.UniqueId] = key
		if g := memberGUID(d.ObjectId); g != "" {
			seen[g] = true
		}
		r.Components = append(r.Components, diskComponent("storage_spaces", key, ck, d))
	}
	for i, ids := range vdMembers {
		keys := []string{}
		for _, id := range ids {
			key, ok := byUniqueID[id]
			if !ok {
				key = slotKey(ck, "-", objectHash(id))
			}
			keys = append(keys, key)
		}
		r.Components[i].Attributes["memberKeys"] = keys
	}
	// Forget members that left every pool, but only on a complete answer: a
	// partial one must not erase the identity a missing member will need.
	if r.Complete {
		for g := range remembered {
			if !seen[g] {
				delete(remembered, g)
			}
		}
	}
	return r, nil
}
