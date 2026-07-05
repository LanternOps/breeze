package patching

// RegisterSystemWinget registers a SystemWingetProvider on m iff res reports
// winget as available (per EnsureWinget), returning whether it registered.
// It is untagged (not windows-only) so the pure decision logic is unit
// tested on every host; the actual winget.exe invocation only ever happens
// when SystemWingetProvider methods run on a real Windows machine.
func RegisterSystemWinget(m *PatchManager, res EnsureResult, run cmdRunner) bool {
	if !res.Available {
		return false
	}
	m.RegisterProvider(NewSystemWingetProvider(res.WingetPath, run))
	return true
}
