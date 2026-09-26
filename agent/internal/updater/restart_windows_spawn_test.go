//go:build windows

package updater

import (
	"syscall"
	"testing"

	"golang.org/x/sys/windows"
)

// #3624: the update/rollback helper is a console-subsystem powershell.exe. From
// the SYSTEM service it lands in session 0 and is invisible, but when the agent
// runs interactively (console mode, a manual `breeze-agent` run) a spawn without
// CREATE_NO_WINDOW pops a console on the desktop. It must stay in its own
// process group so it outlives the agent it is replacing.
func TestDetachedHelperSysProcAttrHidesWindow(t *testing.T) {
	attr := detachedHelperSysProcAttr()
	if attr == nil {
		t.Fatal("detachedHelperSysProcAttr returned nil")
	}
	if !attr.HideWindow {
		t.Error("HideWindow must be true")
	}
	if attr.CreationFlags&windows.CREATE_NO_WINDOW == 0 {
		t.Errorf("CreationFlags %#x lacks CREATE_NO_WINDOW", attr.CreationFlags)
	}
	if attr.CreationFlags&syscall.CREATE_NEW_PROCESS_GROUP == 0 {
		t.Errorf("CreationFlags %#x lacks CREATE_NEW_PROCESS_GROUP (helper must outlive the agent)", attr.CreationFlags)
	}
	if attr.CreationFlags&windows.DETACHED_PROCESS != 0 {
		t.Errorf("CreationFlags %#x sets DETACHED_PROCESS, which makes Windows ignore CREATE_NO_WINDOW", attr.CreationFlags)
	}
}
