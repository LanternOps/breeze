//go:build darwin && cgo

package userhelper

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// When Full Disk Access is already granted, the FDA guidance must be a no-op
// even if Screen Recording / Accessibility are still missing — those raise their
// own OS prompts and are auto-granted by the root daemon, so nagging for them
// here is exactly the behavior we removed. A no-op means no marker file is
// written and no osascript dialog is launched.
func TestHandleFullDiskAccessGuidance_NoOpWhenFDAGranted(t *testing.T) {
	dir := t.TempDir()
	promptFile := filepath.Join(dir, "tcc-prompted")

	status := &ipc.TCCStatus{
		ScreenRecording: false,
		Accessibility:   false,
		FullDiskAccess:  true,
	}

	handleFullDiskAccessGuidance(status, promptFile)

	if _, err := os.Stat(promptFile); !os.IsNotExist(err) {
		t.Fatalf("expected no marker file when FDA is granted, got err=%v", err)
	}
}
