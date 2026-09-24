package hwhealth

import (
	"encoding/json"
	"fmt"
)

// parseWinPD keys disks by UniqueId. remembered is the Storage Spaces member
// map (read-only here): a pooled disk in Lost Communication reports its pool
// member GUID as UniqueId, and must stay on its own row (#6895).
func parseWinPD(b []byte, remembered map[string]string) (Result, error) {
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
		r.Components = append(r.Components, diskComponent("windows_physical_disk", "winpd:"+memberUniqueID(d, remembered, false), "", d))
	}
	return r, nil
}
