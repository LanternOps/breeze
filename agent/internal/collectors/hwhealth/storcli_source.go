package hwhealth

import (
	"context"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

var storcliCommands = [][]string{
	{"/call", "show", "all", "J"},
	{"/call/vall", "show", "all", "J"},
	{"/call/eall/sall", "show", "all", "J"},
	{"/call/cv", "show", "all", "J"},
	{"/call/bbu", "show", "all", "J"},
	{"/call/eall/sall", "show", "rebuild", "J"},
	{"/call/vall", "show", "init", "J"},
	{"/call/vall", "show", "cc", "J"},
}

func newStorcli(kind Kind, extra []string, run toolRunner) Source {
	return &source{kind: kind, tier: TierRAID, detect: func(context.Context) Availability {
		p, ok := lookupTool([]string{string(kind) + "64", string(kind)}, extra)
		return Availability{Path: p, Available: ok}
	}, collect: func(ctx context.Context, a Availability) (Result, error) {
		r := Result{Complete: true}
		progress := [3][]byte{}
		for i, args := range storcliCommands {
			if ctx.Err() != nil {
				r.Complete = false
				r.Warnings = append(r.Warnings, "budget exceeded")
				break
			}
			out, e := run(ctx, 30*time.Second, a.Path, args...)
			if e == nil && out.ExitCode != 0 {
				e = fmt.Errorf("exit %d", out.ExitCode)
			}
			if e != nil {
				r.Complete = false
				r.Warnings = append(r.Warnings, strings.Join(args, " ")+": "+e.Error())
				continue
			}
			if i >= 5 {
				progress[i-5] = out.Stdout
				continue
			}
			required := [][]string{{"PD LIST", "VD LIST"}, {"VD LIST"}, {"PD LIST"}, {"Cachevault_Info"}, {"BBU_Info"}}
			parsed, e := parseStorcliSections(out.Stdout, kind, required[i]...)
			if e != nil {
				r.Complete = false
				r.Warnings = append(r.Warnings, e.Error())
				continue
			}
			r.Complete = r.Complete && parsed.Complete
			r.Warnings = append(r.Warnings, parsed.Warnings...)
			r.Components = mergeComponents(r.Components, parsed.Components)
		}
		joinStorcliMembers(r.Components)
		for i, b := range progress {
			if b == nil {
				continue
			}
			if e := applyStorcliProgress(b, kind, &r, i); e != nil {
				r.Complete = false
				r.Warnings = append(r.Warnings, e.Error())
			}
		}
		if len(r.Components) == 0 && !r.Complete {
			return r, fmt.Errorf("all %s queries failed: %v", kind, r.Warnings)
		}
		return r, nil
	}}
}

func joinStorcliMembers(rows []Component) {
	for i := range rows {
		v := &rows[i]
		if v.ComponentType != "virtual_disk" || v.ParentKey == nil {
			continue
		}
		keys := []string{}
		for _, p := range rows {
			if p.ComponentType == "physical_disk" && p.ParentKey != nil && *p.ParentKey == *v.ParentKey && p.Attributes["diskGroup"] != nil && textValue(p.Attributes["diskGroup"]) == textValue(v.Attributes["diskGroup"]) {
				keys = append(keys, p.ComponentKey)
			}
		}
		sort.Strings(keys)
		v.Attributes["memberKeys"] = keys
	}
}

var storcliProgressDrive = regexp.MustCompile(`^/c([0-9]+)/e([0-9]+)/s([0-9]+)$`)
var storcliProgressPath = regexp.MustCompile(`/c([0-9]+)/e([0-9]+)/s([0-9]+)(?:/|$)`)
var storcliProgressVD = regexp.MustCompile(`^/c([0-9]+)/v([0-9]+)$`)

func storcliProgressKey(m jsonObject, path string, kind Kind, controller string) (string, ComponentType, error) {
	ck := controllerKey(kind, controller)
	key := ""
	var typ ComponentType
	accept := func(candidate string, t ComponentType) bool {
		if key != "" && (candidate != key || typ != t) {
			return false
		}
		key, typ = candidate, t
		return true
	}
	drive := func(p []string) bool {
		if len(p) != 4 {
			return false
		}
		c, ok := storcliNumericID(p[1])
		if !ok || c != controller {
			return false
		}
		enclosure, ok := storcliNumericID(p[2])
		if !ok {
			return false
		}
		slot, ok := storcliNumericID(p[3])
		return ok && accept(slotKey(ck, enclosure, slot), "physical_disk")
	}
	invalid := func() (string, ComponentType, error) {
		return "", "", fmt.Errorf("%s: missing, invalid or conflicting progress identity", ck)
	}
	if raw, exists := m["Drive-ID"]; exists {
		v, ok := raw.(string)
		if !ok || !drive(storcliProgressDrive.FindStringSubmatch(v)) {
			return invalid()
		}
	}
	for _, p := range storcliProgressPath.FindAllStringSubmatch(path, -1) {
		if !drive(p) {
			return invalid()
		}
	}
	if raw, exists := m["EID:Slt"]; exists {
		v, ok := raw.(string)
		if !ok {
			return invalid()
		}
		p := storcliSlotID.FindStringSubmatch(v)
		if len(p) != 3 {
			return invalid()
		}
		enclosure := p[1]
		if enclosure != "-" {
			enclosure, ok = storcliNumericID(enclosure)
			if !ok {
				return invalid()
			}
		}
		slot, ok := storcliNumericID(p[2])
		if !ok || !accept(slotKey(ck, enclosure, slot), "physical_disk") {
			return invalid()
		}
	}
	for _, field := range []string{"VD", "VD ID"} {
		if raw, exists := m[field]; exists {
			id, ok := storcliNumericID(raw)
			if !ok {
				v, isString := raw.(string)
				if !isString {
					return invalid()
				}
				p := storcliProgressVD.FindStringSubmatch(v)
				if len(p) != 3 {
					return invalid()
				}
				c, valid := storcliNumericID(p[1])
				if !valid || c != controller {
					return invalid()
				}
				id, ok = storcliNumericID(p[2])
			}
			if !ok || !accept(ck+":v"+id, "virtual_disk") {
				return invalid()
			}
		}
	}
	if key == "" {
		return invalid()
	}
	return key, typ, nil
}

func applyStorcliProgress(b []byte, kind Kind, r *Result, operation int) (err error) {
	defer func() {
		if err != nil {
			r.Complete = false
		}
	}()
	controllers, e := decodeStorcliControllers(b)
	if e != nil {
		return e
	}
	issues := []error{}
	for _, raw := range controllers {
		id, data, e := decodeStorcliController(raw)
		if e != nil {
			issues = append(issues, e)
			continue
		}
		ck := controllerKey(kind, id)
		walkJSON(data, "", func(m jsonObject, path string) {
			raw, exists := m["Progress%"]
			if !exists {
				return
			}
			key, typ, e := storcliProgressKey(m, path, kind, id)
			if e != nil {
				issues = append(issues, e)
				return
			}
			value, e := strconv.ParseFloat(strings.TrimSuffix(textValue(raw), "%"), 64)
			if e != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > 100 {
				issues = append(issues, fmt.Errorf("%s: invalid progress", key))
				return
			}
			for j := range r.Components {
				c := &r.Components[j]
				if c.ComponentKey != key {
					continue
				}
				if c.Source != kind || c.ComponentType != typ || c.ParentKey == nil || *c.ParentKey != ck {
					issues = append(issues, fmt.Errorf("%s: progress target identity mismatch", key))
					return
				}
				c.ProgressPercent = ptr(int(value))
				if typ == "virtual_disk" && c.State == "optimal" {
					if operation == 1 {
						c.State = "initializing"
					}
					if operation == 2 {
						c.State = "checking"
					}
				}
				return
			}
			issues = append(issues, fmt.Errorf("%s: progress target not observed", key))
		})
	}
	return errors.Join(issues...)
}
