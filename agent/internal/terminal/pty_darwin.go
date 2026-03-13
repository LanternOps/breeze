//go:build darwin && cgo

package terminal

/*
#include <stdlib.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/ioctl.h>
*/
import "C"

import (
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"syscall"
	"unsafe"
)

// start starts the PTY session (macOS implementation using cgo)
func (s *Session) start() error {
	// Open PTY master via posix_openpt
	masterFd, err := C.posix_openpt(C.O_RDWR)
	if masterFd < 0 || err != nil {
		return fmt.Errorf("posix_openpt failed: %w", err)
	}

	// Grant and unlock
	if rc := C.grantpt(masterFd); rc != 0 {
		C.close(masterFd)
		return fmt.Errorf("grantpt failed")
	}
	if rc := C.unlockpt(masterFd); rc != 0 {
		C.close(masterFd)
		return fmt.Errorf("unlockpt failed")
	}

	// Get slave name
	cName := C.ptsname(masterFd)
	if cName == nil {
		C.close(masterFd)
		return fmt.Errorf("ptsname returned nil")
	}
	slaveName := C.GoString(cName)

	// Wrap the C fd in a Go *os.File
	master := os.NewFile(uintptr(masterFd), "/dev/ptmx")
	if master == nil {
		C.close(masterFd)
		return fmt.Errorf("failed to wrap master fd")
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

	// Create the shell command as a login shell (-l) so that
	// profile scripts are sourced and readline/line editing is
	// fully initialised — matching what SSH and terminal emulators do.
	cmd := exec.Command(s.Shell, "-l")

	// Build environment. LaunchDaemons have a very minimal env, so
	// ensure HOME/USER/LOGNAME/SHELL are set — zsh needs these to
	// source profile scripts and render a prompt.
	env := os.Environ()
	if os.Getenv("HOME") == "" {
		if u, err := user.Current(); err == nil {
			env = append(env, "HOME="+u.HomeDir, "USER="+u.Username, "LOGNAME="+u.Username)
		} else {
			env = append(env, "HOME=/var/root", "USER=root", "LOGNAME=root")
		}
	}
	if os.Getenv("SHELL") == "" {
		env = append(env, "SHELL="+s.Shell)
	}
	env = append(env,
		"TERM=xterm-256color",
		fmt.Sprintf("COLUMNS=%d", s.Cols),
		fmt.Sprintf("LINES=%d", s.Rows),
	)
	cmd.Env = env

	// Set up the command to use the TTY.
	// NOTE: Do NOT use Setctty in SysProcAttr on macOS with CGO.
	// After CGO calls (posix_openpt, grantpt, etc.), internal libc locks may
	// be held by other threads. fork() copies these locked mutexes into the
	// child, and the TIOCSCTTY ioctl (called via libc trampoline) deadlocks.
	cmd.Stdin = slave
	cmd.Stdout = slave
	cmd.Stderr = slave
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid: true,
	}

	// Start the command
	if err := cmd.Start(); err != nil {
		master.Close()
		slave.Close()
		return fmt.Errorf("failed to start shell: %w", err)
	}
	log.Info("PTY session started", "sessionId", s.ID, "pid", cmd.Process.Pid)

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
