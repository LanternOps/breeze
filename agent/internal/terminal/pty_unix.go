//go:build linux

package terminal

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"unsafe"
)

// start starts the PTY session (Unix implementation using native pty)
func (s *Session) start() error {
	// Open a new PTY
	pty, tty, err := openPty()
	if err != nil {
		return fmt.Errorf("failed to open PTY: %w", err)
	}

	// Set initial size
	if err := setWinsize(pty.Fd(), s.Cols, s.Rows); err != nil {
		pty.Close()
		tty.Close()
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
	cmd.Stdin = tty
	cmd.Stdout = tty
	cmd.Stderr = tty
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid:  true,
		Setctty: true,
	}

	// Start the command
	if err := cmd.Start(); err != nil {
		pty.Close()
		tty.Close()
		return fmt.Errorf("failed to start shell: %w", err)
	}

	// Close the TTY in the parent - child has its own reference
	tty.Close()

	s.pty = pty
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

// openPty opens a new PTY master/slave pair
func openPty() (*os.File, *os.File, error) {
	// Open the PTY master
	master, err := os.OpenFile("/dev/ptmx", os.O_RDWR, 0)
	if err != nil {
		return nil, nil, err
	}

	// Get the slave PTY name
	slaveName, err := ptsname(master)
	if err != nil {
		master.Close()
		return nil, nil, err
	}

	// Unlock the slave PTY
	if err := unlockpt(master); err != nil {
		master.Close()
		return nil, nil, err
	}

	// Open the slave PTY
	slave, err := os.OpenFile(slaveName, os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		master.Close()
		return nil, nil, err
	}

	return master, slave, nil
}

// ptsname returns the name of the slave PTY
func ptsname(f *os.File) (string, error) {
	var n uint32
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), syscall.TIOCGPTN, uintptr(unsafe.Pointer(&n)))
	if errno != 0 {
		return "", errno
	}
	return fmt.Sprintf("/dev/pts/%d", n), nil
}

// unlockpt unlocks the slave PTY
func unlockpt(f *os.File) error {
	var u int32
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), syscall.TIOCSPTLCK, uintptr(unsafe.Pointer(&u)))
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
