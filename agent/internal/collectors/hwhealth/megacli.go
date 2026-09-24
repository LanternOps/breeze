package hwhealth

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

func newMegaCLI(dirs []string) *cliSource {
	return &cliSource{kind: "megacli", names: []string{"MegaCli64", "MegaCli", "megacli"}, dirs: dirs, timeout: 30 * time.Second,
		commands: [][]string{{"-AdpAllInfo", "-aALL"}, {"-LDInfo", "-Lall", "-aALL"}, {"-PDList", "-aALL"}, {"-AdpBbuCmd", "-GetBbuStatus", "-aALL"}, {"-LDPDInfo", "-aALL"}}, parse: parseMegaCLI}
}

var megaAdapter = regexp.MustCompile(`(?im)^(?:BBU status for )?Adapter\s*[:#]?\s*(\d+)[^\n]*`)
var megaVD = regexp.MustCompile(`(?im)^Virtual Drive:\s*(\d+)[^\n]*`)
var megaPD = regexp.MustCompile(`(?im)^Enclosure Device ID:\s*([^\r\n]+)`)

func sortedComponents(m map[string]Component) []Component {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]Component, 0, len(keys))
	for _, k := range keys {
		out = append(out, m[k])
	}
	return out
}

// textBlocks returns [matched header, body] without dropping the header's identifier.
func textBlocks(re *regexp.Regexp, s string) [][2]string {
	hits := re.FindAllStringIndex(s, -1)
	out := make([][2]string, 0, len(hits))
	for i, h := range hits {
		end := len(s)
		if i+1 < len(hits) {
			end = hits[i+1][0]
		}
		out = append(out, [2]string{s[h[0]:h[1]], s[h[1]:end]})
	}
	return out
}
func parseMegaCLI(outputs []commandOutput) Result {
	rows := map[string]Component{}
	memberships := map[string][]string{}
	recognized := 0
	for _, out := range outputs {
		valid := false
		invalid := false
		for _, adapter := range textBlocks(megaAdapter, out.text) {
			id := megaAdapter.FindStringSubmatch(adapter[0])[1]
			ck := controllerKey("megacli", id)
			f := textFields(adapter[1])
			switch out.args[0] {
			case "-AdpAllInfo":
				if f["product name"] == "" {
					invalid = true
					continue
				}
				valid = true
				c := textComponent("megacli", "controller", ck, "", f["product name"], f["controller status"])
				c.Model = textPtr(f["product name"])
				c.Serial = textPtr(f["serial no"])
				c.Firmware = textPtr(f["fw package build"])
				rows[ck] = c
			case "-LDInfo":
				for _, block := range textBlocks(megaVD, adapter[1]) {
					v := textFields(block[1])
					raw := v["state"]
					if raw == "" {
						invalid = true
						continue
					}
					valid = true
					key := ck + ":v" + megaVD.FindStringSubmatch(block[0])[1]
					name := v["name"]
					if name == "" {
						name = "Virtual Drive " + megaVD.FindStringSubmatch(block[0])[1]
					}
					c := textComponent("megacli", "virtual_disk", key, ck, name, raw)
					c.SizeBytes = textSize(v["size"])
					c.Attributes["raidLevel"] = v["raid level"]
					// MegaCli spells ongoing operations several ways across releases; each
					// alias maps onto one of the three §5.2 operation states.
					for _, op := range [][2]string{{"rebuild", "Rebuild"}, {"consistency check", "Consistency Check"}, {"check consistency", "Consistency Check"}, {"initialization", "Initialization"}, {"background initialization", "Initialization"}} {
						if progress := textProgress(v[op[0]]); progress != nil && c.State != "offline" && c.State != "failed" {
							c.State = remainingVendorState("megacli", "virtual_disk", op[1])
							c.ProgressPercent = progress
						}
					}
					rows[key] = c
				}
				valid = valid || strings.Contains(out.text, "No Virtual Drive")
			case "-PDList":
				for _, block := range textBlocks(megaPD, adapter[1]) {
					p := textFields(block[0] + "\n" + block[1])
					if p["slot number"] == "" || p["firmware state"] == "" {
						invalid = true
						continue
					}
					valid = true
					e := p["enclosure device id"]
					if e == "N/A" {
						e = "-"
					}
					key := slotKey(ck, e, p["slot number"])
					c := textComponent("megacli", "physical_disk", key, ck, "Slot "+p["slot number"], p["firmware state"])
					if c.State == "unknown" {
						// "Online, Spun down" / "Unconfigured(good), Spun Up": the spin suffix is not health.
						if base, _, ok := strings.Cut(p["firmware state"], ","); ok {
							c.State = remainingVendorState("megacli", "physical_disk", base)
						}
					}
					c.Serial = textPtr(p["serial number"])
					c.Model = textPtr(p["inquiry data"])
					c.SizeBytes = textSize(p["raw size"])
					c.PredictiveFailure = textInt(p["predictive failure count"]) > 0 || strings.EqualFold(p["drive has flagged a s.m.a.r.t alert"], "yes")
					c.Attributes["enclosure"] = e
					c.Attributes["slot"] = p["slot number"]
					if n, err := strconv.Atoi(strings.TrimSpace(p["media error count"])); err == nil {
						c.Attributes["mediaErrors"] = n
					}
					c.TemperatureC = textTemperature(p["drive temperature"])
					rows[key] = c
				}
				valid = valid || strings.Contains(out.text, "No Physical Drive")
			case "-AdpBbuCmd":
				raw := f["battery state"]
				if strings.EqualFold(f["learn cycle active"], "yes") {
					raw = "Learn Cycle Active"
				}
				if strings.EqualFold(f["battery replacement required"], "yes") {
					raw = "Battery Replacement required"
				}
				for k, v := range f {
					// Real output: "Pack is about to fail & should be replaced : No".
					if strings.HasPrefix(k, "pack is about to fail") && strings.EqualFold(v, "yes") {
						raw = "Pack is about to fail"
					}
				}
				if strings.EqualFold(f["battery pack missing"], "yes") {
					raw = "Battery Pack Missing"
				}
				switch {
				case strings.Contains(adapter[1], "BBU is not present"):
					valid = true
					c := textComponent("megacli", "cache_battery", ck+":bbu", ck, "BBU", "BBU is not present")
					c.State = "missing"
					rows[c.ComponentKey] = c
				case raw != "":
					valid = true
					rows[ck+":bbu"] = textComponent("megacli", "cache_battery", ck+":bbu", ck, "BBU", raw)
				default:
					// Neither a state nor an explicit absence: this adapter's battery was not observed.
					invalid = true
				}
			case "-LDPDInfo":
				for _, vd := range textBlocks(megaVD, adapter[1]) {
					key := ck + ":v" + megaVD.FindStringSubmatch(vd[0])[1]
					valid = true
					for _, pd := range textBlocks(megaPD, vd[1]) {
						p := textFields(pd[0] + "\n" + pd[1])
						e := p["enclosure device id"]
						if e == "N/A" {
							e = "-"
						}
						if p["slot number"] != "" {
							memberships[key] = append(memberships[key], slotKey(ck, e, p["slot number"]))
						} else {
							invalid = true
						}
					}
				}
				valid = valid || strings.Contains(out.text, "No Virtual Drive")
			}
		}
		if valid && !invalid {
			recognized++
		}
	}
	for key, members := range memberships {
		if c, ok := rows[key]; ok {
			sort.Strings(members)
			c.Attributes["memberKeys"] = members
			rows[key] = c
		}
	}
	return cliResult(sortedComponents(rows), recognized, 5)
}
