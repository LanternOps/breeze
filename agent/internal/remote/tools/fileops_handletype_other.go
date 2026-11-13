//go:build !windows

package tools

import "os"

// requireDiskHandle: on these platforms the type of an opened file is checked
// from its stat information by each caller.
func requireDiskHandle(*os.File) error { return nil }
