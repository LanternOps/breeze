//go:build windows

package userhelper

import (
	"os/exec"
	"syscall"
	"testing"

	"golang.org/x/sys/windows"
)

func TestHideWindow_SetsFlagsOnNilSysProcAttr(t *testing.T) {
	cmd := exec.Command("cmd.exe", "/c", "echo", "hello")
	if cmd.SysProcAttr != nil {
		t.Fatalf("precondition: SysProcAttr should be nil before hideWindow()")
	}

	hideWindow(cmd)

	if cmd.SysProcAttr == nil {
		t.Fatal("hideWindow did not allocate SysProcAttr")
	}
	if !cmd.SysProcAttr.HideWindow {
		t.Error("HideWindow flag not set")
	}
	if cmd.SysProcAttr.CreationFlags&windows.CREATE_NO_WINDOW == 0 {
		t.Errorf("CREATE_NO_WINDOW bit not set; CreationFlags=0x%x", cmd.SysProcAttr.CreationFlags)
	}
}

func TestHideWindow_PreservesExistingCreationFlags(t *testing.T) {
	cmd := exec.Command("cmd.exe", "/c", "echo", "hello")
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000200} // CREATE_NEW_PROCESS_GROUP

	hideWindow(cmd)

	if cmd.SysProcAttr.CreationFlags&0x00000200 == 0 {
		t.Error("hideWindow clobbered pre-existing CREATE_NEW_PROCESS_GROUP")
	}
	if cmd.SysProcAttr.CreationFlags&windows.CREATE_NO_WINDOW == 0 {
		t.Error("CREATE_NO_WINDOW not OR'd in alongside existing flag")
	}
}

func TestHideWindow_NilCmdDoesNotPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("hideWindow(nil) panicked: %v", r)
		}
	}()
	hideWindow(nil)
}
