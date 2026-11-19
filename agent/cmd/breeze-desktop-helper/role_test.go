package main

import (
	"runtime"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestDesktopHelperRole_LinuxIsUser(t *testing.T) {
	cases := map[string]ipc.HelperRole{
		"linux":   ipc.HelperRoleUser,
		"darwin":  ipc.HelperRoleUser,
		"windows": ipc.HelperRoleSystem,
	}
	for goos, want := range cases {
		if got := desktopHelperRoleFor(goos); got != want {
			t.Errorf("desktopHelperRoleFor(%s) = %q, want %q", goos, got, want)
		}
	}
	if got, want := desktopHelperRole(), desktopHelperRoleFor(runtime.GOOS); got != want {
		t.Errorf("desktopHelperRole() = %q, want %q", got, want)
	}
}
