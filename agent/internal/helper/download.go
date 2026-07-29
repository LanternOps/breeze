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
// longer yield SYSTEM/root RCE via the helper install path. It also enforces
// the shared outbound network policy (agent/internal/netpolicy): dial-time
// address safety, HTTP_PROXY-blindness, and a bounded response size, on top
// of the control-plane origin check.
// serverURL is a provider (func() string), not a plain string, so the returned
// downloader re-resolves the control-plane base URL on every call and follows
// the heartbeat's backup-server-URL promotion (#2323) after a failover — rather
// than baking the (possibly dead) primary into the closure at construction
// (#2478). backupServerURL is the same kind of provider for the configured
// backup control plane; nil is treated as "no backup configured" rather than
// a caller bug, since not every Manager construction site is failover-aware.
// Both providers are resolved fresh inside the returned closure (which builds
// a new *updater.Updater per download) so BackupServerURL — a plain string on
// updater.Config, unlike ServerURL — never goes stale across a promotion.
func defaultHelperDownloader(serverURL, backupServerURL func() string, authToken *secmem.SecureString, agentVersion string, manifestKeys func() []string, requireSigningKeyID func() bool) func(version string) (string, error) {
	return func(version string) (string, error) {
		cfg := helperUpdaterConfig(serverURL, backupServerURL, authToken, agentVersion, manifestKeys, requireSigningKeyID)
		return updater.New(cfg).DownloadBinary(version)
	}
}

// helperUpdaterConfig builds the *updater.Config defaultHelperDownloader uses,
// split out so tests can assert the Component/ServerURL/BackupServerURL wiring
// directly (no network) instead of needing to observe an actual HTTP request —
// which, since the wave-06 network-policy hardening, is not something a test
// can do against a local httptest server at all (netpolicy rejects loopback
// destinations outright and unconditionally; see agent/internal/netpolicy).
func helperUpdaterConfig(serverURL, backupServerURL func() string, authToken *secmem.SecureString, agentVersion string, manifestKeys func() []string, requireSigningKeyID func() bool) *updater.Config {
	var backup string
	if backupServerURL != nil {
		backup = backupServerURL()
	}
	// The trust providers are resolved HERE, per download — not captured at
	// Manager construction. Once a delegated manifest signing key is activated
	// the server signs helper manifests with the new key ID, and a snapshot
	// taken at startup would verify against the superseded set until the agent
	// process restarted. Nil providers mean unset (no deployment-pinned keys /
	// compatibility mode), which is what a directly-constructed Manager in a
	// test has.
	var keys []string
	if manifestKeys != nil {
		keys = manifestKeys()
	}
	var requireKeyID bool
	if requireSigningKeyID != nil {
		requireKeyID = requireSigningKeyID()
	}
	return &updater.Config{
		ServerURL:                   serverURL,
		BackupServerURL:             backup,
		AuthToken:                   authToken,
		CurrentVersion:              agentVersion,
		Component:                   "helper",
		PinnedManifestPubKeys:       keys,
		RequireManifestSigningKeyID: requireKeyID,
	}
}
