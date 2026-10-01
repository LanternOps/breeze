package config

// SetConfigDirForTest points ConfigDir (and every default path derived from
// it: agent.yaml, secrets.yaml) at dir, so a test can stand in for the
// installed agent's machine-wide config without touching the real one. The
// returned func restores the platform dir. Test use only.
func SetConfigDirForTest(dir string) (restore func()) {
	prev := configDirOverride.Swap(&dir)
	return func() { configDirOverride.Store(prev) }
}

// ResetUserWorkspaceForTest unregisters the process's user workspace (see
// SecureUserWorkspace), so a test that registered one does not confine the
// config writes of the tests that run after it. Test use only.
func ResetUserWorkspaceForTest() { resetUserWorkspaceForTest() }
