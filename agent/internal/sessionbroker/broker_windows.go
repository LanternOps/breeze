//go:build windows

package sessionbroker

import (
	"fmt"
	"net"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

// SDDL: SYSTEM gets full control, Interactive Users get read/write.
// IU (Interactive Users) restricts to users logged in interactively —
// excludes service accounts, batch jobs, and network logons.
const pipeSecurity = "D:P(A;;GA;;;SY)(A;;GRGW;;;IU)"

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
