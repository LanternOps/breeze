package patching

// RegisterSystemWinget registers a SystemWingetProvider on m iff res reports
// winget as available (per EnsureWinget), returning whether it registered.
// It is untagged (not windows-only) so the pure decision logic is unit
// tested on every host; the actual winget.exe invocation only ever happens
// when SystemWingetProvider methods run on a real Windows machine.
func RegisterSystemWinget(m *PatchManager, res EnsureResult, run cmdRunner) bool {
	return RegisterSystemWingetWithUserScan(m, res, run, nil)
}

// RegisterSystemWingetWithUserScan is RegisterSystemWinget plus the
// user-context scan pass: when userExec is non-nil the registered provider
// additionally enumerates per-user installs through the user helper (#2727).
// A nil userExec keeps the machine-scope-only behaviour.
//
// Note this still registers exactly ONE provider, ID "winget" — see
// SystemWingetProvider's doc comment for why the user pass must not be a
// second provider.
func RegisterSystemWingetWithUserScan(m *PatchManager, res EnsureResult, run cmdRunner, userExec UserExecFunc) bool {
	if !res.Available {
		return false
	}
	m.RegisterProvider(NewSystemWingetProviderWithUserScan(res.WingetPath, run, userExec))
	return true
}
