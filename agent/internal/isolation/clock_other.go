//go:build !linux && !darwin && !windows

package isolation

import "time"

// On other platforms there is no isolator; the process clock is enough for
// the pure logic, and the boot ID is per process so the monotonic clause is
// never applied across a restart.
func systemMono() time.Duration { return processMono() }

func systemBootID() string { return processBootID() }
