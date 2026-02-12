//go:build darwin && !cgo

package terminal

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"unsafe"
)

// start starts the PTY session (macOS pure-Go implementation without cgo).
// Uses /dev/ptmx directly which works on macOS without cgo.
func (s *Session) start() error {
	// Open the PTY master
	master, err := os.OpenFile("/dev/ptmx", os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("failed to open /dev/ptmx: %w", err)
	}

	// grantpt and unlockpt via ioctls
	if err := grantptFd(master.Fd()); err != nil {
		master.Close()
		return fmt.Errorf("grantpt failed: %w", err)
	}
	if err := unlockptFd(master.Fd()); err != nil {
		master.Close()
		return fmt.Errorf("unlockpt failed: %w", err)
	}

	// Get slave PTY name
	slaveName, err := ptsnameFd(master.Fd())
	if err != nil {
		master.Close()
		return fmt.Errorf("ptsname failed: %w", err)
	}

	// Open the slave PTY
	slave, err := os.OpenFile(slaveName, os.O_RDWR, 0)
	if err != nil {
		master.Close()
		return fmt.Errorf("failed to open slave PTY %s: %w", slaveName, err)
	}

	// Set initial window size
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

// ptsnameFd returns the name of the slave PTY.
// On macOS, TIOCPTYGNAME is used instead of Linux's TIOCGPTN.
func ptsnameFd(fd uintptr) (string, error) {
	// TIOCPTYGNAME on macOS returns the slave device path directly
	// It's defined as _IOC(IOC_OUT, 't', 41, 128) = 0x40807441
	const TIOCPTYGNAME = 0x40807441
	buf := make([]byte, 128)
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, TIOCPTYGNAME, uintptr(unsafe.Pointer(&buf[0])))
	if errno != 0 {
		return "", errno
	}
	// Find null terminator
	for i, b := range buf {
		if b == 0 {
			return string(buf[:i]), nil
		}
	}
	return string(buf), nil
}

// grantptFd is a no-op on macOS when using /dev/ptmx
// (the kernel handles granting automatically).
func grantptFd(fd uintptr) error {
	return nil
}

// unlockptFd unlocks the slave PTY on macOS.
func unlockptFd(fd uintptr) error {
	// On macOS, TIOCSPTLCK is not available; the PTY is unlocked by default
	// when opened via /dev/ptmx. No action needed.
	return nil
}
