//go:build !windows

package tools

import "os"

// volumePathOfFile: volumes are anchored by their mount points here.
func volumePathOfFile(*os.File) (string, bool) { return "", false }
