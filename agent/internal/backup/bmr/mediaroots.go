package bmr

import (
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
)

const fallbackRootsGODEBUG = "x509usefallbackroots=1"

// LoadMediaRoots makes the recovery media's own exported root store (the
// builder's roots.pem) the TLS trust anchor for every HTTPS client in this
// process: newHTTPClient, noAuthRedirectClient and the presigned S3
// downloads that ride on the latter. WinPE cannot reliably validate the
// server's chain through the Windows chain engine (the root store inside
// the boot image is minimal and not auto-updated), so the media ships the
// builder's roots and Go validates against those instead.
//
// An empty pemPath or a file that does not exist returns (0, nil) and
// touches nothing: the platform verifier and system roots stay in effect.
// The recovery console passes "" on Linux (media or not) and on a live
// Windows host — its Windows host sets the path, X:\breeze\roots.pem beside
// the executable, only when the process is running inside WinPE — so a
// stray roots.pem next to an installed breeze-backup.exe is never read. A
// WinPE media built without roots has no file and also returns (0, nil).
// Any other read failure, a PEM block of type CERTIFICATE that does not
// parse, or a file with zero certificates is an error: the caller fails
// closed. There is no fallback to unverified TLS anywhere.
//
// When certificates are loaded this first ensures x509usefallbackroots=1 is
// in effect (appended to any existing GODEBUG value, so the media launcher
// need not set it), then calls x509.SetFallbackRoots exactly once. With that
// setting Go uses the pool INSTEAD of the platform verifier for the whole
// process. That is intended on WinPE media only, which is why the caller
// gates the path on InWinPE rather than on the platform. x509.SetFallbackRoots
// panics if called twice, so call this at most once per process.
func LoadMediaRoots(pemPath string) (loaded int, err error) {
	if pemPath == "" {
		return 0, nil
	}
	data, err := os.ReadFile(pemPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return 0, nil
		}
		return 0, fmt.Errorf("read media roots %s: %w", pemPath, err)
	}

	pool := x509.NewCertPool()
	rest := data
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			break
		}
		if block.Type != "CERTIFICATE" {
			continue
		}
		cert, perr := x509.ParseCertificate(block.Bytes)
		if perr != nil {
			return 0, fmt.Errorf("parse media roots %s: certificate %d: %w", pemPath, loaded+1, perr)
		}
		pool.AddCert(cert)
		loaded++
	}
	if loaded == 0 {
		return 0, fmt.Errorf("media roots %s contain no certificates", pemPath)
	}

	if err := enableFallbackRootsGODEBUG(); err != nil {
		return 0, err
	}
	x509.SetFallbackRoots(pool)
	return loaded, nil
}

// enableFallbackRootsGODEBUG appends x509usefallbackroots=1 to GODEBUG. Go
// applies the last occurrence of a key, and os.Setenv("GODEBUG") is
// propagated to the runtime's godebug settings (Go 1.21+).
func enableFallbackRootsGODEBUG() error {
	cur := os.Getenv("GODEBUG")
	next := fallbackRootsGODEBUG
	if cur != "" {
		next = cur + "," + fallbackRootsGODEBUG
	}
	if err := os.Setenv("GODEBUG", next); err != nil {
		return fmt.Errorf("enable fallback roots: %w", err)
	}
	return nil
}
