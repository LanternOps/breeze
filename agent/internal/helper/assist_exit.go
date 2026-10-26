package helper

import (
	"errors"
	"fmt"
	"strconv"
)

// Exit codes for Assist restarts (#10183). Assist is launched through the
// user-role helper or a cmd.exe wrapper, so the agent never holds the process
// handle a spawn would return. Instead it opens its own handle to every Assist
// instance it sees running in the session, right after each spawn and on the
// watcher's ticks, and reads the exit code from that handle when the watcher
// next finds Assist gone. Windows keeps a process's exit code readable while
// any handle to it stays open. Elsewhere probes are unsupported and the exit
// code is logged as unknown.

// assistExit is how one Assist process ended.
type assistExit struct {
	Code uint32
}

// exitProbe holds one running Assist process open so its exit code survives.
type exitProbe interface {
	// exitCode returns the process's exit code once it has exited.
	exitCode() (code uint32, exited bool, err error)
	close()
}

var errExitProbeUnsupported = errors.New("exit probes are not supported on this platform")

// openExitProbeFunc opens a probe on pid after confirming, on the same handle,
// that its image is binaryPath. Swappable for tests.
var openExitProbeFunc = openExitProbe

// exitCodeField formats an exit code for the log: decimal for ordinary codes,
// hex for NTSTATUS-style ones (0xC0000409 is a fail-fast abort), "unknown"
// when no exit was observed.
func exitCodeField(e assistExit, known bool) string {
	if !known {
		return "unknown"
	}
	if e.Code >= 0x80000000 {
		return fmt.Sprintf("0x%08X", e.Code)
	}
	return strconv.FormatUint(uint64(e.Code), 10)
}

// trackAssistExitsLocked keeps a probe on the session's running Assist. Probes
// whose process has already exited while another instance kept running (a
// reaped duplicate, a second launch handing over to the first) are dropped:
// that exit is not the session's Assist going away. A new enumeration runs only
// when no live probe remains, so the steady state costs nothing. Must be called
// with m.mu held.
func (m *Manager) trackAssistExitsLocked(state *sessionState) {
	live := 0
	for pid, p := range state.exitProbes {
		if _, exited, err := p.exitCode(); err != nil || exited {
			p.close()
			delete(state.exitProbes, pid)
			continue
		}
		live++
	}
	if live > 0 {
		return
	}
	for _, inst := range m.helperInstancesInSession(state.key) {
		if _, ok := state.exitProbes[inst.PID]; ok {
			continue
		}
		p, err := openExitProbeFunc(inst.PID, m.binaryPath)
		if err != nil {
			if !errors.Is(err, errExitProbeUnsupported) {
				log.Debug("could not watch breeze assist for its exit code", "session", state.key, "pid", inst.PID, "error", err.Error())
			}
			continue
		}
		if state.exitProbes == nil {
			state.exitProbes = make(map[int]exitProbe)
		}
		state.exitProbes[inst.PID] = p
	}
}

// takeAssistExitLocked returns the exit of a probed Assist that has ended and
// releases every probe whose process is gone. known is false when no probed
// process had exited (it was never seen running, or probes are unsupported).
// Must be called with m.mu held.
func (m *Manager) takeAssistExitLocked(state *sessionState) (assistExit, bool) {
	var out assistExit
	known := false
	for pid, p := range state.exitProbes {
		code, exited, err := p.exitCode()
		if err == nil && !exited {
			continue
		}
		if err == nil && !known {
			out, known = assistExit{Code: code}, true
		}
		p.close()
		delete(state.exitProbes, pid)
	}
	return out, known
}

// dropAssistExitProbesLocked releases every probe without reading it: the
// agent is about to stop Assist itself, and that exit is not a crash. Must be
// called with m.mu held.
func (m *Manager) dropAssistExitProbesLocked(state *sessionState) {
	for pid, p := range state.exitProbes {
		p.close()
		delete(state.exitProbes, pid)
	}
}
