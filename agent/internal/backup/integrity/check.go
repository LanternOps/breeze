package integrity

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

var (
	// ErrIntegrityMismatch: attested mode, and the bytes differ from their
	// attested size or SHA-256 (a control object or a manifest entry).
	ErrIntegrityMismatch = errors.New("backup integrity: object differs from its attestation")
	// ErrMissingChecksum: attested mode, and the manifest entry carries no
	// SHA-256 to check the object against.
	ErrMissingChecksum = errors.New("backup integrity: manifest entry has no checksum")
	// ErrSizeMismatch / ErrChecksumMismatch: without an attestation, the
	// bytes differ from the manifest entry (the checks restores always ran).
	ErrSizeMismatch     = errors.New("backup integrity: size differs from the manifest")
	ErrChecksumMismatch = errors.New("backup integrity: checksum differs from the manifest")
)

// Stored is what a manifest entry says about an object's stored bytes.
type Stored struct {
	Size     int64
	SHA256   string
	Volatile bool
}

// CheckResult is a passed check. Warning is non-empty when the bytes differ
// from a Volatile entry outside attested mode; SizeOnly when the entry had no
// checksum and only its size could be checked (outside attested mode).
type CheckResult struct {
	Warning  string
	SizeOnly bool
}

// CheckStoredBytes checks the file at staged against want.
//
// Attested mode: size and SHA-256 must both match, and an entry without a
// SHA-256 fails with ErrMissingChecksum. Volatile never waives the check: a
// Volatile entry's digest is the digest of the bytes its upload stored.
//
// Otherwise (no expectation, override or informational mode) the earlier
// rules apply unchanged: a Volatile mismatch is a warning, an entry without a
// checksum is checked by size only.
func CheckStoredBytes(staged string, want Stored, e *Expectation) (CheckResult, error) {
	info, err := os.Stat(staged)
	if err != nil {
		return CheckResult{}, fmt.Errorf("stat restored object: %w", err)
	}
	if e.Attested() {
		if want.SHA256 == "" {
			return CheckResult{}, ErrMissingChecksum
		}
		if info.Size() != want.Size {
			return CheckResult{}, fmt.Errorf("%w: size %d, attested manifest says %d", ErrIntegrityMismatch, info.Size(), want.Size)
		}
		got, err := fileSHA256(staged)
		if err != nil {
			return CheckResult{}, err
		}
		if !strings.EqualFold(got, want.SHA256) {
			return CheckResult{}, fmt.Errorf("%w: SHA-256 differs from the attested manifest", ErrIntegrityMismatch)
		}
		return CheckResult{}, nil
	}

	var res CheckResult
	if info.Size() != want.Size {
		if !want.Volatile {
			return CheckResult{}, fmt.Errorf("%w: manifest %d, restored %d", ErrSizeMismatch, want.Size, info.Size())
		}
		res.Warning = fmt.Sprintf("size differs from manifest (manifest %d, restored %d) — file was volatile during backup", want.Size, info.Size())
	}
	if want.SHA256 == "" {
		res.SizeOnly = true
		return res, nil
	}
	got, err := fileSHA256(staged)
	if err != nil {
		return CheckResult{}, err
	}
	if !strings.EqualFold(got, want.SHA256) {
		if !want.Volatile {
			return CheckResult{}, fmt.Errorf("%w (manifest %s)", ErrChecksumMismatch, want.SHA256)
		}
		if res.Warning == "" {
			res.Warning = fmt.Sprintf("checksum differs from manifest (manifest %s) — file was volatile during backup", want.SHA256)
		}
	}
	return res, nil
}

// Retryable reports whether err says the bytes a source returned differ from
// what they should be, so the same object read from another source (primary
// storage instead of a vault copy) may still pass.
func Retryable(err error) bool {
	return errors.Is(err, ErrIntegrityMismatch) || errors.Is(err, ErrChecksumMismatch) || errors.Is(err, ErrSizeMismatch)
}

// FailureCode is the stable result code for a failed check.
func FailureCode(err error) string {
	switch {
	case errors.Is(err, ErrMissingChecksum):
		return "missing_checksum"
	case errors.Is(err, ErrIntegrityMismatch):
		return "integrity_mismatch"
	case errors.Is(err, ErrChecksumMismatch):
		return "checksum_mismatch"
	case errors.Is(err, ErrSizeMismatch):
		return "size_mismatch"
	case errors.Is(err, ErrObjectNotAttested):
		return "not_attested"
	default:
		return ""
	}
}

// DigestBytes returns the lowercase-hex SHA-256 of b.
func DigestBytes(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// FileSHA256 returns the lowercase-hex SHA-256 of the file at p.
func FileSHA256(p string) (string, error) { return fileSHA256(p) }

func fileSHA256(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", fmt.Errorf("open restored object: %w", err)
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", fmt.Errorf("hash restored object: %w", err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
