package hwhealth

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var mdProgress = regexp.MustCompile(`(recovery|resync|check|reshape)\s*=\s*([0-9.]+)%`)

func mdArrayState(raw string) string {
	for _, x := range []struct{ in, out string }{
		{"inactive", "failed"},
		{"recovering", "rebuilding"},
		{"resyncing", "rebuilding"},
		{"checking", "checking"},
		{"reshaping", "migrating"},
		{"degraded", "degraded"},
		{"clean", "optimal"},
		{"active", "optimal"},
	} {
		if strings.Contains(raw, x.in) {
			return x.out
		}
	}
	return "unknown"
}

func mdMemberState(raw string) string {
	for _, x := range []struct{ in, out string }{
		{"faulty", "failed"},
		{"removed", "missing"},
		{"spare rebuilding", "rebuilding"},
		{"spare", "hotspare"},
		{"active sync", "online"},
		{"writemostly", "online"},
	} {
		if strings.Contains(raw, x.in) {
			return x.out
		}
	}
	return "unknown"
}

func parseMD(name, mdstat, detail string, stable func(string) string, remembered map[string]string) (Result, error) {
	r := Result{Complete: true}
	raw := ""
	hasHeader := false
	for _, line := range strings.Split(detail, "\n") {
		p := strings.SplitN(line, ":", 2)
		if len(p) == 2 && strings.TrimSpace(p[0]) == "State" {
			raw = strings.TrimSpace(p[1])
		}
		if strings.Contains(line, "RaidDevice State") {
			hasHeader = true
		}
	}
	if raw == "" || !hasHeader {
		return Result{}, fmt.Errorf("incomplete mdadm detail")
	}
	vk := "mdadm:" + name
	ctrl := component("mdadm", "controller", "mdadm:ctrl", "", "Linux md", "active", "ok")
	vd := component("mdadm", "virtual_disk", vk, "mdadm:ctrl", name, raw, mdArrayState(raw))
	section := ""
	active := false
	for _, line := range strings.Split(mdstat, "\n") {
		if strings.Contains(line, " : ") {
			active = strings.HasPrefix(line, name+" : ")
		}
		if active {
			section += line + "\n"
		}
	}
	if p := mdProgress.FindStringSubmatch(section); len(p) == 3 {
		n, _ := strconv.ParseFloat(p[2], 64)
		if n >= 0 && n <= 100 {
			vd.ProgressPercent = ptr(int(n))
			vd.State = map[string]string{"recovery": "rebuilding", "resync": "rebuilding", "check": "checking", "reshape": "migrating"}[p[1]]
		}
	}
	rows := []Component{}
	keys := []string{}
	for _, line := range strings.Split(detail, "\n") {
		f := strings.Fields(line)
		if len(f) < 5 {
			continue
		}
		if _, e := strconv.Atoi(f[0]); e != nil && f[0] != "-" {
			continue
		}
		_, roleErr := strconv.Atoi(f[3])
		if roleErr != nil && f[3] != "-" {
			continue
		}
		role := name + "/" + f[3]
		last := f[len(f)-1]
		dev := ""
		if strings.HasPrefix(last, "/dev/") {
			dev = last
			f = f[:len(f)-1]
		}
		stateRaw := strings.Join(f[4:], " ")
		id := ""
		if dev != "" {
			id = stable(dev)
			if id != "" && roleErr == nil {
				remembered[role] = id
			}
		} else if roleErr == nil {
			id = remembered[role]
		}
		if id == "" {
			r.Complete = false
			r.Warnings = append(r.Warnings, "no stable identity for "+role)
			continue
		}
		key := memberKey(vk, id)
		c := component("mdadm", "physical_disk", key, "mdadm:ctrl", id, stateRaw, mdMemberState(stateRaw))
		c.Attributes["osDevice"] = dev
		rows = append(rows, c)
		keys = append(keys, key)
	}
	vd.Attributes["memberKeys"] = keys
	r.Components = append([]Component{ctrl, vd}, rows...)
	return r, nil
}
