//go:build windows

package sessionbroker

import (
	"fmt"
	"net"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

// SDDL: owner and group are explicitly SYSTEM, SYSTEM gets full control,
// Interactive Users get a narrow, explicit access mask instead of the GW
// (GENERIC_WRITE) generic right. IU (Interactive Users) restricts to users
// logged in interactively — excludes service accounts, batch jobs, and
// network logons.
//
// The access mask 0x0012019b for IU is FILE_READ_DATA | FILE_WRITE_DATA |
// FILE_READ_EA | FILE_WRITE_EA | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES
// | READ_CONTROL | SYNCHRONIZE — everything an interactive client needs to
// read and write pipe messages, but deliberately NOT FILE_APPEND_DATA (bit
// 0x4), DELETE, WRITE_DAC or WRITE_OWNER. On a named pipe, FILE_APPEND_DATA
// is reinterpreted by the kernel as FILE_CREATE_PIPE_INSTANCE — the right
// that lets a caller add an additional server instance to an EXISTING pipe
// name — and it is part of the FILE_GENERIC_WRITE mapping that GW expands
// to. Granting GW to Interactive Users therefore let any local interactive
// user add an extra server instance to this pipe while the real broker was
// already listening, not just claim the name before it started. This mask
// keeps message I/O working for IU while withholding that right; only
// SYSTEM (via GA) can create pipe instances.
const pipeSecurity = "O:SYG:SYD:P(A;;GA;;;SY)(A;;0x0012019b;;;IU)"

// pipeSecurityOverride replaces pipeSecurity for the duration of a Windows test
// binary. It exists because IU is exactly what makes these tests unrunnable
// anywhere automated: a CI runner service, a scheduled task, and an SSH session
// are all NON-interactive logons, so their tokens lack S-1-5-4 and the test
// process cannot dial the pipe it just created. Every TestNamedPipe* case has
// therefore been failing on real Windows — undetected, because no Windows CI job
// existed to run them.
//
// TEST-ONLY. It is deliberately an unexported var with no config, flag, or env
// binding: nothing outside a _test.go file may write it, so production always
// gets the IU-restricted descriptor above.
var pipeSecurityOverride string

func pipeSecurityDescriptor() string {
	if pipeSecurityOverride != "" {
		return pipeSecurityOverride
	}
	return pipeSecurity
}

func (b *Broker) setupSocket() (net.Listener, error) {
	cfg := &winio.PipeConfig{
		SecurityDescriptor: pipeSecurityDescriptor(),
		InputBufferSize:    64 * 1024,
		OutputBufferSize:   64 * 1024,
	}

	// go-winio's ListenPipe already gives the FIRST_PIPE_INSTANCE-equivalent
	// guarantee: internally it creates the listener's first server instance
	// with NtCreateNamedPipeFile's FILE_CREATE disposition (pipe.go
	// makeServerPipeHandle, first==true), which fails outright if a pipe of
	// this name already exists rather than silently attaching as an
	// additional instance. There is no separate flag to set here — the
	// restrictive DACL above is what closes the remaining gap (an
	// already-connected pipe accepting an additional server
	// instance), since FILE_CREATE only protects the very first instance.
	listener, err := winio.ListenPipe(b.socketPath, cfg)
	if err != nil {
		return nil, fmt.Errorf("listen pipe %s: %w", b.socketPath, err)
	}
	log.Info("named pipe listener created", "pipe", b.socketPath)
	return listener, nil
}

// peerWinSessionID returns the Windows session ID for the given process,
// verified by the kernel via ProcessIdToSessionId. Returns 0 on failure.
func peerWinSessionID(pid int) uint32 {
	if pid <= 0 {
		return 0
	}
	var sessionID uint32
	if err := windows.ProcessIdToSessionId(uint32(pid), &sessionID); err != nil {
		return 0
	}
	return sessionID
}
