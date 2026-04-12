//go:build !windows

package terminal

// killProcess terminates the child shell process.
func (s *Session) killProcess() {
	if s.cmd != nil && s.cmd.Process != nil {
		s.cmd.Process.Kill()
	}
}

// awaitProcess waits for the child shell process to exit.
func (s *Session) awaitProcess() error {
	if s.cmd != nil {
		return s.cmd.Wait()
	}
	return nil
}
