//go:build !windows

package helper

// openExitProbe: off Windows the agent is not Assist's parent and cannot read
// another process's exit status, so restarts log the exit code as unknown.
func openExitProbe(int, string) (exitProbe, error) {
	return nil, errExitProbeUnsupported
}
