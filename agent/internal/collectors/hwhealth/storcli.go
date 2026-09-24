package hwhealth

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

type jsonObject = map[string]any

func textValue(v any) string {
	if v == nil {
		return ""
	}
	return fmt.Sprint(v)
}

func number(v any) int {
	n, _ := strconv.ParseFloat(strings.TrimSuffix(textValue(v), "%"), 64)
	return int(n)
}

func walkJSON(v any, path string, fn func(jsonObject, string)) {
	switch x := v.(type) {
	case map[string]any:
		fn(x, path)
		keys := []string{}
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			walkJSON(x[k], path+"/"+k, fn)
		}
	case []any:
		for _, y := range x {
			walkJSON(y, path, fn)
		}
	}
}

var vendorStates = map[ComponentType]map[string]string{
	"controller":    {"Optimal": "ok", "Needs Attention": "degraded", "Failed": "failed"},
	"virtual_disk":  {"Optl": "optimal", "Dgrd": "degraded", "Pdgd": "partially_degraded", "OfLn": "offline", "Rec": "rebuilding"},
	"physical_disk": {"Onln": "online", "GHS": "hotspare", "DHS": "hotspare", "UGood": "ready", "UBad": "failed", "Rbld": "rebuilding", "CpyBck": "copyback", "JBOD": "jbod", "Offln": "offline", "Msng": "missing", "UGShld": "shielded", "UGUnsp": "unknown"},
	"cache_battery": {"Optimal": "ok", "Learning": "learning", "Learn cycle active": "learning", "Charging": "charging", "Degraded": "degraded", "Needs Attention": "degraded", "Failed": "failed", "": "missing"},
	"enclosure":     {"OK": "ok", "Optimal": "ok", "Degraded": "degraded", "Failed": "failed"},
}

func vendorState(typ ComponentType, raw string) string {
	if s, ok := vendorStates[typ][raw]; ok {
		return s
	}
	return "unknown"
}

