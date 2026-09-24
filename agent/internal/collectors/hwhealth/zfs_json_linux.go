//go:build linux

package hwhealth

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var zfsVersion = regexp.MustCompile(`(?m)^zfs-(\d+)\.(\d+)\.`)

func zfsJSONCapable(raw string) bool {
	m := zfsVersion.FindStringSubmatch(raw)
	if m == nil {
		return false
	}
	major, _ := strconv.Atoi(m[1])
	minor, _ := strconv.Atoi(m[2])
	return major > 2 || major == 2 && minor >= 3
}

type zfsNumber string

func (n *zfsNumber) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if _, err := strconv.ParseUint(s, 10, 64); err != nil {
		return err
	}
	*n = zfsNumber(s)
	return nil
}
func (n zfsNumber) value() uint64 { v, _ := strconv.ParseUint(string(n), 10, 64); return v }

type zfsVdev struct {
	Type     string             `json:"vdev_type"`
	GUID     zfsNumber          `json:"guid"`
	Path     string             `json:"path"`
	State    string             `json:"state"`
	Read     zfsNumber          `json:"read_errors"`
	Write    zfsNumber          `json:"write_errors"`
	Checksum zfsNumber          `json:"checksum_errors"`
	Children map[string]zfsVdev `json:"vdevs"`
}
type zfsPoolJSON struct {
	Name    string             `json:"name"`
	State   string             `json:"state"`
	Vdevs   map[string]zfsVdev `json:"vdevs"`
	Special map[string]zfsVdev `json:"special"`
	Dedup   map[string]zfsVdev `json:"dedup"`
	Logs    map[string]zfsVdev `json:"logs"`
	Cache   map[string]zfsVdev `json:"l2cache"`
	Spares  map[string]zfsVdev `json:"spares"`
	Scan    struct {
		Function string    `json:"function"`
		State    string    `json:"state"`
		Examined zfsNumber `json:"examined"`
		Total    zfsNumber `json:"to_examine"`
	} `json:"scan_stats"`
}

func parseZFSJSON(list string, data []byte, stable func(string) string) (Result, error) {
	var doc struct {
		Pools map[string]zfsPoolJSON `json:"pools"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return Result{}, err
	}
	if doc.Pools == nil {
		return Result{}, fmt.Errorf("ZFS JSON has no pools")
	}
	rows, complete := zfsBase(list)
	observed := map[string]bool{}
	for name, p := range doc.Pools {
		if p.Name != "" {
			name = p.Name
		}
		key := "zfs:pool:" + name
		vd, ok := rows[key]
		if !ok || p.State == "" {
			complete = false
			continue
		}
		observed[key] = true
		vd.State = remainingVendorState("zfs", "virtual_disk", p.State)
		vd.StateDetail = textPtr(p.State)
		if p.Scan.State == "SCANNING" && (p.Scan.Function == "SCRUB" || p.Scan.Function == "RESILVER") {
			var progress *int
			if p.Scan.Total.value() > 0 {
				v := int(100 * float64(p.Scan.Examined.value()) / float64(p.Scan.Total.value()))
				if v > 100 {
					v = 100
				}
				progress = &v
			}
			zfsProgress(&vd, strings.ToLower(p.Scan.Function), progress)
		}
		rows[key] = vd
		var walk func(map[string]zfsVdev)
		walk = func(tree map[string]zfsVdev) {
			names := make([]string, 0, len(tree))
			for n := range tree {
				names = append(names, n)
			}
			sort.Strings(names)
			for _, n := range names {
				v := tree[n]
				if len(v.Children) > 0 {
					walk(v.Children)
					continue
				}
				if v.Type != "disk" && v.Type != "file" {
					complete = false
					continue
				}
				id := stable(v.Path)
				if id == "" {
					id = string(v.GUID)
				}
				if id == "" || v.State == "" {
					complete = false
					continue
				}
				zfsMember(rows, key, id, v.Path, v.State, v.Read.value(), v.Write.value(), v.Checksum.value())
			}
		}
		if len(p.Vdevs) == 0 {
			complete = false
		}
		for _, tree := range []map[string]zfsVdev{p.Vdevs, p.Special, p.Dedup, p.Logs, p.Cache, p.Spares} {
			walk(tree)
		}
	}
	for key, c := range rows {
		if c.ComponentType == "virtual_disk" && !observed[key] {
			complete = false
		}
	}
	r := Result{Components: sortedComponents(rows), Complete: complete}
	if !complete {
		r.Warnings = []string{"incomplete ZFS JSON topology"}
	}
	return r, nil
}
