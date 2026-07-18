package heartbeat

import (
	"image"
	"runtime"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdComputerAction] = handleComputerAction
}

func handleComputerAction(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	// Service/headless mode: route through IPC to user helper which has a display.
	// Linux is excluded: no IPC helper on Linux in Phase 1, so take the direct
	// path (ComputerActionWithCapture, whose capturer resolves the X display).
	if (h.isService || h.isHeadless) && h.sessionBroker != nil && runtime.GOOS != "linux" {
		return h.executeToolViaHelper(tools.CmdComputerAction, cmd.Payload, start)
	}

	// Direct mode: reuse active WebRTC session's capturer if available to avoid
	// conflicting with the shared global capture state (DXGI/ScreenCaptureKit).
	return tools.ComputerActionWithCapture(cmd.Payload, h.desktopCaptureFn())
}

// desktopCaptureFn returns a CaptureFunc that borrows the active WebRTC
// session's capturer, or nil if no desktop manager is available.
func (h *Heartbeat) desktopCaptureFn() tools.CaptureFunc {
	if h.desktopMgr == nil {
		return nil
	}
	return func(displayIndex int) (*image.RGBA, int, int, error) {
		return h.desktopMgr.CaptureScreenshot(displayIndex)
	}
}
