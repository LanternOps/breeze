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
	// For Windows named pipes, we need the raw handle.
	// net.Conn from named pipe libraries typically expose the underlying handle.
	type handleConn interface {
		Fd() uintptr
	}
	hc, ok := conn.(handleConn)
	if !ok {
		// Fallback: get peer info from the pipe connection if available
		return getPeerCredentialsFallback(conn)
	}

	handle := hc.Fd()

	// Get the client PID
	var clientPID uint32
	r1, _, err := procGetNamedPipeClientProcessId.Call(handle, uintptr(unsafe.Pointer(&clientPID)))
	if r1 == 0 {
		return nil, fmt.Errorf("ipc: GetNamedPipeClientProcessId: %w", err)
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

// getPeerCredentialsFallback handles connections where Fd() is not available.
func getPeerCredentialsFallback(conn net.Conn) (*PeerCredentials, error) {
	// For standard net.Conn over named pipes, we may not have direct access.
	// Return an error indicating the connection type is unsupported.
	return nil, fmt.Errorf("ipc: unable to get peer credentials from connection type %T", conn)
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
