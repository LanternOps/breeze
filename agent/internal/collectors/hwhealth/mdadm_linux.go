//go:build linux

package hwhealth

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"
)

var mdNames = regexp.MustCompile(`(?m)^(md[^ ]+)\s+:`)

// mdstatPath is a variable so tests can drive Collect from a fixture.
var mdstatPath = "/proc/mdstat"

func stableMDDevice(dev string) string {
	target, e := filepath.EvalSymlinks(dev)
	if e != nil {
		return ""
	}
	paths, _ := filepath.Glob("/dev/disk/by-id/*")
	sort.Strings(paths)
	for _, p := range paths {
		resolved, e := filepath.EvalSymlinks(p)
		if e == nil && resolved == target {
			return filepath.Base(p)
		}
	}
	return ""
}

func newMDADM(extra []string, run toolRunner, members map[string]string) Source {
	return &source{
		kind: "mdadm",
		tier: TierRAID,
		detect: func(context.Context) Availability {
			b, e := os.ReadFile(mdstatPath)
			p, ok := lookupTool([]string{"mdadm"}, extra)
			return Availability{Path: p, Available: e == nil && mdNames.Match(b) && ok}
		},
		collect: func(ctx context.Context, a Availability) (Result, error) {
			b, e := os.ReadFile(mdstatPath)
			if e != nil {
				return Result{}, e
			}
			r := Result{Complete: true}
			for _, m := range mdNames.FindAllSubmatch(b, -1) {
				name := string(m[1])
				out, e := run(ctx, 15*time.Second, a.Path, "--detail", "/dev/"+name)
				if e == nil && out.ExitCode != 0 {
					e = fmt.Errorf("mdadm exit %d", out.ExitCode)
				}
				if e != nil {
					r.Complete = false
					r.Warnings = append(r.Warnings, e.Error())
					continue
				}
				part, e := parseMD(name, string(b), string(out.Stdout), stableMDDevice, members)
				if e != nil {
					r.Complete = false
					r.Warnings = append(r.Warnings, e.Error())
					continue
				}
				r.Components = mergeComponents(r.Components, part.Components)
				r.Complete = r.Complete && part.Complete
				r.Warnings = append(r.Warnings, part.Warnings...)
			}
			if !r.Complete && len(r.Components) == 0 {
				return r, fmt.Errorf("mdadm collection failed: %v", r.Warnings)
			}
			return r, nil
		},
	}
}
