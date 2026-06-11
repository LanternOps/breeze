//go:build !windows

package userhelper

import "github.com/breeze-rmm/agent/internal/ipc"

func showPamDialog(req ipc.PamRequestDialog) ipc.PamDialogResult {
	return ipc.PamDialogResult{Approved: false, DismissedByUser: true}
}
