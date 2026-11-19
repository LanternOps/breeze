package updater

import (
	"crypto/ed25519"
	"encoding/base64"
)

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
