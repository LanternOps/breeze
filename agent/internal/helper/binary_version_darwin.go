//go:build darwin

package helper

import (
	"os"
	"path/filepath"
)

// readBinaryVersion returns CFBundleShortVersionString from the Info.plist of
// the .app bundle containing the helper binary
// (<bundle>/Contents/MacOS/breeze-helper -> <bundle>/Contents/Info.plist).
func readBinaryVersion(path string) (string, error) {
	plistPath := filepath.Join(filepath.Dir(filepath.Dir(path)), "Info.plist")
	data, err := os.ReadFile(plistPath)
	if err != nil {
		return "", err
	}
	return parsePlistShortVersion(data)
}
