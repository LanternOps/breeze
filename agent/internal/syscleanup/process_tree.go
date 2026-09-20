package syscleanup

import "os/exec"

// processTree groups a cleaner with the descendants it spawns so a deadline
// terminates the REAL worker rather than only the wrapper that launched it.
// cleanmgr.exe in session 0 is the case that forces this: it hands its work to
// a hidden progress UI and is documented to return early or hang, so the
// runner waits on the whole job object and the leader's exit code is
// informational only (spec §7.2).
//
// Every method is best-effort by contract, exactly as the installer twin in
// internal/remote/tools/software_install_process_tree.go states: a platform
// that cannot contain the tree degrades to killing the direct child rather
// than failing an otherwise healthy cleanup.
type processTree interface {
	// prepare mutates cmd before Start.
	prepare(cmd *exec.Cmd)
	// adopt takes ownership of the process immediately after Start.
	adopt(cmd *exec.Cmd)
	// kill terminates every process in the tree.
	kill(cmd *exec.Cmd)
	// release drops the tree's OS resources WITHOUT terminating anything.
	release()
}
