package hwhealth

import (
	"regexp"
	"strings"
	"time"
)

var arcID = regexp.MustCompile(`(?im)^\s*Controller\s+#(\d+)`)
var arcRecord = regexp.MustCompile(`(?im)^\s*(Logical device number\s+(\d+)|Device\s+#(\d+)|(?:Controller )?Battery Information|(?:Controller )?ZMM Information)[^\n]*`)
var arcAddress = regexp.MustCompile(`(\d+)\s*,\s*(\d+)`)

// Newer arcconf prints "Group 0, Segment 0 : Present (953869MB, SATA, HDD, Connector:0, Device:1) SERIAL";
// the channel/device pair is not the drive's reported address, so membership falls back to the serial.
var arcSegmentSerial = regexp.MustCompile(`(?im)Segment\s+\d+\s*:\s*Present\s*\([^)\n]*\)[ \t]*(\S+)`)
var arcSegment = regexp.MustCompile(`(?i)Channel:\s*(\d+)\s*,\s*Device:\s*(\d+)`)

func arcControllers(s string) []string {
	ids := []string{}
	seen := map[string]bool{}
	for _, m := range arcID.FindAllStringSubmatch(s, -1) {
		if !seen[m[1]] {
			ids = append(ids, m[1])
			seen[m[1]] = true
		}
	}
	return ids
}
func newARCCONF(dirs []string) *cliSource {
	return &cliSource{kind: "arcconf", names: []string{"arcconf"}, dirs: dirs, timeout: 30 * time.Second, commands: [][]string{{"GETVERSION"}},
		expand: func(outputs []commandOutput) [][]string {
			commands := [][]string{}
			for _, out := range outputs {
				if out.args[0] == "GETVERSION" {
					for _, id := range arcControllers(out.text) {
						commands = append(commands, []string{"GETCONFIG", id, "AL"})
					}
				}
			}
			return commands
		}, parse: parseARCCONF}
}
func parseARCCONF(outputs []commandOutput) Result {
	rows := map[string]Component{}
	expected := 1
	recognized := 0
	for _, out := range outputs {
		if out.args[0] == "GETVERSION" {
			ids := arcControllers(out.text)
			expected += len(ids)
			if len(ids) > 0 || strings.Contains(out.text, "Controllers found: 0") {
				recognized++
			}
			continue
		}
		if len(out.args) != 3 || !strings.Contains(out.text, "Command completed successfully.") {
			continue
		}
		head := out.text
		if loc := arcRecord.FindStringIndex(head); loc != nil {
			head = head[:loc[0]]
		}
		f := textFields(head)
		if f["controller model"] == "" {
			continue
		}
		recognized++
		ck := controllerKey("arcconf", out.args[1])
		c := textComponent("arcconf", "controller", ck, "", f["controller model"], f["controller status"])
		c.Model = textPtr(f["controller model"])
		c.Serial = textPtr(f["controller serial number"])
		c.Firmware = textPtr(f["firmware"])
		rows[ck] = c
		segmentSerials := map[string][]string{}
		for _, block := range textBlocks(arcRecord, out.text) {
			h := arcRecord.FindStringSubmatch(block[0])
			f := textFields(block[1])
			var c Component
			switch {
			case h[2] != "":
				if f["status of logical device"] == "" {
					recognized--
					continue
				}
				name := f["logical device name"]
				if name == "" {
					name = "Logical Device " + h[2]
				}
				c = textComponent("arcconf", "virtual_disk", ck+":v"+h[2], ck, name, f["status of logical device"])
				c.Attributes["raidLevel"] = f["raid level"]
				c.SizeBytes = textSize(f["size"])
				members := []string{}
				for _, m := range arcSegment.FindAllStringSubmatch(block[1], -1) {
					members = append(members, slotKey(ck, "-", m[1]+"-"+m[2]))
				}
				if len(members) == 0 {
					for _, m := range arcSegmentSerial.FindAllStringSubmatch(block[1], -1) {
						segmentSerials[c.ComponentKey] = append(segmentSerials[c.ComponentKey], m[1])
					}
				}
				c.Attributes["memberKeys"] = members
				c.ProgressPercent = textProgress(firstText(f, "rebuild progress", "progress"))
			case h[3] != "":
				if !strings.Contains(strings.ToLower(block[1]), "hard drive") {
					continue
				}
				if f["state"] == "" {
					recognized--
					continue
				}
				a := arcAddress.FindStringSubmatch(f["reported channel,device(t:l)"])
				if a == nil {
					recognized--
					continue
				}
				c = textComponent("arcconf", "physical_disk", slotKey(ck, "-", a[1]+"-"+a[2]), ck, "Device "+a[1]+":"+a[2], f["state"])
				c.Serial = textPtr(f["serial number"])
				c.Model = textPtr(f["model"])
				c.SizeBytes = textSize(f["total size"])
				c.PredictiveFailure = textInt(f["s.m.a.r.t. warnings"]) > 0
				c.Attributes["enclosure"] = "-"
				c.Attributes["slot"] = a[1] + "-" + a[2]
			default:
				if firstText(f, "status", "state") == "" {
					recognized--
					continue
				}
				suffix := ":bbu"
				if strings.Contains(strings.ToUpper(block[0]), "ZMM") {
					suffix = ":cv"
				}
				c = textComponent("arcconf", "cache_battery", ck+suffix, ck, strings.TrimSpace(block[0]), firstText(f, "status", "state"))
			}
			rows[c.ComponentKey] = c
		}
		for vdKey, serials := range segmentSerials {
			members := []string{}
			for _, sn := range serials {
				for _, pd := range rows {
					if pd.ComponentType == "physical_disk" && pd.ParentKey != nil && *pd.ParentKey == ck && pd.Serial != nil && *pd.Serial == sn {
						members = append(members, pd.ComponentKey)
					}
				}
			}
			vd := rows[vdKey]
			vd.Attributes["memberKeys"] = members
			rows[vdKey] = vd
		}
	}
	return cliResult(sortedComponents(rows), recognized, expected)
}
