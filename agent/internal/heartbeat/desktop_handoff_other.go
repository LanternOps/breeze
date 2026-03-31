//go:build !darwin

package heartbeat

import "github.com/breeze-rmm/agent/internal/sessionbroker"

func (h *Heartbeat) startDarwinDesktopWatcher() {}

func (h *Heartbeat) handleHelperSessionClosed(_ *sessionbroker.Session) {}
