package oemupdates

import (
	"os"
	"strings"
	"sync"
	"time"
)

var (
	lanesOnce sync.Once
	lanes     map[string]Lane
)

// LaneFor returns the lane built into this agent. Each lane is a process-wide
// singleton so its availability gate stays cached across runs. Lenovo arrives in
// its own wave.
func LaneFor(id string) (Lane, bool) {
	lanesOnce.Do(func() {
		lanes = map[string]Lane{
			LaneDell:    newDellLane(systemDellHost()),
			LaneSurface: newSurfaceLane(systemSurfaceHost()),
			LaneHP:      newHPLane(systemHPHost()),
		}
	})
	l, ok := lanes[id]
	return l, ok
}

func systemHPHost() hpHost {
	store := DefaultStore()
	return hpHost{
		identity:      hpSMBIOSIdentity,
		toolDir:       func() (string, error) { return store.Dir(hpToolDirName) },
		exists:        regularFileNoLink,
		fileVersion:   peFileVersion,
		rebootPending: detectPendingReboot,
		bootTime:      systemInfo{}.BootTime,
		now:           time.Now,
		store:         store,
		programFiles:  func() string { return os.Getenv("ProgramFiles") },
		dirExists: func(path string) bool {
			info, err := os.Lstat(path)
			return err == nil && info.IsDir()
		},
		listDir: func(path string) []string {
			entries, err := os.ReadDir(path)
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
		verifier:   authenticodeVerifier{},
		powershell: hpPowerShellPath,
	}
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
