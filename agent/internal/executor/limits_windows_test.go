//go:build windows

package executor

import (
	"os/exec"
	"testing"

	"golang.org/x/sys/windows"
)

func TestHideWindow_SetsCreateNoWindow(t *testing.T) {
	cmd := exec.Command("cmd.exe", "/c", "echo", "ok")
	hideWindow(cmd)
	if cmd.SysProcAttr == nil {
		t.Fatal("SysProcAttr not allocated")
	}
	if !cmd.SysProcAttr.HideWindow {
		t.Error("HideWindow flag not set")
	}
	if cmd.SysProcAttr.CreationFlags&windows.CREATE_NO_WINDOW == 0 {
		t.Errorf("CREATE_NO_WINDOW not set; CreationFlags=0x%x", cmd.SysProcAttr.CreationFlags)
	}
}

func TestHideWindow_NilSafe(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("hideWindow(nil) panicked: %v", r)
		}
	}()
	hideWindow(nil)
}
