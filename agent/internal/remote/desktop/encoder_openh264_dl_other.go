//go:build !windows

package desktop

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// findOpenH264Library searches for the OpenH264 shared library on non-Windows.
// Checks next to the executable and standard library paths.
func findOpenH264Library() (string, error) {
	var libName string
	switch runtime.GOOS {
	case "darwin":
		if runtime.GOARCH == "arm64" {
			libName = "libopenh264-2.4.1-mac-arm64.dylib"
		} else {
			libName = "libopenh264-2.4.1-mac-x64.dylib"
		}
	default: // linux
		if runtime.GOARCH == "arm64" {
			libName = "libopenh264-2.4.1-linux-arm64.7.so"
		} else {
			libName = "libopenh264-2.4.1-linux64.7.so"
		}
	}

	// Check next to executable
	if exePath, err := os.Executable(); err == nil {
		candidate := filepath.Join(filepath.Dir(exePath), libName)
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}

	// Check standard library paths
	for _, dir := range []string{"/usr/lib", "/usr/local/lib", "/usr/lib64"} {
		candidate := filepath.Join(dir, libName)
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}

	return "", fmt.Errorf("OpenH264 library %s not found (place next to agent binary or in /usr/lib)", libName)
}
