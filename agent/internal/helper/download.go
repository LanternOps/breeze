package helper

import (
	"github.com/breeze-rmm/agent/internal/secmem"
	"github.com/breeze-rmm/agent/internal/updater"
)

// defaultHelperDownloader returns the production verified-download function for
// the Breeze Helper package. It mirrors the agent's own self-updater and the
// user-helper companion download (issue #816): the returned func fetches the
// signed release manifest for component="helper" WITHOUT following redirects,
// verifies the Ed25519 manifest signature against the embedded trust root plus
// any pinned/env keys, enforces that the binary download host matches the
// configured control-plane ServerURL (blocking off-origin CDN redirects and
// HTTPS->HTTP downgrades), and verifies the downloaded bytes' SHA-256 against
// the signed manifest checksum. On success it returns the path to a verified
// temp file; the caller is responsible for removing it.
//
// This is the integrity gate that the old downloadFile (http.DefaultClient,
// which follows redirects, no checksum/signature) lacked — and is the reason a
// poisoned release asset, CDN edge, or TLS/DNS MITM toward github.com can no
// longer yield SYSTEM/root RCE via the helper install path.
func defaultHelperDownloader(serverURL string, authToken *secmem.SecureString, agentVersion string, manifestKeys []string) func(version string) (string, error) {
	return func(version string) (string, error) {
		cfg := &updater.Config{
			ServerURL:             serverURL,
			AuthToken:             authToken,
			CurrentVersion:        agentVersion,
			Component:             "helper",
			PinnedManifestPubKeys: manifestKeys,
		}
		return updater.New(cfg).DownloadBinary(version)
	}
}
