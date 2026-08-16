package tools

import "os/exec"

// installerProcessTree groups an installer with the descendants it spawns so a
// genuine timeout can terminate the REAL setup process instead of only the
// wrapper that launched it. The context deadline kills the direct child alone,
// which on a hung install leaves the service installer / updater / bundled
// setup running as an orphan, still mutating the device long after the
// deployment was reported as timed out.
//
// The tree is torn down ONLY on the genuine-timeout path. A wrapper exiting
// successfully while its descendants keep installing is the normal case the
// WaitDelay handling exists to serve, so release() must relinquish ownership
// without signalling anything.
//
// Every method is best-effort by contract: a platform that cannot contain the
// tree degrades to today's kill-the-direct-child behavior rather than failing
// an otherwise healthy install.
type installerProcessTree interface {
	// prepare mutates cmd before Start.
	prepare(cmd *exec.Cmd)
	// adopt takes ownership of the process immediately after Start.
	adopt(cmd *exec.Cmd)
	// kill terminates every process in the tree.
	kill(cmd *exec.Cmd)
	// release drops the tree's OS resources WITHOUT terminating anything.
	release()
}
