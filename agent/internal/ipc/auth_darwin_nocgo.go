//go:build darwin && !cgo

package ipc

import (
	"bytes"
	"fmt"
	"log/slog"
	"net"
	"strconv"

	"golang.org/x/sys/unix"
)

// PeerCredentials holds the verified identity of an IPC peer.
type PeerCredentials struct {
	PID        int
	UID        uint32
	GID        uint32
	BinaryPath string
	SID        string // Empty on Unix; populated on Windows.
}

// GetPeerCredentials returns the kernel-verified PID/UID/GID of the peer
// via LOCAL_PEERCRED (xucred) and resolves the peer executable path using
// kern.procargs2. This is the pure-Go (no-cgo) implementation for macOS.
func GetPeerCredentials(conn net.Conn) (*PeerCredentials, error) {
	uc, ok := conn.(*net.UnixConn)
	if !ok {
		return nil, fmt.Errorf("ipc: not a unix connection")
	}

	raw, err := uc.SyscallConn()
	if err != nil {
		return nil, fmt.Errorf("ipc: get syscall conn: %w", err)
	}

	var pid int
	var uid, gid uint32
	var credErr error

	err = raw.Control(func(fd uintptr) {
		// Get PID via LOCAL_PEERPID
		pidVal, err := unix.GetsockoptInt(int(fd), unix.SOL_LOCAL, 0x002) // LOCAL_PEERPID = 0x002
		if err != nil {
			credErr = fmt.Errorf("getsockopt LOCAL_PEERPID: %w", err)
			return
		}
		pid = pidVal

		// Get UID/GID via LOCAL_PEERCRED (xucred)
		xcred, err := unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
		if err != nil {
			credErr = fmt.Errorf("getsockopt LOCAL_PEERCRED: %w", err)
			return
		}
		uid = xcred.Uid
		if len(xcred.Groups) > 0 {
			gid = xcred.Groups[0]
		}
	})
	if err != nil {
		return nil, fmt.Errorf("ipc: control: %w", err)
	}
	if credErr != nil {
		return nil, credErr
	}

	exePath, err := peerExecutablePath(pid)
	if err != nil {
		slog.Warn("ipc: failed to resolve peer executable path, continuing with empty ExePath",
			"pid", pid, "error", err.Error())
	}

	return &PeerCredentials{
		PID:        pid,
		UID:        uid,
		GID:        gid,
		BinaryPath: exePath,
	}, nil
}

func peerExecutablePath(pid int) (string, error) {
	data, err := unix.SysctlRaw("kern.procargs2", pid)
	if err != nil {
		return "", fmt.Errorf("ipc: sysctl kern.procargs2(%d): %w", pid, err)
	}
	if len(data) <= 4 {
		return "", fmt.Errorf("ipc: kern.procargs2(%d) returned too little data", pid)
	}

	// The buffer begins with argc, followed by the executable path and argv
	// strings. We only need argv[0], which is the first NUL-terminated string
	// after argc.
	args := data[4:]
	if end := bytes.IndexByte(args, 0); end > 0 {
		return string(args[:end]), nil
	}

	return "", fmt.Errorf("ipc: unable to parse executable path from kern.procargs2(%d)", pid)
}

// IdentityKey returns the platform identity key for this peer.
// On macOS, this is the kernel-verified UID as a string.
func (p *PeerCredentials) IdentityKey() string {
	return strconv.FormatUint(uint64(p.UID), 10)
}

// DefaultSocketPath returns the default IPC socket path for macOS.
func DefaultSocketPath() string {
	return "/Library/Application Support/Breeze/agent.sock"
}
