//go:build !windows && !darwin

package userhelper

import "github.com/breeze-rmm/agent/internal/ipc"

// showNotifyPromptOS has no interactive vehicle on this platform, so it reports
// "nothing was shown" and the caller falls back to the plain toast. That is the
// correct answer today rather than a gap: no helper binary ships for Linux at
// all, so nothing here would run in production either way. Linux gets its prompt
// from the daemon side in W4 (issue #3207, plan decision D7), not from a helper.
func showNotifyPromptOS(ipc.NotifyRequest) (clicked string, shown bool) {
	return "", false
}
