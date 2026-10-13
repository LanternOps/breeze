package updater

import (
	"errors"
	"fmt"
)

// Typed download-failure sentinels. Callers that must decide whether a failure
// is permanent for the requested version (the watchdog install reconcile, which
// must never re-download a tampered or unverifiable artifact on a short timer)
// test these with errors.Is rather than matching message text. The message
// text of every wrapped error is unchanged, so existing log searches still
// match.
var (
	// ErrChecksumMismatch: the downloaded bytes do not match the SHA-256 (or
	// size) bound by the signed release manifest.
	ErrChecksumMismatch = errors.New("checksum mismatch")

	// ErrManifestSignature: the release manifest is missing, its signature is
	// malformed or does not verify, or the signed content does not describe the
	// requested artifact (version/component/platform/arch/checksum binding).
	ErrManifestSignature = errors.New("update manifest signature verification failed")

	// ErrManifestKey: the manifest names a malformed or unknown signing key,
	// a signing key id is required but absent, or the agent's own trust set is
	// unusable or empty.
	ErrManifestKey = errors.New("update manifest signing key rejected")
)

// trustError carries a fixed message plus a sentinel kind (and optionally the
// original cause), so wrapping a failure in a sentinel never changes its text.
type trustError struct {
	msg   string
	kind  error
	cause error
}

func (e *trustError) Error() string { return e.msg }

func (e *trustError) Unwrap() []error {
	if e.cause != nil {
		return []error{e.kind, e.cause}
	}
	return []error{e.kind}
}

// trustErrorf builds an error with the formatted message that also matches
// errors.Is(err, kind). The format must not use %w.
func trustErrorf(kind error, format string, args ...any) error {
	return &trustError{msg: fmt.Sprintf(format, args...), kind: kind}
}

// asTrustError tags err with kind, keeping its message and chain. nil stays nil;
// an error already tagged with kind is returned unchanged.
func asTrustError(kind, err error) error {
	if err == nil || errors.Is(err, kind) {
		return err
	}
	return &trustError{msg: err.Error(), kind: kind, cause: err}
}

// HTTPStatusError reports a non-200 response from the download-info request or
// the binary fetch. Code lets callers tell a server-side/transient failure
// (5xx, 429) from other statuses without parsing text.
type HTTPStatusError struct {
	Code int
	msg  string
}

func (e *HTTPStatusError) Error() string { return e.msg }

func httpStatusErrorf(code int, format string, args ...any) error {
	return &HTTPStatusError{Code: code, msg: fmt.Sprintf(format, args...)}
}

// VerifyStagedBinarySignature runs the same staged-binary code-signature gate
// replaceBinary applies (macOS `codesign --verify`; a no-op elsewhere). Callers
// that execute a downloaded artifact themselves, rather than installing it via
// UpdateTo, must call this first. A failure wraps ErrCodeSignatureInvalid.
func VerifyStagedBinarySignature(path string) error {
	return verifyStagedBinarySignature(path)
}
