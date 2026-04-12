//go:build windows

package terminal

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"

	"golang.org/x/sys/windows"
)

// start starts the terminal session. It uses ConPTY (Windows 10 1809+) when
// available, falling back to plain pipes on older systems.
func (s *Session) start() error {
	if conptyAvailable() {
		return s.startConPTY()
	}
	log.Warn("ConPTY not available, falling back to pipes (Ctrl+C/Backspace will not work)")
	return s.startPipes()
}

// startConPTY creates a Windows Pseudo Console for full terminal emulation.
// Control characters (Ctrl+C, Backspace, arrows, etc.) work natively.
func (s *Session) startConPTY() error {
	// Create two pipe pairs for ConPTY I/O.
	var inRead, inWrite windows.Handle
	if err := windows.CreatePipe(&inRead, &inWrite, nil, 0); err != nil {
		return fmt.Errorf("create input pipe: %w", err)
	}

	var outRead, outWrite windows.Handle
	if err := windows.CreatePipe(&outRead, &outWrite, nil, 0); err != nil {
		windows.CloseHandle(inRead)
		windows.CloseHandle(inWrite)
		return fmt.Errorf("create output pipe: %w", err)
	}

	// Create the pseudo console.
	hPC, err := createConPTY(s.Cols, s.Rows, inRead, outWrite)
	if err != nil {
		windows.CloseHandle(inRead)
		windows.CloseHandle(inWrite)
		windows.CloseHandle(outRead)
		windows.CloseHandle(outWrite)
		return fmt.Errorf("create ConPTY: %w", err)
	}

	// ConPTY has duplicated the pipe handles internally — close our copies
	// of the ends that belong to the ConPTY side.
	windows.CloseHandle(inRead)
	windows.CloseHandle(outWrite)

	// Build command line for the shell.
	cmdLine := buildCommandLine(s.Shell)

	// Create the child process attached to the pseudo console.
	hProc, hThread, pid, err := startProcessWithConPTY(hPC, cmdLine)
	if err != nil {
		closeConPTY(hPC)
		windows.CloseHandle(inWrite)
		windows.CloseHandle(outRead)
		return fmt.Errorf("start process with ConPTY: %w", err)
	}

	log.Info("ConPTY session started", "sessionId", s.ID, "pid", pid, "shell", s.Shell)

	// Store handles — use atomic stores for safe concurrent access from
	// killProcess/awaitProcess in other goroutines.
	atomic.StoreUintptr(&s.hConPty, hPC)
	atomic.StoreUintptr(&s.hProc, uintptr(hProc))
	atomic.StoreUintptr(&s.hThread, uintptr(hThread))

	// Wrap pipe ends as Go files for the Session I/O contract.
	s.stdin = os.NewFile(uintptr(inWrite), "conpty-in")
	s.pty = os.NewFile(uintptr(outRead), "conpty-out")

	// Start reading ConPTY output (reuses the cross-platform readLoop).
	go s.readLoop()

	// Wait for process to exit in a background goroutine.
	go func() {
		err := s.waitCmd()
		s.notifyClosed(err)
	}()

	return nil
}

// startPipes is the legacy fallback for systems without ConPTY. Control
// characters and resize are not supported in this mode.
func (s *Session) startPipes() error {
	var cmd *exec.Cmd
	shellBase := strings.ToLower(filepath.Base(s.Shell))
	if shellBase == "powershell.exe" || shellBase == "pwsh.exe" {
		cmd = exec.Command(s.Shell, "-NoExit", "-Command",
			"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "+
				"$Host.UI.RawUI.ForegroundColor = 'Gray'")
	} else {
		cmd = exec.Command(s.Shell)
	}
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")

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

	if err := cmd.Start(); err != nil {
		stdin.Close()
		stdout.Close()
		stderr.Close()
		return fmt.Errorf("failed to start shell: %w", err)
	}

	s.cmd = cmd
	s.stdin = stdin

	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := stdout.Read(buf)
			if n > 0 && s.onOutput != nil {
				data := make([]byte, n)
				copy(data, buf[:n])
				s.onOutput(data)
			}
			if err != nil {
				return
			}
		}
	}()

	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := stderr.Read(buf)
			if n > 0 && s.onOutput != nil {
				data := make([]byte, n)
				copy(data, buf[:n])
				s.onOutput(data)
			}
			if err != nil {
				return
			}
		}
	}()

	go func() {
		err := s.waitCmd()
		s.notifyClosed(err)
	}()

	return nil
}

// resize resizes the terminal. Only supported with ConPTY.
func (s *Session) resize(cols, rows uint16) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return fmt.Errorf("session is not active")
	}

	hPC := atomic.LoadUintptr(&s.hConPty)
	if hPC != 0 {
		s.Cols = cols
		s.Rows = rows
		return resizeConPTY(hPC, cols, rows)
	}

	return fmt.Errorf("terminal resize unsupported without ConPTY")
}

// buildCommandLine constructs the shell command line string.
func buildCommandLine(shell string) string {
	shellBase := strings.ToLower(filepath.Base(shell))
	if shellBase == "powershell.exe" || shellBase == "pwsh.exe" {
		return shell + ` -NoExit -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8"`
	}
	return shell
}
