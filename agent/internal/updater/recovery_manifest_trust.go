package updater

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
)

// ReleaseEnvelope is a signed release manifest exactly as the server serves it
// in download info ("manifest", "manifestSignature", "signingKeyId").
type ReleaseEnvelope struct {
	Manifest, Signature, SigningKeyID string
}

var errEnvelopeComponent = errors.New("release envelope fetch is only for the isolation-recovery component")

// VerifiedDownloadEnvelope returns the signed release manifest the server
// serves for this updater's isolation-recovery component at version. It makes
// the full download trust decision first (signature against the trust set,
// release version, the component's asset entry, edition and the served
// checksum), and returns nothing unless all of it passes. It never downloads
// the artifact.
//
// The isolation recovery installer persists the result beside the executable
// for trust Path B, which re-verifies it with VerifiedReleaseAssetSHA256 on
// every check; this method only decides what is worth writing.
func (u *Updater) VerifiedDownloadEnvelope(version string) (ReleaseEnvelope, error) {
	if u == nil || u.config == nil || u.component() != "isolation-recovery" {
		return ReleaseEnvelope{}, errEnvelopeComponent
	}
	info, _, err := u.verifiedDownloadInfo(version)
	if err != nil {
		return ReleaseEnvelope{}, fmt.Errorf("verify isolation-recovery download info: %w", err)
	}
	return ReleaseEnvelope{Manifest: info.Manifest, Signature: info.ManifestSignature, SigningKeyID: info.SigningKeyID}, nil
}

// VerifiedReleaseAssetSHA256 is the self-host recovery-binary trust anchor
// (network isolation W17). It makes the same decision the updater makes before
// it applies a download. The release manifest's Ed25519 signature must verify
// against this updater's trust set: the embedded root plus pinned deployment
// keys, honouring RequireManifestSigningKeyID. Only then is the manifest read.
// It returns the SHA-256 the signed manifest lists for assetName at exactly
// release version. Any other release, a missing entry, a disallowed edition or
// a malformed checksum is an error.
//
// manifest, signatureB64 and signingKeyID are the downloadInfo fields
// ("manifest", "manifestSignature", "signingKeyId") exactly as served, so a
// persisted copy is re-verified on every call, never trusted as stored.
func (u *Updater) VerifiedReleaseAssetSHA256(manifest, signatureB64, signingKeyID, version, assetName string) (string, error) {
	signature, err := base64.StdEncoding.DecodeString(signatureB64)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return "", trustErrorf(ErrManifestSignature, "invalid release manifest signature encoding")
	}
	payload := []byte(manifest)
	if err := u.verifyManifestSignature(payload, signature, signingKeyID); err != nil {
		return "", err
	}
	return releaseAssetChecksum(payload, version, assetName)
}
