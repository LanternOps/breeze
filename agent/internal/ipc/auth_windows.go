//go:build windows

package ipc

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// PeerCredentials holds the verified identity of an IPC peer.
type PeerCredentials struct {
	PID        int
	UID        uint32 // Always 0 on Windows; use SID instead
	GID        uint32
	BinaryPath string
	SID        string // Windows Security Identifier
}

var (
	modkernel32                  = windows.NewLazySystemDLL("kernel32.dll")
	procGetNamedPipeClientProcessId = modkernel32.NewProc("GetNamedPipeClientProcessId")
)

// GetPeerCredentials returns the verified identity of a named pipe client.
// Uses GetNamedPipeClientProcessId + OpenProcessToken + GetTokenInformation.
func GetPeerCredentials(conn net.Conn) (*PeerCredentials, error) {
	handle, err := extractPipeHandle(conn)
	if err != nil {
		return nil, fmt.Errorf("ipc: extract pipe handle: %w", err)
	}

	// Get the client PID
	var clientPID uint32
	r1, _, callErr := procGetNamedPipeClientProcessId.Call(handle, uintptr(unsafe.Pointer(&clientPID)))
	if r1 == 0 {
		return nil, fmt.Errorf("ipc: GetNamedPipeClientProcessId: %w", callErr)
	}

	// Open the process to get its token
	proc, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, clientPID)
	if err != nil {
		return nil, fmt.Errorf("ipc: OpenProcess(%d): %w", clientPID, err)
	}
	defer windows.CloseHandle(proc)

	// Get binary path
	var pathBuf [windows.MAX_PATH]uint16
	pathLen := uint32(len(pathBuf))
	err = windows.QueryFullProcessImageName(proc, 0, &pathBuf[0], &pathLen)
	if err != nil {
		return nil, fmt.Errorf("ipc: QueryFullProcessImageName: %w", err)
	}
	binaryPath := syscall.UTF16ToString(pathBuf[:pathLen])

	// Open process token to get SID
	var token windows.Token
	err = windows.OpenProcessToken(proc, windows.TOKEN_QUERY, &token)
	if err != nil {
		return nil, fmt.Errorf("ipc: OpenProcessToken: %w", err)
	}
	defer token.Close()

	// Get token user
	tokenUser, err := token.GetTokenUser()
	if err != nil {
		return nil, fmt.Errorf("ipc: GetTokenUser: %w", err)
	}

	sid := tokenUser.User.Sid.String()

	return &PeerCredentials{
		PID:        int(clientPID),
		BinaryPath: binaryPath,
		SID:        sid,
	}, nil
}

// extractPipeHandle gets the underlying Windows handle from a net.Conn.
// Supports both Fd() (standard) and SyscallConn() (go-winio) interfaces.
func extractPipeHandle(conn net.Conn) (uintptr, error) {
	// Try Fd() first (works for standard net.Conn with file descriptors)
	type fdConn interface {
		Fd() uintptr
	}
	if fc, ok := conn.(fdConn); ok {
		return fc.Fd(), nil
	}

	// Try SyscallConn() (works for go-winio named pipe connections)
	type syscallConn interface {
		SyscallConn() (syscall.RawConn, error)
	}
	if sc, ok := conn.(syscallConn); ok {
		rawConn, err := sc.SyscallConn()
		if err != nil {
			return 0, fmt.Errorf("SyscallConn: %w", err)
		}
		var handle uintptr
		err = rawConn.Control(func(fd uintptr) {
			handle = fd
		})
		if err != nil {
			return 0, fmt.Errorf("RawConn.Control: %w", err)
		}
		return handle, nil
	}

	return 0, fmt.Errorf("unable to get handle from connection type %T", conn)
}

// IdentityKey returns the platform identity key for this peer.
// On Windows, this is the kernel-verified SID string.
func (p *PeerCredentials) IdentityKey() string {
	return p.SID
}

// DefaultSocketPath returns the default named pipe path for Windows.
func DefaultSocketPath() string {
	return `\\.\pipe\breeze-agent-ipc`
}

// isNamedPipePath returns true if the path is a Windows named pipe.
func isNamedPipePath(path string) bool {
	return strings.HasPrefix(path, `\\.\pipe\`)
}

// VerifyBinaryPath checks if the binary path matches the expected agent path.
func VerifyBinaryPath(binaryPath string) bool {
	expected, err := os.Executable()
	if err != nil {
		return false
	}
	expected, _ = filepath.EvalSymlinks(expected)
	binaryPath, _ = filepath.EvalSymlinks(binaryPath)
	return strings.EqualFold(filepath.Clean(expected), filepath.Clean(binaryPath))
}
