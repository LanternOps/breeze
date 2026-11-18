//go:build !linux

package wayland

import "os"

// RunHelper is the in-session capture process. It only runs on Linux.
func RunHelper() { os.Exit(1) }
