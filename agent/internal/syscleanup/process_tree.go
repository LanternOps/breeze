package syscleanup

import (
	"context"
	"os/exec"
	"time"
)

// processTree groups a cleaner with the descendants it spawns so a deadline
// terminates the REAL worker rather than only the wrapper that launched it.
// cleanmgr.exe in session 0 is the case that forces this: it hands its work to
// a hidden progress UI and is documented to return early or hang, so the
// runner waits on the whole job object and the leader's exit code is
// informational only (spec §7.2).
//
// Containment setup is best-effort. Once assigned, drain must confirm tree
// completion or return an error before the runner releases its resources.
type processTree interface {
	// prepare mutates cmd before Start.
	prepare(cmd *exec.Cmd)
	// adopt takes ownership of the process immediately after Start.
	adopt(cmd *exec.Cmd)
	// kill terminates every process in the tree.
	kill(cmd *exec.Cmd)
	// drain waits for all assigned workers to exit, terminating them on cancellation.
	drain(ctx context.Context) error
	// cpuTime reports the CPU consumed by every process in the tree so far.
	// ok is false where the platform cannot measure it (POSIX, or a Windows
	// host where the job object could not be created), which DISABLES the
	// session-0 idle watchdog rather than letting it guess (#6482).
	cpuTime() (time.Duration, bool)
	// release drops the tree's OS resources WITHOUT terminating anything.
	release()
}
