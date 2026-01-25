//go:build darwin

package terminal

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"unsafe"
)

// Constants for macOS PTY ioctls
const (
	TIOCGPTN   = 0x40047476 // Get PTY number
	TIOCPTYGRANT = 0x20007454 // Grant access to slave PTY
	TIOCPTYUNLK  = 0x20007452 // Unlock slave PTY
)

// start starts the PTY session (macOS implementation)
func (s *Session) start() error {
	// Open a new PTY using posix_openpt equivalent
	master, err := os.OpenFile("/dev/ptmx", os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("failed to open PTY master: %w", err)
	}

	// Grant and unlock the slave PTY
	if err := grantpt(master); err != nil {
		master.Close()
		return fmt.Errorf("failed to grant PTY: %w", err)
	}

	if err := unlockpt(master); err != nil {
		master.Close()
		return fmt.Errorf("failed to unlock PTY: %w", err)
	}

	// Get the slave PTY name
	slaveName, err := ptsname(master)
	if err != nil {
		master.Close()
		return fmt.Errorf("failed to get slave PTY name: %w", err)
	}

	// Open the slave PTY
	slave, err := os.OpenFile(slaveName, os.O_RDWR, 0)
	if err != nil {
		master.Close()
		return fmt.Errorf("failed to open slave PTY: %w", err)
	}

	// Set initial size
	if err := setWinsize(master.Fd(), s.Cols, s.Rows); err != nil {
		master.Close()
		slave.Close()
		return fmt.Errorf("failed to set window size: %w", err)
	}

	// Create the shell command
	cmd := exec.Command(s.Shell)
	cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
		fmt.Sprintf("COLUMNS=%d", s.Cols),
		fmt.Sprintf("LINES=%d", s.Rows),
	)

	// Set up the command to use the TTY
	cmd.Stdin = slave
	cmd.Stdout = slave
	cmd.Stderr = slave
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid:  true,
		Setctty: true,
	}

	// Start the command
	if err := cmd.Start(); err != nil {
		master.Close()
		slave.Close()
		return fmt.Errorf("failed to start shell: %w", err)
	}

	// Close the slave in the parent - child has its own reference
	slave.Close()

	s.pty = master
	s.cmd = cmd

	// Start reading output in a goroutine
	go s.readLoop()

	// Wait for process to exit in a goroutine
	go func() {
		err := cmd.Wait()
		if s.onClose != nil {
			s.onClose(err)
		}
	}()

	return nil
}

// resize resizes the PTY window
func (s *Session) resize(cols, rows uint16) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed || s.pty == nil {
		return fmt.Errorf("session is not active")
	}

	s.Cols = cols
	s.Rows = rows

	return setWinsize(s.pty.Fd(), cols, rows)
}

// ptsname returns the name of the slave PTY (macOS uses ioctl)
func ptsname(f *os.File) (string, error) {
	// On macOS, we need to use a different approach
	// The slave name is /dev/ttysXXX corresponding to /dev/ptysXXX
	name := make([]byte, 128)

	// Use TIOCPTYGNAME on macOS
	const TIOCPTYGNAME = 0x40107471
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), TIOCPTYGNAME, uintptr(unsafe.Pointer(&name[0])))
	if errno != 0 {
		return "", fmt.Errorf("TIOCPTYGNAME failed: %w", errno)
	}

	// Find the null terminator
	for i, b := range name {
		if b == 0 {
			return string(name[:i]), nil
		}
	}
	return string(name), nil
}

// grantpt grants access to the slave PTY
func grantpt(f *os.File) error {
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), TIOCPTYGRANT, 0)
	if errno != 0 {
		return errno
	}
	return nil
}

// unlockpt unlocks the slave PTY
func unlockpt(f *os.File) error {
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), TIOCPTYUNLK, 0)
	if errno != 0 {
		return errno
	}
	return nil
}

// Winsize represents the terminal window size
type Winsize struct {
	Rows   uint16
	Cols   uint16
	Xpixel uint16
	Ypixel uint16
}

// setWinsize sets the window size of the PTY
func setWinsize(fd uintptr, cols, rows uint16) error {
	ws := &Winsize{
		Rows: rows,
		Cols: cols,
	}
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TIOCSWINSZ, uintptr(unsafe.Pointer(ws)))
	if errno != 0 {
		return errno
	}
	return nil
}
