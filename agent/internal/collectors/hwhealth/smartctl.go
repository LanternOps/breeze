package hwhealth

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

type smartDevice struct{ Name, Type string }

func parseSMART(b []byte, exit int, dev smartDevice, now time.Time) (Component, error) {
	if exit < 0 || exit&7 != 0 {
		return Component{}, fmt.Errorf("SMART probe failed (exit %d)", exit)
	}
	var d struct {
		Serial   string `json:"serial_number"`
		Model    string `json:"model_name"`
		Firmware string `json:"firmware_version"`
		Status   struct {
			Passed *bool `json:"passed"`
		} `json:"smart_status"`
		Temperature struct {
			Current *int `json:"current"`
		} `json:"temperature"`
		Capacity struct {
			Bytes int64 `json:"bytes"`
		} `json:"user_capacity"`
		Power struct {
			Hours int64 `json:"hours"`
		} `json:"power_on_time"`
		ATA struct {
			Table []struct {
				ID  int `json:"id"`
				Raw struct {
					Value any `json:"value"`
				} `json:"raw"`
			} `json:"table"`
		} `json:"ata_smart_attributes"`
		NVMe map[string]any `json:"nvme_smart_health_information_log"`
	}
	if e := json.Unmarshal(b, &d); e != nil {
		return Component{}, e
	}
	passed := d.Status.Passed
	if exit&8 != 0 {
		passed = ptr(false)
	}
	state := "unknown"
	predict := false
	if passed != nil {
		if *passed {
			state = "online"
		} else {
			state = "predictive_failure"
			predict = true
		}
	}
	if number(d.NVMe["critical_warning"]) != 0 {
		predict = true
	}
	c := component("smartctl", "physical_disk", smartKey(d.Serial, dev.Type, dev.Name, false), "", dev.Name, "smartctl", state)
	c.Serial = ptr(strings.TrimSpace(d.Serial))
	c.Model = ptr(d.Model)
	c.Firmware = ptr(d.Firmware)
	c.SizeBytes = ptr(d.Capacity.Bytes)
	c.TemperatureC = d.Temperature.Current
	c.SmartPassed = passed
	c.PredictiveFailure = predict

	smart := map[string]any{"observedAt": now.UTC().Format(time.RFC3339Nano), "powerOnHours": d.Power.Hours}
	attrs := map[string]any{}
	for _, a := range d.ATA.Table {
		switch a.ID {
		case 5, 9, 187, 188, 194, 197, 198, 199:
			attrs[fmt.Sprint(a.ID)] = a.Raw.Value
		}
	}
	smart["ata"] = attrs
	for _, k := range []string{"critical_warning", "percentage_used", "media_errors", "unsafe_shutdowns"} {
		if v, ok := d.NVMe[k]; ok {
			smart[k] = v
		}
	}
	c.Attributes["smart"] = smart
	c.Attributes["osDevice"] = dev.Name
	return c, nil
}

func newSMART(extra []string, run toolRunner, now func() time.Time) Source {
	return &source{
		kind: "smartctl",
		tier: TierDisk,
		detect: func(context.Context) Availability {
			p, ok := lookupTool([]string{"smartctl"}, extra)
			return Availability{Path: p, Available: ok}
		},
		collect: func(parent context.Context, a Availability) (Result, error) {
			ctx, cancel := context.WithTimeout(parent, 3*time.Minute)
			defer cancel()
			scan, e := run(ctx, 15*time.Second, a.Path, "--scan-open", "-j")
			if e != nil {
				return Result{}, e
			}
			if scan.ExitCode&7 != 0 {
				return Result{}, fmt.Errorf("smartctl scan exit %d", scan.ExitCode)
			}
			var doc struct{ Devices []smartDevice }
			if e = json.Unmarshal(scan.Stdout, &doc); e != nil {
				return Result{}, e
			}
			if doc.Devices == nil {
				return Result{}, fmt.Errorf("missing smartctl devices")
			}
			r := Result{Complete: true}
			if len(doc.Devices) > 64 {
				doc.Devices = doc.Devices[:64]
				r.Complete = false
				r.Warnings = append(r.Warnings, "scan limited to 64 devices")
			}
			counts := map[string]int{}
			devices := []smartDevice{}
			for _, d := range doc.Devices {
				if ctx.Err() != nil {
					r.Complete = false
					r.Warnings = append(r.Warnings, "SMART budget exceeded")
					break
				}
				args := []string{"-a", "-j", d.Name}
				if d.Type != "" {
					args = append(args, "-d", d.Type)
				}
				o, e := run(ctx, 15*time.Second, a.Path, args...)
				var c Component
				if e == nil {
					c, e = parseSMART(o.Stdout, o.ExitCode, d, now())
				}
				if e != nil {
					r.Complete = false
					r.Warnings = append(r.Warnings, d.Name+": "+e.Error())
					continue
				}
				serial := strings.TrimSpace(*c.Serial)
				if serial != "" {
					counts[serial]++
				}
				r.Components = append(r.Components, c)
				devices = append(devices, d)
			}
			for i := range r.Components {
				c := &r.Components[i]
				c.ComponentKey = smartKey(*c.Serial, devices[i].Type, devices[i].Name, counts[*c.Serial] == 1)
			}
			if len(r.Components) == 0 && !r.Complete {
				return r, fmt.Errorf("all SMART probes failed: %v", r.Warnings)
			}
			return r, nil
		},
	}
}
