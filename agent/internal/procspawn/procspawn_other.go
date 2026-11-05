//go:build !linux

package procspawn

import (
	"os"
	"os/exec"
)

// Placement is Linux-only: Windows scopes permits by executable and macOS
// cannot scope them by process at all.
func prepare(*exec.Cmd)        {}
func prepareAttr(*os.ProcAttr) {}

// EnableInAgentCgroup does nothing off Linux.
func EnableInAgentCgroup() error { return nil }
