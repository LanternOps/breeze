package mgmtdetect

import (
	"strings"

	"github.com/shirou/gopsutil/v3/process"
)

// processSnapshot caches all process names for batch matching.
type processSnapshot struct {
	names map[string]bool // lowercase process names
}

func newProcessSnapshot() (*processSnapshot, error) {
	procs, err := process.Processes()
	if err != nil {
		return nil, err
	}

	names := make(map[string]bool, len(procs))
	skipped := 0
	for _, p := range procs {
		name, err := p.Name()
		if err != nil || name == "" {
			skipped++
			continue
		}
		names[strings.ToLower(name)] = true
	}

	if skipped > 0 {
		log.Debug("process snapshot skipped processes", "skipped", skipped, "total", len(procs))
	}

	return &processSnapshot{names: names}, nil
}

func (s *processSnapshot) isRunning(name string) bool {
	return s.names[strings.ToLower(name)]
}

func (s *processSnapshot) count() int {
	return len(s.names)
}
