//go:build !windows

package userhelper

import (
	"context"
	"errors"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func showPamDialog(req ipc.PamRequestDialog) ipc.PamDialogResult {
	return ipc.PamDialogResult{Approved: false, DismissedByUser: true}
}

// showSystemPromptOS: the SYSTEM helper renders prompts only on Windows (it
// advertises nothing elsewhere).
func showSystemPromptOS(context.Context, nativePromptModel, func()) nativeOutcome {
	return nativeOutcome{Err: errors.New("the SYSTEM helper renders prompts only on Windows")}
}
