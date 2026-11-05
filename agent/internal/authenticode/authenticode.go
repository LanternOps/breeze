// Package authenticode checks Windows Authenticode signatures on files the agent
// is about to run.
//
// VerifyChain answers "does this file carry a valid signature that chains to
// local trust". Verify also reports who signed it, so a caller can pin a
// publisher: a valid signature alone says nothing about whose it is.
//
// Revocation is cache-only. A vendor tool run must not hang on certificate
// infrastructure, and the SHA-256 pin covers downloads. A catalog-signed file
// carries no embedded signature and fails closed here.
package authenticode

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"slices"
)

// ErrUnsupported is returned off Windows, where nothing can be verified. It is
// never a pass: callers treat it like any other verification failure.
var ErrUnsupported = errors.New("authenticode verification is only available on Windows")

// Signer identifies the leaf certificate of a verified signature.
type Signer struct {
	// Subject is the certificate's common name (CN).
	Subject string
	// ThumbprintSHA256 is the lowercase hex SHA-256 of the DER certificate.
	ThumbprintSHA256 string
}

// PublisherAllowed reports whether s was signed by one of the allowed
// publishers. The comparison is exact and case-sensitive on the CN, so "Dell
// Inc" does not match "Dell Inc." and a name that merely contains an allowed
// one does not match it either. An empty subject never matches.
func PublisherAllowed(s Signer, allowed []string) bool {
	return s.Subject != "" && slices.Contains(allowed, s.Subject)
}

func thumbprintSHA256(der []byte) string {
	sum := sha256.Sum256(der)
	return hex.EncodeToString(sum[:])
}
