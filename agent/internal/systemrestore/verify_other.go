//go:build !windows

package systemrestore

import "time"

// newEnvironment on a non-Windows platform reports ErrUnsupported from every
// read. Nothing here spawns a process, reads a registry or touches the
// filesystem — the no-op is total (#4609).
func newEnvironment() environment {
	return environment{
		probe:            func() error { return ErrUnsupported },
		enabled:          func() (bool, error) { return false, ErrUnsupported },
		elevated:         func() bool { return false },
		listPoints:       func() ([]restorePointRow, error) { return nil, ErrUnsupported },
		frequencyMinutes: func() (int64, error) { return 0, ErrUnsupported },
		now:              time.Now,
	}
}
