//go:build windows

package terminal

import (
	"fmt"
	"io"
	"os"
	"os/exec"
)

// start starts the terminal session (Windows implementation using pipes)
// Note: This is a simplified implementation. For full PTY support on Windows,
// you would need to use ConPTY (available in Windows 10 1809+)
func (s *Session) start() error {
	// Create the shell command
	cmd := exec.Command(s.Shell)
	cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
	)

	// Create pipes for stdin/stdout/stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("failed to create stdin pipe: %w", err)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		return fmt.Errorf("failed to create stdout pipe: %w", err)
	}

	stderr, err := cmd.StderrPipe()
	if err != nil {
		stdin.Close()
		stdout.Close()
		return fmt.Errorf("failed to create stderr pipe: %w", err)
	}

	// Start the command
	if err := cmd.Start(); err != nil {
		stdin.Close()
		stdout.Close()
		stderr.Close()
		return fmt.Errorf("failed to start shell: %w", err)
	}

	s.cmd = cmd

	// Create a pipe for the pseudo-PTY interface
	// We'll use the stdin writer as our "PTY" for writing
	s.pty = stdin.(*os.File)

	// Start reading stdout in a goroutine
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := stdout.Read(buf)
			if err != nil {
				if err != io.EOF && s.onClose != nil {
					s.onClose(err)
				}
				return
			}
			if n > 0 && s.onOutput != nil {
				data := make([]byte, n)
				copy(data, buf[:n])
				s.onOutput(data)
			}
		}
	}()

	// Start reading stderr in a goroutine
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := stderr.Read(buf)
			if err != nil {
				if err != io.EOF {
					return
				}
				return
			}
			if n > 0 && s.onOutput != nil {
				data := make([]byte, n)
				copy(data, buf[:n])
				s.onOutput(data)
			}
		}
	}()

	// Wait for process to exit in a goroutine
	go func() {
		err := cmd.Wait()
		if s.onClose != nil {
			s.onClose(err)
		}
	}()

	return nil
}

// resize is a no-op on Windows without ConPTY
func (s *Session) resize(cols, rows uint16) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return fmt.Errorf("session is not active")
	}

	// Update stored dimensions
	s.Cols = cols
	s.Rows = rows

	// Note: Without ConPTY, we cannot actually resize the terminal
	// This would require implementing ConPTY support
	return nil
}
