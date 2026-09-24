//go:build linux

package hwhealth

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type zfsSource struct {
	dirs   []string
	run    toolRunner
	stable func(string) string
}

func newZFSSource(dirs []string) *zfsSource {
	return &zfsSource{dirs: dirs, run: runTool, stable: stableZFSID}
}
func (s *zfsSource) Name() Kind { return "zfs" }
func (s *zfsSource) Tier() Tier { return "raid" }
func (s *zfsSource) Detect(ctx context.Context) Availability {
	path, ok := lookupTool([]string{"zpool"}, s.dirs)
	if !ok {
		return Availability{}
	}
	out, err := s.run(ctx, 30*time.Second, path, "list", "-H", "-o", "name,health,size,alloc,free")
	// A discovered binary whose pool probe fails must surface as failed during Collect.
	text := strings.TrimSpace(string(out.Stdout))
	return Availability{Path: path, Available: err != nil || out.ExitCode != 0 || out.Truncated || text != "" && text != "no pools available"}
}
func (s *zfsSource) Collect(ctx context.Context, a Availability) (Result, error) {
	list, err := s.run(ctx, 30*time.Second, a.Path, "list", "-H", "-o", "name,health,size,alloc,free")
	if err != nil || list.Truncated || list.ExitCode != 0 {
		return Result{}, fmt.Errorf("zpool list failed: exit=%d: %v", list.ExitCode, err)
	}
	if text := strings.TrimSpace(string(list.Stdout)); text == "" || text == "no pools available" {
		return Result{Complete: true, Components: []Component{}}, nil
	}
	if rows, _ := zfsBase(string(list.Stdout)); len(rows) == 0 {
		return Result{}, fmt.Errorf("unrecognized zpool list output")
	}
	status, err := s.run(ctx, 30*time.Second, a.Path, "status", "-pP")
	r := parseZFSText(string(list.Stdout), string(status.Stdout), s.stable)
	if err != nil || status.Truncated || status.ExitCode != 0 {
		r = parseZFSText(string(list.Stdout), "", s.stable)
		r.Complete = false
		r.Warnings = append(r.Warnings, "zpool status failed")
	}
	return r, nil
}
func stableZFSID(path string) string {
	if strings.HasPrefix(path, "/dev/disk/by-id/") {
		return filepath.Base(path)
	}
	if _, err := strconv.ParseUint(path, 10, 64); err == nil {
		return path
	}
	if !strings.HasPrefix(path, "/dev/") {
		return ""
	}
	target, err := filepath.EvalSymlinks(path)
	if err != nil {
		return ""
	}
	entries, err := os.ReadDir("/dev/disk/by-id")
	if err != nil {
		return ""
	}
	ids := []string{}
	for _, entry := range entries {
		if p, err := filepath.EvalSymlinks(filepath.Join("/dev/disk/by-id", entry.Name())); err == nil && p == target {
			ids = append(ids, entry.Name())
		}
	}
	sort.Strings(ids)
	if len(ids) > 0 {
		return ids[0]
	}
	return ""
}

var zfsPoolBlock = regexp.MustCompile(`(?m)^\s*pool:\s*(\S+)\s*$`)

