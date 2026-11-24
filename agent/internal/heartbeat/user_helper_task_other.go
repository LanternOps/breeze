//go:build !windows

package heartbeat

// startUserHelperTaskRepair: only Windows has the user-helper logon task.
func (h *Heartbeat) startUserHelperTaskRepair() {}