func sizeBytes(raw any) *int64 {
	fields := strings.Fields(textValue(raw))
	if len(fields) != 2 {
		return nil
	}
	n, e := strconv.ParseFloat(fields[0], 64)
	if e != nil || n < 0 {
		return nil
	}
	scale := map[string]float64{"B": 1, "KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12, "KiB": 1024, "MiB": 1048576, "GiB": 1073741824, "TiB": 1099511627776}[fields[1]]
	if scale == 0 {
		return nil
	}
	return ptr(int64(n * scale))
}

var drivePath = regexp.MustCompile(`/c[0-9]+/e([0-9]+)/s([0-9]+)`)
var storcliSlotID = regexp.MustCompile(`^([0-9]+|-):([0-9]+)$`)
var storcliVDID = regexp.MustCompile(`^[0-9]+/[0-9]+$`)

// Keep each controller opaque until its own decode; one bad envelope cannot discard siblings.
func decodeStorcliControllers(data []byte) ([]json.RawMessage, error) {
	if len(data) > 4*1024*1024 {
		return nil, fmt.Errorf("storcli output exceeds 4 MiB")
	}
	var doc struct {
		Controllers []json.RawMessage
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	if e := dec.Decode(&doc); e != nil {
		return nil, e
	}
	var extra any
	if e := dec.Decode(&extra); e != io.EOF {
		return nil, fmt.Errorf("trailing storcli JSON")
	}
	if doc.Controllers == nil {
		return nil, fmt.Errorf("missing Controllers")
	}
	return doc.Controllers, nil
}

func storcliNumericID(v any) (string, bool) {
	var raw string
	switch n := v.(type) {
	case json.Number:
		raw = string(n)
	case string:
		raw = n
	default:
		return "", false
	}
	if raw == "" {
		return "", false
	}
	for _, c := range raw {
		if c < '0' || c > '9' {
			return "", false
		}
	}
	n, e := strconv.Atoi(raw)
	if e != nil || n < 0 {
		return "", false
	}
	return strconv.Itoa(n), true
}

func decodeStorcliController(raw json.RawMessage) (string, jsonObject, error) {
	var ctl jsonObject
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if e := dec.Decode(&ctl); e != nil {
		return "", nil, e
	}
	status, ok := ctl["Command Status"].(map[string]any)
	if !ok {
		return "", nil, fmt.Errorf("invalid Command Status")
	}
	if status["Status"] != "Success" {
		return "", nil, fmt.Errorf("storcli command failed: %s", textValue(status["Description"]))
	}
	// A controller index is a required JSON integer; a string or omitted value is invalid.
	n, ok := status["Controller"].(json.Number)
	if !ok {
		return "", nil, fmt.Errorf("missing or invalid controller identity")
	}
	id, ok := storcliNumericID(n)
	if !ok {
		return "", nil, fmt.Errorf("invalid controller identity")
	}
	data, ok := ctl["Response Data"].(map[string]any)
	if !ok || data == nil {
		return "", nil, fmt.Errorf("controller %s: invalid Response Data", id)
	}
	return id, data, nil
}

// A present section must be a list of records. Only explicit evidence yields a battery.
func storcliBatteryState(m jsonObject) (string, bool) {
	present, hasPresent := m["Present"]
	if hasPresent {
		if _, ok := present.(bool); !ok {
			return "", false
		}
	}
	value, hasState := m["State"]
	raw, ok := value.(string)
	if hasState && !ok {
		return "", false
	}
	if hasPresent && present == false {
		return "", true
	}
	if !hasState {
		return "", false
	}
	return raw, true
}

func parseStorcli(data []byte, kind Kind) (Result, error) {
	return parseStorcliSections(data, kind, "PD LIST", "VD LIST")
}

// The overview requires both lists; individual commands require only their own section.
func parseStorcliSections(data []byte, kind Kind, required ...string) (Result, error) {
	r := Result{Complete: true}
	controllers, e := decodeStorcliControllers(data)
	if e != nil {
		return Result{}, e
	}
	malformed := func(message string) {
		r.Complete = false
		r.Warnings = append(r.Warnings, message)
	}
	for _, raw := range controllers {
		id, data, e := decodeStorcliController(raw)
		if e != nil {
			malformed(e.Error())
			continue
		}
		ck := controllerKey(kind, id)
		byKey := map[string]Component{}
		members := map[string][]string{}
		for _, section := range required {
			v, ok := data[section]
			if !ok || v == nil {
				malformed(ck + ": missing " + section)
				continue
			}
			if section == "PD LIST" || section == "VD LIST" {
				if _, ok := v.([]any); !ok {
					malformed(ck + ": invalid " + section)
				}
			}
		}
		for _, section := range []string{"PD LIST", "VD LIST"} {
			raw, exists := data[section]
			if !exists {
				continue
			}
			list, ok := raw.([]any)
			if !ok {
				malformed(ck + ": invalid " + section)
				continue
			}
			for _, row := range list {
				m, ok := row.(map[string]any)
				if !ok {
					malformed(ck + ": invalid " + section + " row")
					continue
				}
				if section == "PD LIST" && !storcliSlotID.MatchString(textValue(m["EID:Slt"])) {
					malformed(ck + ": invalid PD identity")
				}
				if section == "VD LIST" && !storcliVDID.MatchString(textValue(m["DG/VD"])) {
					malformed(ck + ": invalid VD identity")
				}
			}
		}
		for section, suffix := range map[string]string{"Cachevault_Info": "cv", "BBU_Info": "bbu"} {
			raw, exists := data[section]
			if !exists {
				continue
			}
			list, ok := raw.([]any)
			if !ok {
				malformed(ck + ": invalid " + section)
				continue
			}
			for _, row := range list {
				m, ok := row.(map[string]any)
				if !ok {
					malformed(ck + ": invalid " + section + " row")
					continue
				}
				state, ok := storcliBatteryState(m)
				if !ok {
					malformed(ck + ": invalid " + section + " record")
					continue
				}
				key := ck + ":" + suffix
				byKey[key] = component(kind, "cache_battery", key, ck, strings.ToUpper(suffix), state, vendorState("cache_battery", state))
			}
		}
		walkJSON(data, "", func(m jsonObject, path string) {
			if raw, ok := m["Controller Status"]; ok {
				c := component(kind, "controller", ck, "", ck, textValue(raw), vendorState("controller", textValue(raw)))
				if basics, ok := data["Basics"].(map[string]any); ok {
					c.Name = textValue(basics["Model"])
					c.Model = ptr(c.Name)
					c.Serial = ptr(textValue(basics["Serial Number"]))
					c.Firmware = ptr(textValue(basics["FW Package Build"]))
				}
				byKey[ck] = c
			}
			if id, ok := m["DG/VD"]; ok {
				parts := strings.Split(textValue(id), "/")
				if !storcliVDID.MatchString(textValue(id)) {
					malformed(ck + ": invalid VD identity")
					return
				}
				key := ck + ":v" + parts[1]
				raw := textValue(m["State"])
				c := component(kind, "virtual_disk", key, ck, "VD "+parts[1], raw, vendorState("virtual_disk", raw))
				c.SizeBytes = sizeBytes(m["Size"])
				c.Attributes["raidLevel"] = m["TYPE"]
				c.Attributes["diskGroup"] = parts[0]
				byKey[key] = c
			}
			eid, sl := "", ""
			if id, ok := m["EID:Slt"]; ok {
				p := storcliSlotID.FindStringSubmatch(textValue(id))
				if len(p) != 3 {
					malformed(ck + ": invalid EID:Slt")
					return
				}
				eid, sl = p[1], p[2]
			}
			if sl == "" {
				if p := drivePath.FindStringSubmatch(path); len(p) == 3 {
					eid, sl = p[1], p[2]
				}
			}
			if sl != "" {
				key := slotKey(ck, eid, sl)
				c, exists := byKey[key]
				if !exists {
					c = component(kind, "physical_disk", key, ck, "Slot "+sl, "", "unknown")
				}
				if raw, ok := m["State"]; ok {
					c.StateDetail = ptr(textValue(raw))
					c.State = vendorState("physical_disk", textValue(raw))
				}
				if sn, ok := m["SN"]; ok {
					c.Serial = ptr(strings.TrimSpace(textValue(sn)))
				}
				if model, ok := m["Model"]; ok {
					c.Model = ptr(strings.TrimSpace(textValue(model)))
				}
				if fw, ok := m["Firmware Revision"]; ok {
					c.Firmware = ptr(textValue(fw))
				}
				if size := sizeBytes(m["Size"]); size != nil {
					c.SizeBytes = size
				}
				c.Attributes["enclosure"] = eid
				c.Attributes["slot"] = sl
				if dg, ok := m["DG"]; ok {
					c.Attributes["diskGroup"] = textValue(dg)
				}
				for src, dst := range map[string]string{"Media Error Count": "mediaErrors", "Other Error Count": "otherErrors", "Intf": "interface", "Med": "mediaType"} {
					if v, ok := m[src]; ok {
						c.Attributes[dst] = v
					}
				}
				c.PredictiveFailure = c.PredictiveFailure || number(m["Predictive Failure Count"]) > 0 || strings.EqualFold(textValue(m["S.M.A.R.T alert flagged by drive"]), "Yes")
				if v, ok := m["Drive Temperature"]; ok {
					fields := strings.Fields(textValue(v))
					if len(fields) > 0 {
						c.TemperatureC = ptr(number(strings.Split(fields[0], "C")[0]))
					}
				}
				if v, ok := m["Progress%"]; ok {
					n := number(v)
					if n >= 0 && n <= 100 {
						c.ProgressPercent = ptr(n)
					}
				}
				byKey[key] = c
				if dg, ok := m["DG"]; ok {
					members[textValue(dg)] = append(members[textValue(dg)], key)
				}
			}
			if id, ok := m["EID"]; ok && strings.Contains(path, "Enclosure") {
				raw := textValue(m["State"])
				key := ck + ":enc" + textValue(id)
				byKey[key] = component(kind, "enclosure", key, ck, "Enclosure "+textValue(id), raw, vendorState("enclosure", raw))
			}
		})
		for key, c := range byKey {
			if c.ComponentType == "virtual_disk" {
				ids := members[textValue(c.Attributes["diskGroup"])]
				sort.Strings(ids)
				c.Attributes["memberKeys"] = ids
				byKey[key] = c
			}
		}
		keys := []string{}
		for k := range byKey {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			r.Components = append(r.Components, byKey[k])
		}
	}
	if len(r.Components) == 0 && !r.Complete {
		return r, fmt.Errorf("storcli commands failed: %v", r.Warnings)
	}
	return r, nil
}

func mergeComponents(dst, src []Component) []Component {
	index := map[string]int{}
	for i, c := range dst {
		index[c.ComponentKey] = i
	}
	for _, c := range src {
		if i, ok := index[c.ComponentKey]; ok {
			old := dst[i]
			if c.State == "unknown" && c.StateDetail != nil && *c.StateDetail == "" && old.State != "unknown" {
				c.State = old.State
				c.StateDetail = old.StateDetail
			}
			if c.Serial == nil {
				c.Serial = old.Serial
			}
			if c.Model == nil {
				c.Model = old.Model
			}
			if c.Firmware == nil {
				c.Firmware = old.Firmware
			}
			if c.SizeBytes == nil {
				c.SizeBytes = old.SizeBytes
			}
			if c.TemperatureC == nil {
				c.TemperatureC = old.TemperatureC
			}
			if c.ProgressPercent == nil {
				c.ProgressPercent = old.ProgressPercent
			}
			c.PredictiveFailure = c.PredictiveFailure || old.PredictiveFailure
			for k, v := range old.Attributes {
				if _, ok := c.Attributes[k]; !ok {
					c.Attributes[k] = v
				}
			}
			dst[i] = c
		} else {
			index[c.ComponentKey] = len(dst)
			dst = append(dst, c)
		}
	}
	return dst
}
