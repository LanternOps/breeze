package svcquery

import (
	"fmt"
	"strings"
)

// Tag-free so Linux CI exercises the darwin lookup logic; svcquery_darwin.go
// only runs `launchctl list` and stats the plist paths.

// parseLaunchctlList finds name in `launchctl list` output (PID, Status, Label
// columns). A label equal to name, or ending in "."+name, matches; the
// returned ServiceInfo carries the resolved label. A PID of "-" is a loaded
// but not running job. An absent label returns an error wrapping
// ErrServiceNotFound.
func parseLaunchctlList(output, name string) (ServiceInfo, error) {
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 || fields[0] == "PID" {
			continue
		}
		label := fields[2]
		if label == name || strings.HasSuffix(label, "."+name) {
			info := ServiceInfo{Name: label, Status: StatusStopped}
			if fields[0] != "-" {
				info.Status = StatusRunning
			}
			return info, nil
		}
	}
	return ServiceInfo{Name: name, Status: StatusUnknown}, fmt.Errorf("svcquery: launchd label %s not loaded: %w", name, ErrServiceNotFound)
}

// launchdPlistPaths are where an installed-but-unloaded job's plist lives.
func launchdPlistPaths(name string) []string {
	return []string{
		"/Library/LaunchDaemons/" + name + ".plist",
		"/Library/LaunchAgents/" + name + ".plist",
	}
}

// resolveLaunchdStatus is darwin GetStatus minus the exec. A failed
// `launchctl list` is an inspection failure, never "not found" (the service
// may be running); a label that is neither listed nor installed as a plist is
// ErrServiceNotFound; an installed but unloaded plist is stopped. plistExists
// reports a path's presence; an error (other than not-exist, which it must
// report as (false, nil)) is an inspection failure, never absence.
func resolveLaunchdStatus(listOutput string, listErr error, name string, plistExists func(path string) (bool, error)) (ServiceInfo, error) {
	if listErr != nil {
		return ServiceInfo{Name: name, Status: StatusUnknown}, fmt.Errorf("svcquery: launchctl list: %w", listErr)
	}
	info, err := parseLaunchctlList(listOutput, name)
	if err == nil {
		return info, nil
	}
	for _, p := range launchdPlistPaths(name) {
		exists, statErr := plistExists(p)
		if statErr != nil {
			return ServiceInfo{Name: name, Status: StatusUnknown}, fmt.Errorf("svcquery: stat %s: %w", p, statErr)
		}
		if exists {
			return ServiceInfo{Name: name, Status: StatusStopped}, nil
		}
	}
	return ServiceInfo{Name: name, Status: StatusUnknown}, fmt.Errorf("svcquery: service %s not found: %w", name, ErrServiceNotFound)
}
