package pam

import (
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/breeze-rmm/agent/internal/config"
)

// keyLen is the HMAC-SHA256 key length. We always generate exactly 32 bytes;
// loading a file of any other length is an error (treated as corruption).
const keyLen = 32

// ErrKeyCorrupt is returned by LoadOrCreateKey when the on-disk key file
// exists but is the wrong length. The caller should treat the cache as
// unusable (no valid key → MAC always mismatches) and either delete the key
// file + cache to re-create both, or alert. We do NOT auto-rotate, because
// silently rotating the key invalidates every existing cached envelope
// without any operator visibility.
var ErrKeyCorrupt = errors.New("pam: key file corrupt (wrong length)")

// DefaultKeyPath returns the platform default HMAC-key file path. Sits
// alongside DefaultPath under the agent data dir.
func DefaultKeyPath() string {
	return filepath.Join(config.GetDataDir(), "pam-rules.key")
}

// LoadOrCreateKey returns the HMAC key bytes used to sign the PAM cache
// envelope.
//
// On first call (file does not exist) it generates 32 bytes from crypto/rand,
// writes them atomically with 0600 perms (Unix) and SYSTEM+Administrators-only
// DACL (Windows, via applyCacheACL), and returns the bytes.
//
// On subsequent calls it reads the file and returns its contents. A file of
// any length other than keyLen (32) returns ErrKeyCorrupt — the caller must
// resolve operator-visibly (delete file → next call regenerates → existing
// cache envelope becomes ErrHMACMismatch and gets re-synced).
//
// The key never leaves the agent host. The server has no copy. That's the
// whole point: a per-host key means a leaked cache envelope from one machine
// can't be replayed onto another, and there's no key-distribution channel for
// an attacker to compromise.
func LoadOrCreateKey(keyPath string) ([]byte, error) {
	data, err := os.ReadFile(keyPath)
	if err == nil {
		if len(data) != keyLen {
			return nil, fmt.Errorf("%w: got %d bytes, want %d", ErrKeyCorrupt, len(data), keyLen)
		}
		return data, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("pam: read key file: %w", err)
	}

	// First-run path: generate + persist.
	buf := make([]byte, keyLen)
	if _, err := rand.Read(buf); err != nil {
		return nil, fmt.Errorf("pam: generate key: %w", err)
	}

	dir := filepath.Dir(keyPath)
	if err := os.MkdirAll(dir, 0750); err != nil {
		return nil, fmt.Errorf("pam: mkdir %s: %w", dir, err)
	}
	if err := atomicWriteFile(keyPath, buf, 0600); err != nil {
		return nil, fmt.Errorf("pam: write key file: %w", err)
	}
	if err := applyCacheACL(keyPath); err != nil {
		// Key bytes are already on disk; ACL failure on Windows leaves the
		// file at the parent dir's inherited ACL (typically SYSTEM+Admins
		// already via the data dir's DACL — see config/permissions_windows.go).
		// Surface the error so the caller can log it.
		return nil, fmt.Errorf("pam: apply key ACL (file written): %w", err)
	}
	return buf, nil
}
