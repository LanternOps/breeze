//go:build !windows

package heartbeat

// registerSystemWinget is a no-op on non-Windows platforms; winget is a
// Windows-only package manager.
func (h *Heartbeat) registerSystemWinget() {}
