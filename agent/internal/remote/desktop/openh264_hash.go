package desktop

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
)

// verifyFileSHA256 reports whether the file at path hashes to the given
// lowercase hex SHA-256 digest. It has no platform-specific dependencies (and
// so carries no build tag) so it can be exercised directly in tests: the
// OpenH264 candidate paths it backs (see encoder_openh264_dl_windows.go)
// previously trusted a file found on disk from os.Stat alone, with a
// SHA-256 check applied only to the auto-download path.
func verifyFileSHA256(path, expectedHexSHA256 string) (bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer func() { _ = f.Close() }()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return false, err
	}
	return hex.EncodeToString(h.Sum(nil)) == expectedHexSHA256, nil
}
