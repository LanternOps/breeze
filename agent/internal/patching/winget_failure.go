package patching

import "fmt"

// maxMachineScanFailureLen caps the reason sent to the server. Every reason is
// built from fixed text plus a hex exit code, so this is a backstop.
const maxMachineScanFailureLen = 160

// MachineScanReporter is implemented by providers that can say why their last
// machine-scope scan failed (#12835). The heartbeat puts the reason on the
// patch_scan command result so the device Patches tab can show "Third-party
// scan failed: <reason>" instead of an empty list.
type MachineScanReporter interface {
	// LastMachineScanFailure is a short reason, or "" when the last scan
	// succeeded (or none has run).
	LastMachineScanFailure() string
}

// knownWingetExitReasons maps exit codes seen when winget.exe cannot run at
// all to a readable cause. They are NTSTATUS values from the Windows loader,
// not winget's own APPINSTALLER_CLI_ERROR_* codes.
var knownWingetExitReasons = map[uint32]string{
	0xC0000135: "DLL not found; the Visual C++ runtime is missing",
	0xC0000142: "DLL initialization failed",
	0xC0000005: "access violation",
	0xC0000409: "stack buffer overrun",
}

// wingetExitReason renders a winget exit code. Compared as uint32 because the
// DWORD exit code can surface as 3221225781 or, narrowed through int32,
// -1073741515.
func wingetExitReason(code int) string {
	c := uint32(code)
	if why, ok := knownWingetExitReasons[c]; ok {
		return fmt.Sprintf("winget exited 0x%08X (%s)", c, why)
	}
	return fmt.Sprintf("winget exited 0x%08X", c)
}

// Machine-scan failure reasons. None of them carries winget's stdout/stderr or
// an error string: those can contain profile paths with user names, and the
// full detail is already in the agent log.
func machineScanStartFailure() string { return "winget could not be started" }

func machineScanUnreadable(code int) string {
	return fmt.Sprintf("winget output could not be read (exit 0x%08X)", uint32(code))
}

func capMachineScanFailure(s string) string {
	if len(s) > maxMachineScanFailureLen {
		return s[:maxMachineScanFailureLen]
	}
	return s
}

func (p *SystemWingetProvider) recordMachineScanFailure(reason string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.machineScanFailure = capMachineScanFailure(reason)
}

// LastMachineScanFailure reports why the most recent machine-scope scan
// failed, or "" when it succeeded.
func (p *SystemWingetProvider) LastMachineScanFailure() string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.machineScanFailure
}
