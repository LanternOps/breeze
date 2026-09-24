package hwhealth

import (
	"encoding/csv"
	"regexp"
	"strings"
	"time"
)

// omsaController matches a section header such as "Controller PERC H730P Mini (Embedded)"
// or "Controller PERC H740P Adapter (Slot 4)". The parenthesised text is the slot, not the
// controller ID, so sections are resolved against the controller table (omsaResolve).
var omsaController = regexp.MustCompile(`(?im)^Controller[ \t]+([^\n]+?)[ \t]*\(([^()\n]*)\)[ \t]*$`)
var omsaEmpty = regexp.MustCompile(`(?i)\bno\b[^\n]*\bfound\b`)
var omsaDigits = regexp.MustCompile(`\d+`)

// omsaResolve maps a section header to the controller-table ID by name, narrowing by
// slot when several controllers share a name. Ambiguity returns "" (never controller 0).
func omsaResolve(name, slot string, controllers []map[string]string) string {
	match := func(r map[string]string) bool {
		return strings.EqualFold(strings.TrimSpace(r["name"]), strings.TrimSpace(name))
	}
	var named []map[string]string
	for _, r := range controllers {
		if match(r) {
			named = append(named, r)
		}
	}
	if len(named) == 1 {
		return named[0]["id"]
	}
	found := ""
	for _, r := range named {
		rs := r["slot id"]
		same := strings.EqualFold(strings.TrimSpace(rs), strings.TrimSpace(slot))
		if d1, d2 := omsaDigits.FindString(rs), omsaDigits.FindString(slot); d1 != "" && d1 == d2 {
			same = true
		}
		if same {
			if found != "" {
				return ""
			}
			found = r["id"]
		}
	}
	return found
}

func ssvRows(text string) ([]map[string]string, bool) {
	var header []string
	rows := []map[string]string{}
	valid := true
	for _, line := range strings.Split(text, "\n") {
		if !strings.Contains(line, ";") {
			continue
		}
		r := csv.NewReader(strings.NewReader(line))
		r.Comma = ';'
		r.FieldsPerRecord = -1
		values, err := r.Read()
		if err != nil {
			valid = false
			continue
		}
		if len(values) > 0 && strings.EqualFold(strings.TrimSpace(values[0]), "ID") {
			header = values
			continue
		}
		if header == nil {
			continue
		}
		if len(values) != len(header) {
			valid = false
			continue
		}
		row := map[string]string{}
		for i, k := range header {
			row[strings.ToLower(strings.TrimSpace(k))] = strings.TrimSpace(values[i])
		}
		rows = append(rows, row)
	}
	return rows, valid && header != nil
}
func newOMReport(dirs []string) *cliSource {
	return &cliSource{kind: "omreport", names: []string{"omreport"}, dirs: dirs, timeout: 60 * time.Second,
		commands: [][]string{{"storage", "controller", "-fmt", "ssv"}, {"storage", "vdisk", "-fmt", "ssv"}, {"storage", "battery", "-fmt", "ssv"}},
		expand: func(outputs []commandOutput) [][]string {
			commands := [][]string{}
			for _, o := range outputs {
				if o.args[1] == "controller" {
					rows, _ := ssvRows(o.text)
					for _, r := range rows {
						if r["id"] != "" {
							commands = append(commands, []string{"storage", "pdisk", "controller=" + r["id"], "-fmt", "ssv"})
						}
					}
				}
			}
			return commands
		}, parse: parseOMReport}
}
func parseOMReport(outputs []commandOutput) Result {
	rows := map[string]Component{}
	ids := []string{}
	controllers := []map[string]string{}
	recognized := 0
	expected := 3
	for _, o := range outputs {
		if o.args[1] == "controller" {
			table, _ := ssvRows(o.text)
			for _, r := range table {
				ids = append(ids, r["id"])
			}
			controllers = append(controllers, table...)
		}
	}
	expected += len(ids)
	for _, o := range outputs {
		typ := ComponentType("controller")
		switch o.args[1] {
		case "vdisk":
			typ = "virtual_disk"
		case "pdisk":
			typ = "physical_disk"
		case "battery":
			typ = "cache_battery"
		}
		groups := [][2]string{{"", o.text}}
		if typ != "controller" && typ != "physical_disk" {
			if b := textBlocks(omsaController, o.text); len(b) > 0 {
				groups = b
			}
		}
		valid := true
		for _, group := range groups {
			table, ok := ssvRows(group[1])
			// "No virtual disks found" / "No batteries found" is a complete, empty answer.
			if !ok && !strings.Contains(group[1], ";") && omsaEmpty.MatchString(group[1]) {
				ok = true
			}
			if !ok {
				valid = false
			}
			controller := ""
			if h := omsaController.FindStringSubmatch(group[0]); h != nil {
				if controller = omsaResolve(h[1], h[2], controllers); controller == "" {
					valid = false
					continue
				}
			}
			for _, arg := range o.args {
				if strings.HasPrefix(arg, "controller=") {
					controller = strings.TrimPrefix(arg, "controller=")
				}
			}
			for _, r := range table {
				id := r["id"]
				cid := controller
				if typ == "controller" {
					cid = id
				} else if r["controller id"] != "" {
					cid = r["controller id"]
				}
				if cid == "" && len(ids) == 1 {
					cid = ids[0]
				}
				if cid == "" || id == "" {
					valid = false
					continue
				}
				ck := controllerKey("omreport", cid)
				key := ck
				parent := ck
				raw := r["state"]
				switch typ {
				case "controller":
					parent = ""
					raw = r["status"]
				case "virtual_disk":
					key += ":v" + id
				case "cache_battery":
					key += ":bbu"
				case "physical_disk":
					address := strings.Split(id, ":")
					if len(address) < 2 {
						valid = false
						continue
					}
					key = slotKey(ck, strings.Join(address[:len(address)-1], "-"), address[len(address)-1])
				}
				if raw == "" {
					valid = false
					continue
				}
				c := textComponent("omreport", typ, key, parent, firstText(r, "name", "id"), raw)
				c.Serial = textPtr(firstText(r, "serial no.", "serial number"))
				c.Model = textPtr(firstText(r, "product id", "name"))
				c.Firmware = textPtr(r["firmware version"])
				c.SizeBytes = textSize(firstText(r, "capacity", "size"))
				c.ProgressPercent = textProgress(r["progress"])
				c.PredictiveFailure = strings.EqualFold(r["failure predicted"], "yes")
				if typ == "virtual_disk" {
					c.Attributes["raidLevel"] = r["layout"]
				}
				rows[key] = c
			}
		}
		if valid {
			recognized++
		}
	}
	return cliResult(sortedComponents(rows), recognized, expected)
}
