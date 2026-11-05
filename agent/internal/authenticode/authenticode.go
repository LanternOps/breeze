// Package authenticode checks Windows Authenticode signatures on files the agent
// is about to run.
//
// VerifyChain answers "does this file carry a valid signature that chains to
// local trust". Verify also reports who signed it, so a caller can pin a
// publisher: a valid signature alone says nothing about whose it is.
//
// Revocation is NOT checked: the WinVerifyTrust flags disable it, so a revoked
// certificate that still chains to local trust passes. A vendor tool run must not
// hang on certificate infrastructure, and the SHA-256 pin covers downloads, but
// nothing here covers a revoked signer on a tool already on disk. A catalog-signed
// file carries no embedded signature and fails closed.
package authenticode

import (
	"crypto/sha256"
	"crypto/x509"
	"encoding/asn1"
	"encoding/hex"
	"errors"
	"fmt"
	"slices"
	"strings"
)

var oidCommonName = asn1.ObjectIdentifier{2, 5, 4, 3}

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

// signerFromDER names the signer of a DER certificate. It fails closed on
// anything a publisher pin could misread: a subject with no CN, more than one
// (which one is "the" publisher is then the reader's choice), or a NUL, which a
// C-string reader would truncate at.
func signerFromDER(der []byte) (Signer, error) {
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return Signer{}, fmt.Errorf("parse signer certificate: %w", err)
	}
	var names []string
	for _, attr := range cert.Subject.Names {
		if !attr.Type.Equal(oidCommonName) {
			continue
		}
		name, ok := attr.Value.(string)
		if !ok {
			return Signer{}, errors.New("signer certificate has a non-string common name")
		}
		names = append(names, name)
	}
	if len(names) != 1 {
		return Signer{}, fmt.Errorf("signer certificate has %d common names, want exactly 1", len(names))
	}
	if names[0] == "" {
		return Signer{}, errors.New("signer certificate has an empty common name")
	}
	if strings.ContainsRune(names[0], 0) {
		return Signer{}, errors.New("signer certificate common name contains a NUL")
	}
	return Signer{Subject: names[0], ThumbprintSHA256: thumbprintSHA256(der)}, nil
}

func thumbprintSHA256(der []byte) string {
	sum := sha256.Sum256(der)
	return hex.EncodeToString(sum[:])
}
