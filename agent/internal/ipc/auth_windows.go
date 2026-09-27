//go:build windows

package ipc

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// PipeClientAccessMask is the access mask IPC clients request when dialing
// the agent broker's named pipe, in place of go-winio's default
// DialPipe/DialPipeContext behavior (GENERIC_READ | GENERIC_WRITE).
//
// GENERIC_WRITE expands to FILE_GENERIC_WRITE, which includes
// FILE_APPEND_DATA — on a named pipe, FILE_CREATE_PIPE_INSTANCE. A client
// never needs that right, and the broker's pipe DACL does not grant it to
// Interactive Users (see sessionbroker's pipeSecurity). Requesting
// FILE_WRITE_DATA directly asks for exactly the message-write access the IPC
// protocol uses. This is least privilege, not a compatibility requirement:
// Windows does not enforce FILE_CREATE_PIPE_INSTANCE on a client open of an
// existing pipe, so a GENERIC_WRITE client open still succeeds against the
// narrowed DACL; the right is only checked when a server instance is created.
const (
	genericRead          = 0x80000000
	fileWriteData        = 0x00000002
	PipeClientAccessMask = genericRead | fileWriteData
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
	modkernel32                     = windows.NewLazySystemDLL("kernel32.dll")
	procGetNamedPipeClientProcessId = modkernel32.NewProc("GetNamedPipeClientProcessId")
	procGetNamedPipeServerProcessId = modkernel32.NewProc("GetNamedPipeServerProcessId")
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

	return credentialsForPID(clientPID)
}

// GetServerCredentials returns the verified identity of the process on the
// OTHER end of a named pipe connection, from the dialing client's point of
// view. Uses GetNamedPipeServerProcessId + OpenProcessToken +
// GetTokenInformation — the mirror image of GetPeerCredentials, which the
// broker uses to verify connecting clients. A client dials a pipe by name
// only, so without this call it has no kernel-verified way to know whether
// the process that accepted the connection is the real agent broker or a
// pipe of the same name created by another process.
func GetServerCredentials(conn net.Conn) (*PeerCredentials, error) {
	handle, err := extractPipeHandle(conn)
	if err != nil {
		return nil, fmt.Errorf("ipc: extract pipe handle: %w", err)
	}

	var serverPID uint32
	r1, _, callErr := procGetNamedPipeServerProcessId.Call(handle, uintptr(unsafe.Pointer(&serverPID)))
	if r1 == 0 {
		return nil, fmt.Errorf("ipc: GetNamedPipeServerProcessId: %w", callErr)
	}

	return credentialsForPID(serverPID)
}

// credentialsForPID resolves the kernel-verified binary path and token-user
// SID of the given process ID. Shared by GetPeerCredentials (client PID) and
// GetServerCredentials (server PID) — the only difference between the two is
// which side of the pipe the PID came from.
func credentialsForPID(pid uint32) (*PeerCredentials, error) {
	// Open the process to get its token
	proc, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			return nil, fmt.Errorf("ipc: OpenProcess(%d): %w: %w", pid, ErrServerProcessNotQueryable, err)
		}
		return nil, fmt.Errorf("ipc: OpenProcess(%d): %w", pid, err)
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
		PID:        int(pid),
		BinaryPath: binaryPath,
		SID:        sid,
	}, nil
}

// ExpectedAgentBinaryPath returns the path this process expects the
// privileged agent broker to be running from: breeze-agent.exe next to the
// current executable. This mirrors the installation layout the broker
// itself assumes when resolving its own sibling helper binaries (see
// sessionbroker.userHelperExePath) — every first-party IPC client ships in
// the same directory as breeze-agent.exe. Returns "" if this process's own
// path cannot be resolved, in which case callers should skip the path
// comparison rather than treat an unresolved path as a match.
func ExpectedAgentBinaryPath() string {
	self, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Join(filepath.Dir(self), "breeze-agent.exe")
}

// VerifyServerIdentity performs the client-side named-pipe server-trust
// check. It gathers kernel-verified evidence about whoever accepted conn —
// the pipe object's owner (read through conn's own handle) and, when this
// process is allowed to query it, the server process's token SID and image
// path — and applies CheckServerIdentity. Callers MUST close conn and
// abandon the session on a non-nil return — it means the pipe may not be
// talking to the real agent broker (a restart-window race, or another
// process owning that pipe name), so nothing should be sent to it,
// including the auth request.
//
// Unprivileged clients (the user-session helper) cannot open a Local System
// process even for limited query, so OpenProcess is expected to fail with
// ERROR_ACCESS_DENIED for them; the pipe-owner check is then the evidence.
// Any other failure fails closed.
func VerifyServerIdentity(conn net.Conn) error {
	handle, err := extractPipeHandle(conn)
	if err != nil {
		return fmt.Errorf("ipc: extract pipe handle: %w", err)
	}
	owner, err := pipeOwnerSID(windows.Handle(handle))
	if err != nil {
		return fmt.Errorf("ipc: read pipe owner: %w", err)
	}
	ev := ServerIdentityEvidence{PipeOwnerSID: owner, ExpectedPath: ExpectedAgentBinaryPath()}

	creds, err := GetServerCredentials(conn)
	switch {
	case err == nil:
		ev.ProcessQueried = true
		ev.ProcessSID = creds.SID
		ev.ProcessPath = creds.BinaryPath
	case serverProcessNotQueryable(err):
		// Not allowed to open the server process: rely on the pipe owner.
	default:
		return fmt.Errorf("ipc: resolve pipe server identity: %w", err)
	}
	return CheckServerIdentity(ev)
}

// pipeOwnerSID returns the owner SID of the pipe object behind handle, read
// with GetSecurityInfo. Needs only READ_CONTROL, which every IPC client
// holds (PipeClientAccessMask includes GENERIC_READ).
func pipeOwnerSID(handle windows.Handle) (string, error) {
	sd, err := windows.GetSecurityInfo(handle, windows.SE_KERNEL_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return "", fmt.Errorf("GetSecurityInfo: %w", err)
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return "", fmt.Errorf("security descriptor owner: %w", err)
	}
	if owner == nil {
		return "", fmt.Errorf("pipe has no owner")
	}
	return owner.String(), nil
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
