package oemupdates

import (
	"os"
	"strings"
	"sync"
)

var (
	lanesOnce sync.Once
	lanes     map[string]Lane
)

// LaneFor returns the lane built into this agent. Each lane is a process-wide
// singleton so its availability gate stays cached across runs. W02 builds only
// Dell; Surface, HP and Lenovo arrive in their own waves.
func LaneFor(id string) (Lane, bool) {
	lanesOnce.Do(func() {
		lanes = map[string]Lane{LaneDell: newDellLane(systemDellHost())}
	})
	l, ok := lanes[id]
	return l, ok
}

func systemDellHost() dellHost {
	return dellHost{
		programFiles: func() []string {
			return []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)")}
		},
		exists: func(path string) bool {
			info, err := os.Stat(path)
			return err == nil && info.Mode().IsRegular()
		},
		fileVersion: peFileVersion,
		dotnetDesktopVersions: func() []string {
			base := os.Getenv("ProgramFiles")
			if base == "" {
				return nil
			}
			entries, err := os.ReadDir(strings.TrimRight(base, `\`) + `\dotnet\shared\Microsoft.WindowsDesktop.App`)
			if err != nil {
				return nil
			}
			out := make([]string, 0, len(entries))
			for _, e := range entries {
				if e.IsDir() {
					out = append(out, e.Name())
				}
			}
			return out
		},
	}
}
