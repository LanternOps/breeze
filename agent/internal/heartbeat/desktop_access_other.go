//go:build !darwin && !linux

package heartbeat

import "github.com/breeze-rmm/agent/internal/collectors"

func (h *Heartbeat) computeDesktopAccess(_ *collectors.SystemInfo) *DesktopAccessState {
	return nil
}
