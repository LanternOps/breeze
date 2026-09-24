package hwhealth

import (
	"encoding/json"
	"fmt"
	"strings"
)

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

func parseSpaces(b []byte) (Result, error) {
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
		keys := []string{}
		for _, id := range v.MemberIds {
			keys = append(keys, slotKey(ck, "-", objectHash(id)))
		}
		c.Attributes["memberKeys"] = keys
		r.Components = append(r.Components, c)
	}
	for _, d := range doc.PhysicalDisks {
		if d.UniqueId == "" {
			r.Complete = false
			r.Warnings = append(r.Warnings, "PD UniqueId missing")
			continue
		}
		r.Components = append(r.Components, diskComponent("storage_spaces", slotKey(ck, "-", objectHash(d.UniqueId)), ck, d))
	}
	return r, nil
}
