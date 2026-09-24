package hwhealth

import (
	"regexp"
	"strings"
	"time"
)

var hpeController = regexp.MustCompile(`(?im)^([^\n]+?) in Slot\s+(\d+)[^\n]*`)

// hpeRecord accepts both `show config` ("array A", "logicaldrive 1 (...)") and
// `show config detail` ("Array: A", "Logical Drive: 1") spellings. Unassigned drives,
// expanders and SEPs are record boundaries too, so their fields never bleed into the
// preceding disk and unassigned drives never join the previous array's membership.
var hpeRecord = regexp.MustCompile(`(?im)^[ \t]*(?:array(?:[ \t]*:[ \t]*|[ \t]+)([A-Z]{1,3})[ \t]*$|logicaldrive[ \t]+(\d+)\b[^\n]*|logical drive[ \t]*:[ \t]*(\d+)[ \t]*$|physicaldrive[ \t]+(\S+)[^\n]*|(?:unassigned|hba drives|expander[ \t]+\d+|enclosure sep\b|sep[ \t]*\()[^\n]*)`)

func newSSACLI(dirs []string) *cliSource {
	return &cliSource{kind: "ssacli", names: []string{"ssacli", "hpssacli", "hpacucli"}, dirs: dirs, timeout: 60 * time.Second,
		commands: [][]string{{"ctrl", "all", "show", "status"}, {"ctrl", "all", "show", "config", "detail"}}, parse: parseSSACLI}
}
func parseSSACLI(outputs []commandOutput) Result {
	rows := map[string]Component{}
	recognized := 0
	for _, out := range outputs {
		valid := false
		invalid := false
		for _, block := range textBlocks(hpeController, out.text) {
			h := hpeController.FindStringSubmatch(block[0])
			ck := controllerKey("ssacli", h[2])
			head := block[1]
			if loc := hpeRecord.FindStringIndex(head); loc != nil {
				head = head[:loc[0]]
			}
			f := textFields(head)
			if f["controller status"] == "" {
				invalid = true
				continue
			}
			valid = true
			c := textComponent("ssacli", "controller", ck, "", h[1], f["controller status"])
			c.Model = textPtr(h[1])
			c.Serial = textPtr(f["serial number"])
			c.Firmware = textPtr(f["firmware version"])
			cache := f["cache status"]
			battery := f["battery/capacitor status"]
			if c.State != "failed" && (strings.Contains(strings.ToLower(cache), "disabled") || battery == "Failed" || battery == "Not Present") {
				c.State = "degraded"
				c.StateDetail = textPtr("Cache: " + cache + "; Battery/Capacitor: " + battery)
			}
			if old, ok := rows[ck]; ok {
				if c.Serial == nil {
					c.Serial = old.Serial
				}
				if c.Firmware == nil {
					c.Firmware = old.Firmware
				}
				if old.State == "failed" || old.State == "degraded" && c.State != "failed" {
					c.State = old.State
					c.StateDetail = old.StateDetail
				}
			}
			rows[ck] = c
			if battery != "" {
				rows[ck+":bbu"] = textComponent("ssacli", "cache_battery", ck+":bbu", ck, "Battery/Capacitor", battery)
			}
			array := ""
			members := map[string][]string{}
			volumes := map[string][]string{}
			for _, record := range textBlocks(hpeRecord, block[1]) {
				m := hpeRecord.FindStringSubmatch(record[0])
				f := textFields(record[1])
				kind, id := "other", ""
				switch {
				case m[1] != "":
					kind, id = "array", m[1]
				case m[2] != "" || m[3] != "":
					kind, id = "logicaldrive", m[2]+m[3]
				case m[4] != "":
					kind, id = "physicaldrive", m[4]
				}
				switch kind {
				case "other":
					if label := strings.ToLower(strings.TrimSpace(record[0])); label == "unassigned" || label == "hba drives" {
						array = ""
					}
				case "array":
					array = id
				case "logicaldrive":
					key := ck + ":v" + id
					raw := f["status"]
					if raw == "" {
						invalid = true
						continue
					}
					c := textComponent("ssacli", "virtual_disk", key, ck, "Logical Drive "+id, raw)
					if f["parity initialization status"] == "In Progress" && c.State != "failed" {
						c.State = "initializing"
					}
					c.ProgressPercent = textProgress(firstText(f, "rebuild status", "parity initialization status", "transformation status"))
					c.SizeBytes = textSize(f["size"])
					c.Attributes["raidLevel"] = f["fault tolerance"]
					rows[key] = c
					volumes[array] = append(volumes[array], key)
				case "physicaldrive":
					address := strings.Split(id, ":")
					// "physicaldrive 1I:1:1 (port 1I:box 1:bay 1, SAS HDD, 600 GB, OK)" inside a
					// logical drive's mirror/parity group is a reference; the full record with
					// its Status field follows under the array.
					if f["status"] == "" && strings.Contains(record[0], "(") {
						continue
					}
					if len(address) != 3 || f["status"] == "" {
						invalid = true
						continue
					}
					enclosure := address[0] + "-" + address[1]
					key := slotKey(ck, enclosure, address[2])
					c := textComponent("ssacli", "physical_disk", key, ck, "Physical Drive "+id, f["status"])
					if f["drive type"] == "Spare Drive" && c.State == "online" {
						c.State = "hotspare"
					}
					c.PredictiveFailure = c.State == "predictive_failure"
					c.Serial = textPtr(f["serial number"])
					c.Model = textPtr(f["model"])
					c.SizeBytes = textSize(f["size"])
					c.Attributes["enclosure"] = enclosure
					c.Attributes["slot"] = address[2]
					c.TemperatureC = textTemperature(f["current temperature (c)"])
					rows[key] = c
					members[array] = append(members[array], key)
				}
			}
			for a, keys := range volumes {
				for _, key := range keys {
					c := rows[key]
					c.Attributes["memberKeys"] = members[a]
					rows[key] = c
				}
			}
		}
		if valid && !invalid {
			recognized++
		}
	}
	return cliResult(sortedComponents(rows), recognized, 2)
}
