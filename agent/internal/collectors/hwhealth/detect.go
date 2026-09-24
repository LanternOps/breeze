package hwhealth

import (
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

func lookupTool(names []string, extraDirs []string) (string, bool) {
	for _, n := range names {
		if p, e := exec.LookPath(n); e == nil {
			return p, true
		}
	}
	dirs := append(append([]string{}, wellKnownDirs()...), extraDirs...)
	for _, d := range dirs {
		for _, n := range names {
			if p, e := exec.LookPath(filepath.Join(d, n)); e == nil {
				return p, true
			}
		}
	}
	return "", false
}

type detection struct {
	mu      sync.Mutex
	checked time.Time
	value   Availability
}

func (d *detection) get(now time.Time, probe func() Availability) Availability {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.checked.IsZero() || now.Sub(d.checked) >= time.Hour {
		d.value = probe()
		d.checked = now
	}
	return d.value
}