func zfsBase(list string) (map[string]Component, bool) {
	rows := map[string]Component{}
	complete := true
	for _, line := range strings.Split(strings.TrimSpace(list), "\n") {
		f := strings.Fields(line)
		if len(f) != 5 {
			complete = false
			continue
		}
		key := "zfs:pool:" + f[0]
		c := textComponent("zfs", "virtual_disk", key, "zfs:ctrl", f[0], f[1])
		c.SizeBytes = textSize(f[2])
		c.Attributes["memberKeys"] = []string{}
		rows[key] = c
	}
	if len(rows) > 0 {
		ctrl := textComponent("zfs", "controller", "zfs:ctrl", "", "ZFS", "ok")
		ctrl.State = "ok"
		rows[ctrl.ComponentKey] = ctrl
	}
	return rows, complete
}
func zfsProgress(c *Component, operation string, progress *int) {
	if c.State == "failed" || c.State == "offline" || c.State == "unknown" {
		return
	}
	c.State = remainingVendorState("zfs", "virtual_disk", operation)
	c.ProgressPercent = progress
}
func zfsMember(rows map[string]Component, pool, identity, path, raw string, read, write, checksum uint64) {
	key := memberKey(pool, identity)
	// An in-use spare is listed under its vdev and again under "spares"; keep the first.
	if _, seen := rows[key]; seen {
		return
	}
	c := textComponent("zfs", "physical_disk", key, "zfs:ctrl", identity, raw)
	errors := read > 0 || write > 0 || checksum > 0
	c.MemberErrors = &errors
	c.Attributes["osDevice"] = path
	c.Attributes["readErrors"] = read
	c.Attributes["writeErrors"] = write
	c.Attributes["checksumErrors"] = checksum
	rows[key] = c
	vd := rows[pool]
	vd.Attributes["memberKeys"] = append(vd.Attributes["memberKeys"].([]string), key)
	rows[pool] = vd
}
func parseZFSText(list, status string, stable func(string) string) Result {
	rows, complete := zfsBase(list)
	observed := map[string]bool{}
	for _, block := range textBlocks(zfsPoolBlock, status) {
		name := zfsPoolBlock.FindStringSubmatch(block[0])[1]
		key := "zfs:pool:" + name
		vd, ok := rows[key]
		if !ok {
			complete = false
			continue
		}
		f := textFields(block[1])
		if f["state"] == "" {
			complete = false
			continue
		}
		vd.State = remainingVendorState("zfs", "virtual_disk", f["state"])
		vd.StateDetail = textPtr(f["state"])
		if strings.Contains(f["scan"], "in progress") {
			for _, operation := range []string{"scrub", "resilver"} {
				if strings.Contains(f["scan"], operation) {
					zfsProgress(&vd, operation, textProgress(block[1]))
				}
			}
		}
		rows[key] = vd
		observed[key] = true
		table := false
		finished := false
		spares := false
		for _, line := range strings.Split(block[1], "\n") {
			f := strings.Fields(line)
			if len(f) == 0 {
				continue
			}
			if f[0] == "NAME" {
				table = true
				continue
			}
			if f[0] == "errors:" {
				finished = true
				table = false
			}
			if !table {
				continue
			}
			// Only leaf paths or unavailable numeric GUIDs are physical disks.
			if !strings.HasPrefix(f[0], "/dev/") {
				if _, err := strconv.ParseUint(f[0], 10, 64); err != nil {
					if len(f) == 1 {
						// Section labels: spares, logs, cache, special, dedup.
						spares = f[0] == "spares"
					}
					continue
				}
			}
			// Hot spares print only NAME and STATE (AVAIL/INUSE/UNAVAIL), no error counters.
			if spares && len(f) >= 2 && len(f) < 5 {
				identity := stable(f[0])
				if identity == "" {
					complete = false
					continue
				}
				zfsMember(rows, key, identity, f[0], f[1], 0, 0, 0)
				continue
			}
			// A footer cannot make a skipped, shortened leaf a complete observation.
			if len(f) < 5 {
				complete = false
				continue
			}
			identity := stable(f[0])
			if identity == "" {
				complete = false
				continue
			}
			counters := [3]uint64{}
			valid := true
			for i := 0; i < 3; i++ {
				n, err := strconv.ParseUint(f[i+2], 10, 64)
				if err != nil {
					valid = false
				}
				counters[i] = n
			}
			if !valid {
				complete = false
				continue
			}
			zfsMember(rows, key, identity, f[0], f[1], counters[0], counters[1], counters[2])
		}
		if !finished {
			complete = false
		}
	}
	for key, c := range rows {
		if c.ComponentType == "virtual_disk" && !observed[key] {
			complete = false
		}
	}
	r := Result{Components: sortedComponents(rows), Complete: complete}
	if !complete {
		r.Warnings = []string{"incomplete ZFS status or member without stable identity"}
	}
	return r
}
