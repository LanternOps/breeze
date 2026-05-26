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

// DefaultKeyPath returns the platform default HMAC-key file path.
//
// Threat model: the key lives under a sibling `keys/` subdir rather than
// alongside the cache file under GetDataDir() directly. This is defense in
// depth — if a future regression on the data dir's ACL ever loosens read
// access to local Users, the key still sits behind a separately ACL'd
// `keys/` directory (mode 0700 on Unix, SYSTEM+Administrators-only DACL on
// Windows applied by LoadOrCreateKey via applyCacheACL). An attacker who
// can read the cache envelope still can't recompute or forge its HMAC
// without also breaching the keys dir.
func DefaultKeyPath() string {
	return filepath.Join(config.GetDataDir(), "keys", "pam-rules.key")
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

	// Parent dir gets mode 0700 (Unix) — stricter than the 0750 used for the
	// data dir itself, because nothing other than the agent process (running
	// as root) should ever traverse the keys/ subdir.
	dir := filepath.Dir(keyPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("pam: mkdir %s: %w", dir, err)
	}
	// On Windows, also pin the parent dir's DACL to SYSTEM+Administrators
	// only. SDDL flags are identical to the file-level ACL (no inheritance,
	// no Users). File-level ACL alone would be sufficient for read
	// confidentiality of the key bytes, but pinning the dir too means an
	// attacker can't replace the file via a same-dir rename either.
	if err := applyCacheACL(dir); err != nil {
		return nil, fmt.Errorf("pam: apply key dir ACL: %w", err)
	}
	if err := atomicWriteFile(keyPath, buf, 0600); err != nil {
		return nil, fmt.Errorf("pam: write key file: %w", err)
	}
	if err := applyCacheACL(keyPath); err != nil {
		// Key bytes are already on disk; ACL failure on Windows leaves the
		// file at the parent dir's inherited ACL (which we just tightened
		// above to SYSTEM+Admins only). Surface the error so the caller can
		// log it.
		return nil, fmt.Errorf("pam: apply key ACL (file written): %w", err)
	}
	return buf, nil
}
