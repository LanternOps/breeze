package hwhealth

import (
	"encoding/json"
	"fmt"
)

func parseWinPD(b []byte) (Result, error) {
	var doc struct {
		Disks    []windowsDisk
		Warnings []string
	}
	if e := json.Unmarshal(b, &doc); e != nil {
		return Result{}, e
	}
	if doc.Disks == nil {
		return Result{}, fmt.Errorf("missing Disks")
	}
	r := Result{Complete: true, Warnings: doc.Warnings}
	for _, d := range doc.Disks {
		if d.UniqueId == "" {
			r.Complete = false
			r.Warnings = append(r.Warnings, "disk UniqueId missing")
			continue
		}
		r.Components = append(r.Components, diskComponent("windows_physical_disk", "winpd:"+d.UniqueId, "", d))
	}
	return r, nil
}
