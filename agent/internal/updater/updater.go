package updater

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/hostpolicy"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/netpolicy"
	"github.com/breeze-rmm/agent/internal/secmem"
)

var log = logging.L("updater")

// Config holds updater configuration
type Config struct {
	// ServerURL resolves the control-plane base URL. It is a provider
	// (func() string) rather than a plain string so that long-lived callers
	// re-resolve it on every download and follow the heartbeat's
	// backup-server-URL promotion (#2323) after a failover, instead of pinning
	// the (possibly dead) primary captured at construction. Making it a func —
	// rather than a plain string — is what makes the copied-string mistake
	// unrepresentable at the call sites (#2478, matching #2454/#2463/#2477).
	ServerURL      func() string
	AuthToken      *secmem.SecureString
	CurrentVersion string
	Component      string
	BinaryPath     string
	BackupPath     string

	// BackupServerURL is the configured backup control-plane URL, as a plain
	// string rather than a re-resolving provider (contrast ServerURL): each
	// construction site here builds a fresh Updater per download operation,
	// so a snapshot taken at New() time is never stale within that call. It
	// is passed to netpolicy alongside ServerURL() as a ControlPlaneOrigins
	// member — origin membership is what grants cleartext HTTP and private-
	// address reachability, and it is exact (scheme+host+port), so omitting
	// this field silently makes the backup control plane unreachable for
	// updater downloads even though heartbeat/failover treat it as a first-
	// class server.
	BackupServerURL string

	// PinnedManifestPubKeys are deployment-specific Ed25519 pubkeys delivered
	// by the API via enrollment/heartbeat and pinned TOFU-style. Format
	// matches agent config: "<keyId>:<base64-raw-pubkey>". Merged with the
	// embedded LanternOps trust root in manifestTrustKeys() so self-host
	// (BINARY_SOURCE=local) deployments can verify locally-signed manifests.
	PinnedManifestPubKeys []string

	// RequireManifestSigningKeyID mirrors the agent config field of the same
	// name: when true, a download response that omits signingKeyId fails
	// closed instead of falling back to verifying against the whole trusted
	// key set. Construction sites copy it from config.Config alongside
	// PinnedManifestPubKeys.
	RequireManifestSigningKeyID bool
}

// Updater handles agent auto-updates
type Updater struct {
	config *Config
	client *http.Client
	// clientErr is set when netpolicy.NewClient rejected the policy built
	// from config (e.g. a malformed configured server/backup URL). It is
	// surfaced lazily — at the first download attempt, via checkClient —
	// rather than changing New's signature to return an error, which every
	// one of the ten production construction sites would otherwise need to
	// handle. The failure mode is closed: client is nil whenever clientErr
	// is set, and every download entry point checks clientErr first.
	clientErr error
}

// New creates a new Updater. The returned client enforces netpolicy on every
// download this Updater performs — the control-plane metadata request AND
// the (possibly cross-origin, CDN-hosted) binary artifact fetch alike. See
// updaterPolicy for the exact policy shape.
func New(cfg *Config) *Updater {
	client, err := netpolicy.NewClient(updaterPolicy(cfg))
	if err != nil {
		// err is always a *netpolicy.PolicyError carrying a bounded reason
		// (e.g. a malformed configured server/backup URL) — safe to log
		// directly, unlike the *url.Error net/http produces at download
		// time, which repeats the full request URL.
		log.Error("updater network policy misconfigured; downloads will fail closed", "error", err.Error())
	}
	return &Updater{
		config:    cfg,
		client:    client,
		clientErr: err,
	}
}

// filterControlPlaneOrigins drops any control-plane origin outside the
// compiled allowlist from the ControlPlaneOrigins list passed to netpolicy.
// Identity (no filtering) in self-host AND in a gap build (allowlist
// compiled in, strict mode off) — existing-fleet agents on a gap build must
// keep functioning unchanged; only a strict build filters.
//
// What dropping an origin actually gates: ControlPlaneOrigins membership
// grants exactly two things at that origin — reachability to a private
// address, and (for ControlPlaneDownload) permission to use plain HTTP (see
// netpolicy.Policy.ControlPlaneOrigins). It does NOT, by itself, block an
// HTTPS request to a public host at that origin — netpolicy permits that
// regardless of ControlPlaneOrigins membership. So filtering a
// non-allowlisted control-plane origin here is not a guarantee that a
// strict build refuses to talk to it; it only withdraws the private-address
// and cleartext-HTTP grants for that origin.
//
// It filters ONLY the control-plane origin set passed to netpolicy, never
// the signed download target, which may legitimately be a cross-origin CDN
// URL (checksum + Ed25519 manifest-signature bound) — see updaterPolicy's
// doc comment below.
func filterControlPlaneOrigins(origins []string) []string {
	if !hostpolicy.Strict() {
		return origins
	}
	out := make([]string, 0, len(origins))
	for _, o := range origins {
		if o == "" {
			continue
		}
		if hostpolicy.AllowedURL(o) == nil {
			out = append(out, o)
		}
	}
	return out
}

// updaterPolicy builds the netpolicy.Policy that governs every network
// destination this Updater talks to. ControlPlaneOrigins carries BOTH the
// primary (cfg.ServerURL()) and the configured backup server URL, snapshotted
// once here — matching BackupServerURL's plain-string (non-reresolving)
// shape, since every construction site builds a fresh Updater per download
// rather than holding one across a failover promotion. Origin membership is
// what grants cleartext HTTP and private-address reachability for the
// ControlPlaneDownload purpose; omitting either origin silently makes that
// control plane's downloads fail with cleartext_not_allowed or
// private_address_not_allowed. Origins are then passed through
// filterControlPlaneOrigins, which is a no-op outside a strict hosted build.
func updaterPolicy(cfg *Config) netpolicy.Policy {
	var origins []string
	if cfg != nil {
		if cfg.ServerURL != nil {
			origins = append(origins, cfg.ServerURL())
		}
		origins = append(origins, cfg.BackupServerURL)
	}
	origins = filterControlPlaneOrigins(origins)
	return netpolicy.Policy{
		Purpose:             netpolicy.ControlPlaneDownload,
		ControlPlaneOrigins: origins,
		MaxRedirects:        10,
		RequestTimeout:      5 * time.Minute,
		MaxResponseBytes:    maxUpdateBinaryBytes,
	}
}

// checkClient fails closed when New's netpolicy client construction failed,
// or (defensively) when a directly-constructed Updater in a test never set
// client at all. Called at the top of every method that reaches u.client.
func (u *Updater) checkClient() error {
	if u.clientErr != nil {
		return fmt.Errorf("updater network client unavailable: %w", u.clientErr)
	}
	if u.client == nil {
		return fmt.Errorf("updater network client not initialized")
	}
	return nil
}

// PolicyRejectionReason extracts the bounded netpolicy.PolicyError reason
// from a download error, if the error chain contains one. Callers logging a
// download failure MUST use this instead of err.Error(): net/http wraps
// every client/transport error in *url.Error, whose message repeats the full
// request URL — including any capability query string — regardless of what
// error netpolicy itself returned.
func PolicyRejectionReason(err error) (string, bool) {
	var pe *netpolicy.PolicyError
	if errors.As(err, &pe) {
		return pe.Reason, true
	}
	return "", false
}

// SafeDownloadErrorFields returns the single structured log key/value pair a
// caller should attach when reporting a download failure — chosen so the
// value never contains a request URL:
//
//   - a *netpolicy.PolicyError anywhere in the chain: ("policyReason", the
//     bounded reason).
//   - a *url.Error: net/http wraps EVERY transport-level failure this way —
//     TLS handshake errors, connection refused/reset, timeouts, EOF, not just
//     policy rejections — and its Error() repeats the full request URL,
//     capability query string included, regardless of what the underlying
//     error is. Returns ("error", the underlying error's text only, with the
//     URL stripped).
//   - anything else (e.g. a checksum mismatch or manifest verification
//     failure, where no URL is embedded): ("error", err.Error()) unchanged.
//
// Every download-failure log line in this codebase should go through this
// (or PolicyRejectionReason directly, for a caller that wants to skip
// non-policy failures entirely) rather than hand-rolling the errors.As dance
// per call site — that duplication is exactly how a download path ends up on
// the unsafe err.Error() branch unnoticed.
func SafeDownloadErrorFields(err error) (key, value string) {
	if err == nil {
		return "error", ""
	}
	if reason, ok := PolicyRejectionReason(err); ok {
		return "policyReason", reason
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		// urlErr.Err is nil in principle (nothing in net/http's contract
		// forbids it, and a caller can construct one). This is an exported
		// helper on a failure path that runs inside goroutines, where a nil
		// dereference is a process crash, not a failed download — so fall back
		// to the operation name, which carries no URL.
		if urlErr.Err == nil {
			return "error", "url error during " + urlErr.Op
		}
		return "error", urlErr.Err.Error()
	}
	return "error", err.Error()
}

// SafeDownloadErrorMessage is SafeDownloadErrorFields collapsed into ONE
// redacted string, for the paths that ship a download failure OFF THE BOX (a
// command result POSTed to the control plane, or a log line at a shipped level)
// rather than into a structured local journal. Use SafeDownloadErrorFields
// where a key/value pair is what the sink wants.
//
// This exists because the previous pattern at those call sites was
// `errMsg = err.Error()`, which is exactly the unsafe branch: net/http wraps
// every transport failure in *url.Error, whose message repeats the full request
// URL — the presigned CDN URL, capability query string included, after a
// redirect.
func SafeDownloadErrorMessage(err error) string {
	key, value := SafeDownloadErrorFields(err)
	if key == "policyReason" {
		return "network policy rejected the download: " + value
	}
	return value
}

// serverURL resolves the control-plane base URL from the ServerURL provider.
// Nil-safe: a misconfigured Config (nil provider) yields "" rather than
// panicking, and the resulting request fails closed with an unparseable URL.
func (u *Updater) serverURL() string {
	if u.config == nil || u.config.ServerURL == nil {
		return ""
	}
	return u.config.ServerURL()
}

// ErrReadOnlyFS is returned when the binary path is on a read-only filesystem.
// Callers should treat this as a permanent failure and stop retrying.
var ErrReadOnlyFS = fmt.Errorf("binary path is on a read-only filesystem")

// ErrTextBusy is returned when the binary is currently executing (ETXTBSY).
// This is transient — the unlink-before-write in replaceBinary handles it,
// but this sentinel prevents misclassification as ErrReadOnlyFS.
var ErrTextBusy = fmt.Errorf("binary is currently executing")

// ErrUntrustedRelease is returned when the control plane refuses to serve
// download info for the requested version because the registered release is
// not trusted (HTTP 409). This is TERMINAL for the current target version:
// nothing on the device can fix it, and it stays broken until an operator
// re-registers the version with a signed manifest. Callers must back off
// rather than retry every heartbeat (issue #3544).
var ErrUntrustedRelease = fmt.Errorf("release is not trusted by the server")

// ErrCodeSignatureInvalid is returned on macOS when the binary staged for
// installation fails `codesign --verify`. It is TERMINAL for the current
// target version: the bytes are already checksum-verified against the signed
// release manifest, so a verification failure means the artifact itself is
// unsigned or its signature is broken, and no amount of retrying on the device
// will change that.
//
// The updater deliberately does NOT repair this by ad-hoc signing the binary
// (`codesign --force --sign -`). An ad-hoc signature has no stable identity —
// its designated requirement is the code-directory hash, which differs for
// every build — so ad-hoc signing a shipped build gives the agent a brand-new
// code identity on every update. macOS TCC grants (Screen Recording,
// Accessibility, Full Disk Access) are keyed to the previous identity, so they
// silently stop matching and the user is re-prompted after each update
// (issue #3458). Refusing the update and keeping the working, correctly signed
// binary is strictly better than installing one whose identity we just churned.
var ErrCodeSignatureInvalid = fmt.Errorf("binary failed macOS code signature verification")

// isCodeSignatureErr reports whether err came from the macOS signature gate in
// replaceBinary.
func isCodeSignatureErr(err error) bool {
	return errors.Is(err, ErrCodeSignatureInvalid)
}

// logCodeSignatureRejection records a refused update loudly. The gate runs
// before replaceBinary writes anything, so the installed binary is untouched
// and there is nothing to roll back — a Rollback() here would pointlessly
// rewrite the live, correctly signed binary. targetVersion is "" for the
// dev-push path, which has no version to name.
func logCodeSignatureRejection(targetVersion string, err error) {
	fields := []any{
		"error", err.Error(),
		"action", "update refused; keeping the currently installed binary",
	}
	if targetVersion != "" {
		fields = append(fields,
			"targetVersion", targetVersion,
			"remedy", "republish this version as a Developer ID signed, notarized macOS build")
	} else {
		fields = append(fields,
			"remedy", "sign the dev binary before pushing it (`make dev-push` signs darwin targets; set CODESIGN_IDENTITY to keep TCC grants across pushes)")
	}
	log.Error("staged binary failed macOS code signature verification — refusing to install it", fields...)
}

// downloadInfoError is the control plane's error body for a refused
// download-info request. `reason` is a machine-readable enum produced by
// validateReleaseManifest in apps/api/src/routes/agentVersions.ts (e.g.
// "signed_release_manifest_required", "invalid_release_manifest_signature").
// Only `reason` is consumed — `error` is human prose that may change freely.
type downloadInfoError struct {
	Reason string `json:"reason"`
}

// maxDownloadInfoErrorBodyBytes bounds how much of a non-2xx body we read
// before giving up on finding a reason. The real bodies are well under 200
// bytes; the cap keeps a hostile or misconfigured endpoint from streaming
// unbounded data into the agent just to produce a log line.
const maxDownloadInfoErrorBodyBytes = 4 << 10

// downloadInfoRejectionReason extracts the machine-readable `reason` from a
// refused download-info response.
//
// The value is deliberately sanitized rather than echoed verbatim: it lands in
// agent logs, and the surrounding code is careful never to let server-supplied
// text reach them unfiltered (see SafeDownloadErrorFields and the redirect
// branch of parseDownloadInfo). Reasons are a closed set of lowercase
// snake_case identifiers, so anything else is refused.
//
// The two failure modes are reported separately (`malformed`), because
// collapsing them is itself a silent failure — the exact class of bug this
// whole change exists to remove. If the API's reason vocabulary ever drifts
// outside the charset the agent accepts (a digit, a capital, over-length),
// returning a bare "" would make a REFUSED reason indistinguishable from a
// server that sent none, and the drift would be invisible in agent logs
// forever. The raw value is still never returned: naming the shape of the
// problem is enough to diagnose it without letting server text into logs.
func downloadInfoRejectionReason(body io.Reader) (reason string, malformed bool) {
	raw, err := io.ReadAll(io.LimitReader(body, maxDownloadInfoErrorBodyBytes))
	if err != nil {
		return "", false
	}
	// Reading exactly the cap means the body was cut off, so anything we
	// failed to parse below is inconclusive rather than absent — a reason may
	// well have been present and simply truncated mid-string. Folding that
	// into "server gave no reason" would be the same collapse this function
	// exists to avoid, reached through size instead of charset.
	truncated := len(raw) == maxDownloadInfoErrorBodyBytes

	var parsed downloadInfoError
	if err := json.Unmarshal(raw, &parsed); err != nil {
		// Otherwise the body is not the JSON error envelope at all (an empty
		// body, or an intermediary's HTML error page). Nothing was refused —
		// there was nothing to refuse.
		return "", truncated
	}
	if parsed.Reason == "" {
		return "", false
	}
	if len(parsed.Reason) > 64 {
		return "", true
	}
	for _, r := range parsed.Reason {
		if (r < 'a' || r > 'z') && r != '_' {
			return "", true
		}
	}
	return parsed.Reason, false
}

// maxUpdateBinaryBytes bounds both the netpolicy transport (Policy.
// MaxResponseBytes) and the explicit CopyBounded call in downloadFromURL. A
// var (not const), matching the trustedUpdateManifestPublicKeys pattern in
// this file, solely so tests can shrink it — serving/copying the real 500 MiB
// bound in a unit test is impractical. Production behavior is unchanged.
var maxUpdateBinaryBytes int64 = 500 * 1024 * 1024

// ManifestPublicKeys maps a manifest signing key ID to the raw Ed25519 public
// key it names. Trust is keyed, not a bag: verification looks up the ONE key
// whose ID the download response supplied and uses only that key.
type ManifestPublicKeys map[string]ed25519.PublicKey

// mustDecodeKey decodes a compile-time-constant base64 Ed25519 public key.
// Panicking is correct here: the only inputs are literals in this file, so a
// failure means the binary was built with a malformed trust root and must not
// run at all.
func mustDecodeKey(b64 string) ed25519.PublicKey {
	decoded, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || len(decoded) != ed25519.PublicKeySize {
		panic("updater: embedded manifest public key is not a base64 Ed25519 public key")
	}
	return ed25519.PublicKey(decoded)
}

// embeddedManifestPublicKeys is the embedded trust root for release manifest
// signatures. The value MUST match the raw Ed25519 public key in
// internal/release-keys/release-manifest.ed25519.pub (the SPKI suffix), and
// the ID MUST match the signingKeyId the API stamps onto GitHub-sourced
// download responses (apps/api/src/services/binarySync.ts); the release.yml
// workflow signs every manifest with the corresponding private key.
// TestEmbeddedTrustRootMatchesRepoPubKey enforces both halves at build time so
// the agent never ships with a mismatched trust root again.
//
// These entries are the LanternOps root and are NOT deployment-pinned keys:
// their presence never consumes a deployment's one TOFU bootstrap, and a
// pinned entry may not shadow one of these IDs (manifestTrustKeys rejects it).
//
// Self-hosters can add keys via the BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS env var
// (read in manifestTrustKeys), preferably in "<keyId>:<base64>" form so they
// participate in exact-ID verification.
var embeddedManifestPublicKeys = ManifestPublicKeys{
	"release-artifact-manifest-ed25519": mustDecodeKey("yzx8ftmcls6uBetFC5SYnZhBo+cbur3IX50TbBthTso="),
}

// missingSigningKeyIDWarned bounds the compatibility warning to once per
// process: the agent re-checks for updates on every heartbeat, so an unbounded
// warning would fill the log (and the shipped log stream) with one line per
// poll for every agent talking to a control plane that predates signingKeyId.
var missingSigningKeyIDWarned atomic.Bool

// missingSigningKeyIDWarner is the log seam for that warning, following the
// package-level *ForTests var pattern used elsewhere in the agent
// (config.atomicWriteFileForTests). Tests swap it for a counter and call
// resetMissingSigningKeyIDWarningForTests so warning-count assertions never
// inherit state from an earlier test in the same process.
var missingSigningKeyIDWarner = func() {
	log.Warn("update manifest response omitted signingKeyId; verifying against the full trusted key set. " +
		"Set require_manifest_signing_key_id: true once every control plane in the fleet supplies it")
}

func resetMissingSigningKeyIDWarningForTests() {
	missingSigningKeyIDWarned.Store(false)
}

func warnMissingSigningKeyIDOnce() {
	if missingSigningKeyIDWarned.CompareAndSwap(false, true) {
		missingSigningKeyIDWarner()
	}
}

// unusableTrustSetLogger is the log seam for the one condition in this file
// that stops the agent updating entirely: trust material that cannot be
// assembled (a malformed pinned entry, a malformed BREEZE_UPDATE_MANIFEST_
// PUBLIC_KEYS entry, or a key trying to occupy an embedded key's ID).
//
// Failing closed there is deliberate — a silently skipped entry is how a
// deployment loses its pin without noticing — but "no updates, ever" must not
// also be silent or unreadable. The line names the offending entry (position
// and, once validated, key ID; never key bytes) and states the remediation, so
// an operator can act on it without reading source.
var unusableTrustSetLogger = func(reason string) {
	log.Error("SECURITY: manifest trust set is unusable — this agent will not accept ANY update until it is fixed. "+
		"Remediation: re-enroll the agent (re-enrollment re-bootstraps pinned_manifest_pub_keys in agent.yaml), "+
		"or correct the offending entry by hand",
		"reason", reason)
}

// unusableTrustSetReason latches the last reason logged so a permanently
// broken config produces one line, not one per update check (the agent polls
// on every heartbeat). A different reason logs again, and recovery re-arms the
// latch so a recurrence is not swallowed.
var unusableTrustSetReason atomic.Pointer[string]

func resetUnusableTrustSetLogForTests() {
	unusableTrustSetReason.Store(nil)
}

func logUnusableTrustSet(reason string) {
	prev := unusableTrustSetReason.Load()
	if prev != nil && *prev == reason {
		return
	}
	if unusableTrustSetReason.CompareAndSwap(prev, &reason) {
		unusableTrustSetLogger(reason)
	}
}

type updateManifest struct {
	Version   string `json:"version"`
	Component string `json:"component"`
	Platform  string `json:"platform"`
	Arch      string `json:"arch"`
	URL       string `json:"url"`
	Checksum  string `json:"checksum"`
	Size      int64  `json:"size,omitempty"`
}

type releaseArtifactManifest struct {
	SchemaVersion int                    `json:"schemaVersion"`
	Release       string                 `json:"release"`
	Assets        []releaseArtifactAsset `json:"assets"`
}

type releaseArtifactAsset struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
	// Edition is optional and additive: "self-host" | "hosted" | "" (absent).
	// Absent means the manifest predates edition-stamping (or the running
	// agent is old enough not to look at this field at all) — either way it
	// is accepted unconditionally. See editionAllowed.
	Edition string `json:"edition,omitempty"`
}

func (u *Updater) component() string {
	if u.config != nil && strings.TrimSpace(u.config.Component) != "" {
		return strings.TrimSpace(u.config.Component)
	}
	return "agent"
}

func manifestPlatform() string {
	if runtime.GOOS == "darwin" {
		return "macos"
	}
	return runtime.GOOS
}

func releaseTagMatchesVersion(tag, version string) bool {
	return tag == version || tag == "v"+version
}

func assetNameFromURL(rawURL string) (string, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}
	parts := strings.Split(strings.TrimRight(parsed.Path, "/"), "/")
	if len(parts) == 0 || parts[len(parts)-1] == "" {
		return "", fmt.Errorf("download URL does not include an asset filename")
	}
	name, err := url.PathUnescape(parts[len(parts)-1])
	if err != nil {
		return "", err
	}
	return name, nil
}

func (u *Updater) expectedReleaseAssetNames() map[string]struct{} {
	switch u.component() {
	case "agent":
		suffix := ""
		if runtime.GOOS == "windows" {
			suffix = ".exe"
		}
		return map[string]struct{}{
			fmt.Sprintf("breeze-agent-%s-%s%s", runtime.GOOS, runtime.GOARCH, suffix): {},
		}
	case "helper":
		switch runtime.GOOS {
		case "windows":
			return map[string]struct{}{"breeze-helper-windows.msi": {}}
		case "darwin":
			return map[string]struct{}{"breeze-helper-macos.dmg": {}}
		case "linux":
			return map[string]struct{}{"breeze-helper-linux.AppImage": {}}
		}
	case "viewer":
		switch manifestPlatform() {
		case "windows":
			return map[string]struct{}{"breeze-viewer-windows.msi": {}}
		case "macos":
			return map[string]struct{}{"breeze-viewer-macos.dmg": {}}
		case "linux":
			return map[string]struct{}{"breeze-viewer-linux.AppImage": {}}
		}
	case "user-helper":
		// breeze-user-helper is the GUI-subsystem sibling of breeze-agent
		// that runs in interactive user sessions (sessionbroker spawn path).
		// It only exists on Windows — Linux/macOS user-session work is
		// handled by other surfaces. See agent/installer/build-msi.ps1
		// for how it's bundled into the installer; the in-place
		// auto-upgrade path (#816) downloads it as a separate artifact.
		if runtime.GOOS == "windows" {
			return map[string]struct{}{
				fmt.Sprintf("breeze-user-helper-%s-%s.exe", runtime.GOOS, runtime.GOARCH): {},
			}
		}
	case "watchdog":
		// breeze-watchdog is the supervisor sibling of breeze-agent, shipped
		// per-arch on every platform with the same asset-name shape as the
		// agent. Used by doUpdateWatchdog (the watchdog's failover self-update)
		// and by the agent's handleWatchdogUpgrade self-heal. Without this case the
		// GitHub multi-asset manifest verification fails ("no expected release
		// asset names configured for component watchdog"), which is why watchdog
		// auto-update never worked on the hosted (BINARY_SOURCE=github) path.
		suffix := ""
		if runtime.GOOS == "windows" {
			suffix = ".exe"
		}
		return map[string]struct{}{
			fmt.Sprintf("breeze-watchdog-%s-%s%s", runtime.GOOS, runtime.GOARCH, suffix): {},
		}
	case "backup":
		// breeze-backup is the on-demand backup helper spawned by sessionbroker
		// (internal/sessionbroker/backup.go) when backup commands arrive; it is
		// bundled by every platform installer and, since this change, auto-updated
		// the same way the agent and watchdog are.
		suffix := ""
		if runtime.GOOS == "windows" {
			suffix = ".exe"
		}
		return map[string]struct{}{
			fmt.Sprintf("breeze-backup-%s-%s%s", runtime.GOOS, runtime.GOARCH, suffix): {},
		}
	}
	return map[string]struct{}{}
}

// pkgAssetName is the canonical filename of the macOS .pkg installer asset for
// the running architecture. The .pkg is built and listed in the signed release
// manifest's asset list alongside the bare binary (release.yml).
func pkgAssetName() string {
	return fmt.Sprintf("breeze-agent-darwin-%s.pkg", runtime.GOARCH)
}

// pkgAssetChecksum extracts the signed SHA-256 of the macOS .pkg installer from
// an ALREADY-signature-verified release artifact manifest payload (the
// info.Manifest bytes that verifyUpdateManifest checked the Ed25519 signature
// over). It is the trust binding for the macOS update path: installViaPkg must
// verify the downloaded .pkg against this value before running `installer` as
// root.
//
// It deliberately FAILS CLOSED — returning an error when the manifest does not
// list the .pkg (e.g. legacy single-asset manifests, or releases predating the
// .pkg being added) — so the caller falls back to verified-binary replacement
// rather than installing bytes never bound to the signed trust root.
func pkgAssetChecksum(verifiedManifest []byte, version string) (string, error) {
	var manifest releaseArtifactManifest
	if err := json.Unmarshal(verifiedManifest, &manifest); err != nil {
		return "", fmt.Errorf("invalid release artifact manifest JSON: %w", err)
	}
	if manifest.SchemaVersion != 1 {
		return "", fmt.Errorf("unsupported release artifact manifest schema version %d", manifest.SchemaVersion)
	}
	if !releaseTagMatchesVersion(manifest.Release, version) {
		return "", fmt.Errorf("release artifact manifest version mismatch: expected %s, got %s", version, manifest.Release)
	}
	name := pkgAssetName()
	for i := range manifest.Assets {
		if manifest.Assets[i].Name != name {
			continue
		}
		if !editionAllowed(manifest.Assets[i].Edition) {
			return "", fmt.Errorf("update rejected: artifact edition %q does not match this build", manifest.Assets[i].Edition)
		}
		sha := manifest.Assets[i].SHA256
		if len(sha) != 64 {
			return "", fmt.Errorf("release artifact manifest checksum for %s must be SHA-256 hex", name)
		}
		if _, err := hex.DecodeString(sha); err != nil {
			return "", fmt.Errorf("release artifact manifest checksum for %s is not valid hex: %w", name, err)
		}
		return sha, nil
	}
	return "", fmt.Errorf("release artifact manifest does not include %s", name)
}

// manifestTrustKeys assembles this updater's trust material:
//
//   - keyed: keyId → public key, from the embedded root, from any
//     "<keyId>:<base64>" entries in BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS, and
//     from the deployment-pinned config entries. This is the ONLY material
//     consulted when the download response carries a signingKeyId.
//   - unkeyed: legacy bare-base64 env entries, which have no ID and are
//     therefore usable only on the missing-ID compatibility path.
//
// It fails closed rather than skipping bad material:
//
//   - a malformed pinned entry is an error, not a silent drop — dropping it
//     quietly demotes the deployment back to the embedded vendor root, which
//     is precisely the substitution this change forbids;
//   - a pinned or env key that tries to occupy an embedded key's ID with
//     different bytes is an error — a deployment must never be able to
//     substitute its own key for the LanternOps root by reusing its ID.
//
// Any such failure disables updates entirely, so it is reported through
// logUnusableTrustSet: one bounded, remediation-bearing line per distinct
// cause rather than silence or one line per heartbeat.
func (u *Updater) manifestTrustKeys() (ManifestPublicKeys, []ed25519.PublicKey, error) {
	keyed, unkeyed, err := u.assembleManifestTrustKeys()
	if err != nil {
		logUnusableTrustSet(err.Error())
		return nil, nil, err
	}
	// A usable trust set re-arms the latch, so a fault that recurs after a
	// re-enrollment is reported again rather than swallowed.
	unusableTrustSetReason.Store(nil)
	return keyed, unkeyed, nil
}

func (u *Updater) assembleManifestTrustKeys() (ManifestPublicKeys, []ed25519.PublicKey, error) {
	keyed := make(ManifestPublicKeys, len(embeddedManifestPublicKeys)+4)
	embeddedIDs := make(map[string]struct{}, len(embeddedManifestPublicKeys))
	for id, key := range embeddedManifestPublicKeys {
		keyed[id] = key
		embeddedIDs[id] = struct{}{}
	}

	// add installs one keyId → key binding, refusing to overwrite an embedded
	// entry (or to conflict with an equally-named key already added).
	add := func(id string, key ed25519.PublicKey, source string) error {
		if existing, ok := keyed[id]; ok {
			if existing.Equal(key) {
				return nil
			}
			if _, embedded := embeddedIDs[id]; embedded {
				return fmt.Errorf("%s manifest key may not replace the embedded trust root under keyId=%s", source, id)
			}
			return fmt.Errorf("conflicting %s manifest keys for keyId=%s", source, id)
		}
		keyed[id] = key
		return nil
	}

	var unkeyed []ed25519.PublicKey
	for i, raw := range strings.Split(os.Getenv("BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS"), ",") {
		pos := i + 1
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		// Base64 never contains ':', so a colon unambiguously marks the
		// keyed "<keyId>:<base64>" form. The bare form predates key IDs and
		// stays supported, but only for ID-less manifests — there is no ID an
		// ID-bound manifest could name it by.
		if id, b64, ok := strings.Cut(raw, ":"); ok {
			if !config.ValidManifestKeyID(id) {
				return nil, nil, fmt.Errorf("BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS entry #%d is malformed: key id is empty, too long, or contains characters outside [A-Za-z0-9._-]", pos)
			}
			key, err := decodeManifestPubKey(b64)
			if err != nil {
				return nil, nil, fmt.Errorf("BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS entry #%d (keyId=%s) is malformed: value is not a base64-encoded 32-byte Ed25519 public key", pos, id)
			}
			if err := add(id, key, "environment"); err != nil {
				return nil, nil, err
			}
			continue
		}
		key, err := decodeManifestPubKey(raw)
		if err != nil {
			return nil, nil, fmt.Errorf("BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS entry #%d is malformed: expected a base64-encoded 32-byte Ed25519 public key, or \"<keyId>:<base64>\"", pos)
		}
		unkeyed = append(unkeyed, key)
	}

	// Per-deployment pinned keys delivered by the API via enrollment/heartbeat
	// (see #625). Format on disk: "<keyId>:<base64-pubkey>".
	if u != nil && u.config != nil {
		pinned, err := config.ParsePinnedManifestKeys(u.config.PinnedManifestPubKeys)
		if err != nil {
			return nil, nil, fmt.Errorf("pinned manifest trust set is unusable: %w", err)
		}
		for id, b64 := range pinned {
			key, err := decodeManifestPubKey(b64)
			if err != nil {
				return nil, nil, fmt.Errorf("pinned manifest trust set is unusable: malformed key for keyId=%s", id)
			}
			if err := add(id, key, "pinned"); err != nil {
				return nil, nil, err
			}
		}
	}

	return keyed, unkeyed, nil
}

func decodeManifestPubKey(b64 string) (ed25519.PublicKey, error) {
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
	if err != nil {
		return nil, fmt.Errorf("manifest public key is not valid base64")
	}
	if len(decoded) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("manifest public key has wrong length")
	}
	return ed25519.PublicKey(decoded), nil
}

// requireSigningKeyID reports whether an ID-less manifest response must fail
// closed. Nil-safe so a directly-constructed Updater in a test behaves like
// the compatibility default.
func (u *Updater) requireSigningKeyID() bool {
	return u != nil && u.config != nil && u.config.RequireManifestSigningKeyID
}

// verifyManifestSignature is the trust decision for a release manifest.
//
// When signingKeyID is present it binds verification to that ONE key: the ID
// is validated, looked up in the keyed trust set, and the signature is checked
// against that key alone. A malformed ID, an unknown ID, or a signature made
// by any other key — including another key this agent legitimately trusts —
// fails closed. There is deliberately no fallback loop after an ID mismatch:
// trying the remaining keys is what made possession of ANY trusted key
// sufficient to sign an update for any agent (P1-UPD-001).
//
// When signingKeyID is absent, RequireManifestSigningKeyID decides: true fails
// closed, false verifies against the whole key set and emits one bounded
// warning per process.
func (u *Updater) verifyManifestSignature(payload, signature []byte, signingKeyID string) error {
	keyed, unkeyed, err := u.manifestTrustKeys()
	if err != nil {
		return err
	}

	if id := strings.TrimSpace(signingKeyID); id != "" {
		// Never echo an unvalidated ID: it is control-plane supplied and
		// reaches log lines through the caller's error reporting.
		if !config.ValidManifestKeyID(id) {
			return fmt.Errorf("update manifest signing key id is malformed")
		}
		key, ok := keyed[id]
		if !ok {
			return fmt.Errorf("unknown update manifest signing key id %q", id)
		}
		if !ed25519.Verify(key, payload, signature) {
			return fmt.Errorf("update manifest signature verification failed for signing key id %q", id)
		}
		return nil
	}

	if u.requireSigningKeyID() {
		return fmt.Errorf("manifest signing key ID required")
	}

	if len(keyed) == 0 && len(unkeyed) == 0 {
		return fmt.Errorf("no trusted update manifest public keys configured")
	}

	for _, key := range keyed {
		if ed25519.Verify(key, payload, signature) {
			// Warn only on ACCEPTANCE: the warning means "this agent took an
			// update whose manifest named no key". A response that fails
			// verification anyway must not consume the one-per-process budget
			// and hide a later, genuinely accepted ID-less manifest.
			warnMissingSigningKeyIDOnce()
			return nil
		}
	}
	for _, key := range unkeyed {
		if ed25519.Verify(key, payload, signature) {
			warnMissingSigningKeyIDOnce()
			return nil
		}
	}
	return fmt.Errorf("update manifest signature verification failed")
}

func normalizePreflightErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, ErrFileLocked) {
		return err
	}
	if errors.Is(err, ErrTextBusy) {
		return err
	}
	// Only classify known read-only indicators as permanent.
	// Transient errors (ENOMEM, EMFILE, EIO, etc.) should not
	// permanently disable auto-update.
	if errors.Is(err, syscall.EROFS) || errors.Is(err, syscall.EACCES) || errors.Is(err, syscall.EPERM) {
		return fmt.Errorf("%w: %v", ErrReadOnlyFS, err)
	}
	return err
}

// writeUpdateMarker creates a transient file that tells the new process
// to skip startup jitter and send an immediate heartbeat.
func writeUpdateMarker(version string) {
	markerPath := filepath.Join(config.ConfigDir(), ".update-restart")
	if err := os.WriteFile(markerPath, []byte(version), 0600); err != nil {
		log.Warn("failed to write update marker", "path", markerPath, "error", err.Error())
	}
}

// UpdateTo is a thin shim around UpdateToWithOptions for the common case of
// an agent-only upgrade. New code (and any caller that needs to thread a
// companion binary like breeze-user-helper.exe through the Windows restart
// helper) should call UpdateToWithOptions directly.
func (u *Updater) UpdateTo(version string) error {
	return u.UpdateToWithOptions(version, UpdateOptions{})
}

// UpdateToWithOptions downloads and installs a new version. When
// opts.UserHelper is non-nil and the host is Windows, the Windows restart
// helper script also swaps the user-helper binary alongside the agent.
// opts.Backup behaves the same way but applies on every platform (see
// UpdateOptions.Backup).
//
// Cleanup contract: on update failure (any error returned from this method),
// if opts.UserHelper != nil the user-helper temp file is removed, and likewise
// for opts.Backup. The agent caller pre-downloaded these to temp files before
// invoking this method; if the swap never happens, nothing else will ever
// clean them up. On success (this method returns nil) a companion's temp is
// intentionally left in place only where a LATER step still owns consuming
// it (the Windows restart script for both companions); the non-Windows Backup
// swap (swapCompanionBinary) consumes and removes its own temp inline, so
// there is nothing left for this method to clean up on that path.
//
// Issue #816 / #845 follow-up (PR B): replaces UpdateToWithUserHelper and the
// u.extras action-at-a-distance state with an explicit options parameter.
func (u *Updater) UpdateToWithOptions(version string, opts UpdateOptions) error {
	lease, ok := TryBeginProcessMutation("agent-update")
	if !ok {
		if opts.UserHelper != nil && opts.UserHelper.Temp != "" {
			removeCleanup(opts.UserHelper.Temp)
		}
		if opts.Backup != nil && opts.Backup.Temp != "" {
			removeCleanup(opts.Backup.Temp)
		}
		return ErrProcessMutationInProgress
	}
	defer lease.Release()
	err := u.updateTo(version, opts)
	if err != nil && opts.UserHelper != nil && opts.UserHelper.Temp != "" {
		// Cleanup contract: see method doc. Preserved verbatim from
		// PR A's UpdateToWithUserHelper error-path cleanup.
		removeCleanup(opts.UserHelper.Temp)
	}
	if err != nil && opts.Backup != nil && opts.Backup.Temp != "" {
		removeCleanup(opts.Backup.Temp)
	}
	return err
}

// updateTo is the unexported implementation shared by UpdateTo and
// UpdateToWithOptions. opts.UserHelper, when non-nil, is threaded through to
// RestartWithHelper on Windows.
func (u *Updater) updateTo(version string, opts UpdateOptions) error {
	log.Info("starting update", "targetVersion", version)

	// Pre-flight: verify we can write to the binary's directory.
	// ProtectSystem=strict in systemd or immutable filesystems (e.g. Ubuntu Core)
	// make /usr/local/bin read-only, so detect this early instead of failing
	// after download + checksum + backup.
	if runtime.GOOS != "windows" {
		if err := checkWritable(u.config.BinaryPath); err != nil {
			return normalizePreflightErr(err)
		}
	}

	// 1. Download binary to temp file
	tempPath, manifest, manifestPayload, err := u.downloadBinary(version)
	if err != nil {
		return fmt.Errorf("failed to download binary: %w", err)
	}

	// 2. Verify checksum
	if err := u.verifyChecksum(tempPath, manifest.Checksum); err != nil {
		removeCleanup(tempPath)
		return fmt.Errorf("checksum verification failed: %w", err)
	}

	// 3. Backup current binary
	if err := u.backupCurrentBinary(); err != nil {
		removeCleanup(tempPath)
		return fmt.Errorf("failed to backup current binary: %w", err)
	}

	// 4. On Windows, spawn a helper script that swaps the binary externally.
	//    The script handles: stop service -> copy new binary -> start service.
	//    The agent exits normally after spawning the script.
	if runtime.GOOS == "windows" {
		writeUpdateMarker(version)
		// User-helper and backup swaps are wired in by the heartbeat-layer
		// caller (heartbeat.doUpgrade), not here — the updater package is
		// component-agnostic, and downloading a second component requires
		// the caller's AuthToken/server context. Pass nil for an agent-only
		// swap (backward compatible). Issue #816 (user-helper); breeze-backup
		// follows the same pattern.
		if err := RestartWithHelper(BinaryPair{Temp: tempPath, Target: u.config.BinaryPath}, opts.UserHelper, opts.Backup); err != nil {
			removeCleanup(tempPath)
			// Defense in depth: UpdateToWithOptions also cleans the companion
			// temps on any returned error, but we mirror the agent tempPath
			// removal here too so the cleanup happens in the same branch as
			// the agent's, keeping the spawn-failure flow tidy. The
			// outer-layer cleanup is then a no-op for this case.
			if opts.UserHelper != nil && opts.UserHelper.Temp != "" {
				removeCleanup(opts.UserHelper.Temp)
			}
			if opts.Backup != nil && opts.Backup.Temp != "" {
				removeCleanup(opts.Backup.Temp)
			}
			if rbErr := u.Rollback(); rbErr != nil {
				log.Error("rollback also failed", "originalError", err, "rollbackError", rbErr)
			}
			return fmt.Errorf("failed to spawn update helper: %w", err)
		}
		// Helper script will handle the rest -- agent exits via service stop.
		return nil
	}

	// 5. macOS: download and install via .pkg if available.
	//    The .pkg preserves the Apple Developer ID code signature and runs
	//    pre/post-install scripts. The raw binary approach destroys the
	//    signature, which invalidates macOS TCC permission grants.
	//
	//    SECURITY: the .pkg is verified against the same Ed25519-signed release
	//    manifest as the binary before `installer` runs it as root. If the
	//    signed .pkg checksum is unavailable (legacy manifest, or the lookup
	//    fails), installViaPkg is skipped and we fall through to verified-binary
	//    replacement — we never run `installer` on bytes not bound to the trust
	//    root. (issue: macOS update RCE.)
	if runtime.GOOS == "darwin" {
		defer removeCleanup(tempPath)
		writeUpdateMarker(version)
		pkgChecksum, pkgErr := pkgAssetChecksum(manifestPayload, version)
		if pkgErr != nil {
			log.Warn("signed .pkg checksum unavailable, falling back to verified-binary replacement", "error", pkgErr.Error())
		} else if installErr := u.installViaPkg(version, pkgChecksum); installErr != nil {
			// installViaPkg downloads the signed .pkg (pkg_darwin.go), so this
			// error chain can be a *url.Error carrying the presigned asset URL.
			key, value := SafeDownloadErrorFields(installErr)
			log.Warn("pkg install failed, falling back to binary replacement", key, value)
		} else {
			// The .pkg already contains /usr/local/bin/breeze-backup — a
			// staged Backup pair must be discarded, not swapped, or we'd
			// stomp the binary the installer just placed. Only the raw-binary
			// fallback below (pkg unavailable or failed) needs the explicit
			// swap.
			if opts.Backup != nil {
				removeCleanup(opts.Backup.Temp)
			}
			return nil // .pkg install handles binary replacement + restart
		}
	} else {
		defer removeCleanup(tempPath)
	}

	// 6. Non-macOS or pkg fallback: replace binary inline and restart
	if err := u.replaceBinary(tempPath); err != nil {
		if isCodeSignatureErr(err) {
			logCodeSignatureRejection(version, err)
			return err
		}
		// Catch TOCTOU race: pre-flight passed but FS became read-only before write
		if isReadOnlyErr(err) {
			return fmt.Errorf("%w: %v", ErrReadOnlyFS, err)
		}
		if rbErr := u.Rollback(); rbErr != nil {
			log.Error("rollback also failed after replace error", "replaceError", err, "rollbackError", rbErr)
			return fmt.Errorf("failed to replace binary: %w (rollback also failed: %v)", err, rbErr)
		}
		return fmt.Errorf("failed to replace binary (rolled back): %w", err)
	}

	// Swap the pre-fetched breeze-backup binary (if any) into place BEFORE
	// restarting the agent — this is the Linux / macOS-pkg-fallback half of
	// the delivery contract (Windows swaps inside the restart-helper script
	// above; the macOS .pkg success path already returned above). A swap
	// failure here is logged and left for the next heartbeat's
	// reconcileBackupHelper to retry rather than aborting an agent upgrade
	// that has already fully replaced the (already-live) agent binary —
	// unlike doUpgrade's pre-flight abort, backing out at this point would
	// mean un-replacing an agent binary the OS may already be executing.
	if opts.Backup != nil {
		if err := swapCompanionBinary(opts.Backup); err != nil {
			log.Error("failed to swap breeze-backup binary during agent upgrade; will retry via reconcile", "error", err.Error())
			removeCleanup(opts.Backup.Temp)
		}
	}

	writeUpdateMarker(version)
	if err := Restart(); err != nil {
		if rbErr := u.Rollback(); rbErr != nil {
			log.Error("rollback also failed after restart error", "restartError", err, "rollbackError", rbErr)
			return fmt.Errorf("failed to restart: %w (rollback also failed: %v)", err, rbErr)
		}
		return fmt.Errorf("failed to restart (rolled back): %w", err)
	}

	return nil
}

// downloadInfo holds the JSON response from the download endpoint.
//
// SigningKeyID names the ONE key the manifest signature must verify against
// (see verifyManifestSignature). It is empty for control planes that predate
// the field and for locally-sourced binaries; RequireManifestSigningKeyID
// decides whether that is tolerated.
type downloadInfo struct {
	URL               string `json:"url"`
	Checksum          string `json:"checksum"`
	Manifest          string `json:"manifest"`
	ManifestSignature string `json:"manifestSignature"`
	SigningKeyID      string `json:"signingKeyId"`
}

func (u *Updater) requestWithoutRedirect(req *http.Request) (*http.Response, error) {
	client := *u.client
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return client.Do(req)
}

func (u *Updater) parseDownloadInfo(resp *http.Response) (downloadInfo, error) {
	switch resp.StatusCode {
	case http.StatusOK:
		var info downloadInfo
		if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
			return downloadInfo{}, fmt.Errorf("failed to parse download info: %w", err)
		}
		if info.URL == "" || info.Checksum == "" {
			return downloadInfo{}, fmt.Errorf("download info missing url or checksum")
		}
		if info.Manifest == "" || info.ManifestSignature == "" {
			return downloadInfo{}, fmt.Errorf("download info missing signed release manifest")
		}
		return info, nil

	case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther, http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
		if _, err := resp.Location(); err != nil {
			return downloadInfo{}, fmt.Errorf("download redirect missing location: %w", err)
		}
		// Deliberately does NOT embed the redirect Location in the error: this
		// message reaches callers' download-failure logs verbatim (it is a
		// plain error, not a *netpolicy.PolicyError or *url.Error, so
		// SafeDownloadErrorFields's stripping does not apply to it), and the
		// target may carry a capability query string.
		return downloadInfo{}, fmt.Errorf("download redirects are not trusted without a signed release manifest")

	case http.StatusConflict:
		// The server registered this version but refuses to serve it: the
		// release manifest is missing or does not verify. Before #3544 this
		// fell through to the bare status-code message below, so the agent
		// logged "download info request failed with status 409" every ~60s
		// forever while the body's specific, actionable `reason` was thrown
		// away. Surface the reason and mark the failure terminal so callers
		// can back off.
		reason, malformed := downloadInfoRejectionReason(resp.Body)
		switch {
		case reason != "":
			return downloadInfo{}, fmt.Errorf("%w: %s", ErrUntrustedRelease, reason)
		case malformed:
			// The server DID send a reason, but not one this agent will put in
			// a log. Say so explicitly: silently reporting "no reason" would
			// hide a server/agent vocabulary drift indefinitely.
			return downloadInfo{}, fmt.Errorf("%w: server sent an unrecognized reason code (refused as unsafe to log)", ErrUntrustedRelease)
		default:
			return downloadInfo{}, fmt.Errorf("%w: server gave no reason", ErrUntrustedRelease)
		}

	default:
		return downloadInfo{}, fmt.Errorf("download info request failed with status %d", resp.StatusCode)
	}
}

func (u *Updater) verifyUpdateManifest(info downloadInfo, version string) (updateManifest, error) {
	signature, err := base64.StdEncoding.DecodeString(info.ManifestSignature)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return updateManifest{}, fmt.Errorf("invalid update manifest signature encoding")
	}

	payload := []byte(info.Manifest)
	if err := u.verifyManifestSignature(payload, signature, info.SigningKeyID); err != nil {
		return updateManifest{}, err
	}

	var manifest updateManifest
	if err := json.Unmarshal(payload, &manifest); err != nil {
		return updateManifest{}, fmt.Errorf("invalid update manifest JSON: %w", err)
	}
	if manifest.Version == "" && manifest.Checksum == "" {
		return u.verifyReleaseArtifactManifest(payload, info, version)
	}

	if manifest.Version != version {
		return updateManifest{}, fmt.Errorf("update manifest version mismatch: expected %s, got %s", version, manifest.Version)
	}
	if manifest.Component != u.component() {
		return updateManifest{}, fmt.Errorf("update manifest component mismatch: expected %s, got %s", u.component(), manifest.Component)
	}
	if manifest.Platform != manifestPlatform() {
		return updateManifest{}, fmt.Errorf("update manifest platform mismatch: expected %s, got %s", manifestPlatform(), manifest.Platform)
	}
	if manifest.Arch != runtime.GOARCH {
		return updateManifest{}, fmt.Errorf("update manifest architecture mismatch: expected %s, got %s", runtime.GOARCH, manifest.Arch)
	}
	// The checksum equality below is the trust binding — it ties the
	// signed manifest to the bytes the server is offering. We deliberately
	// do NOT require manifest.URL == info.URL: the signed URL is canonical
	// (e.g. github.com release artifact) while info.URL may be a server-
	// relative proxy URL the API uses to keep the download flow inside the
	// agent's trusted origin (see downloadFromURL host check). Issue #646.
	if manifest.Checksum != info.Checksum {
		return updateManifest{}, fmt.Errorf("update manifest does not match download metadata")
	}
	if len(manifest.Checksum) != 64 {
		return updateManifest{}, fmt.Errorf("update manifest checksum must be SHA-256 hex")
	}
	if _, err := hex.DecodeString(manifest.Checksum); err != nil {
		return updateManifest{}, fmt.Errorf("update manifest checksum is not valid hex: %w", err)
	}
	if manifest.Size < 0 || manifest.Size > maxUpdateBinaryBytes {
		return updateManifest{}, fmt.Errorf("update manifest size %d exceeds allowed bounds", manifest.Size)
	}

	return manifest, nil
}

func (u *Updater) verifyReleaseArtifactManifest(payload []byte, info downloadInfo, version string) (updateManifest, error) {
	var manifest releaseArtifactManifest
	if err := json.Unmarshal(payload, &manifest); err != nil {
		return updateManifest{}, fmt.Errorf("invalid release artifact manifest JSON: %w", err)
	}
	if manifest.SchemaVersion != 1 {
		return updateManifest{}, fmt.Errorf("unsupported release artifact manifest schema version %d", manifest.SchemaVersion)
	}
	if !releaseTagMatchesVersion(manifest.Release, version) {
		return updateManifest{}, fmt.Errorf("release artifact manifest version mismatch: expected %s, got %s", version, manifest.Release)
	}

	// Asset name is derived from the agent's own platform/arch/component
	// rather than parsed from info.URL — the URL may be a server-relative
	// proxy (e.g. https://breeze.example.com/api/v1/agents/download/...)
	// whose last segment is not the asset filename. The signed manifest's
	// asset list still uses canonical names like "breeze-agent-windows-amd64.exe".
	// Issue #646.
	expected := u.expectedReleaseAssetNames()
	if len(expected) == 0 {
		return updateManifest{}, fmt.Errorf("no expected release asset names configured for component %q", u.component())
	}
	if len(expected) != 1 {
		// Defensive: expectedReleaseAssetNames always returns exactly one
		// entry per (platform, arch, component) tuple. Surface this clearly
		// if a future change adds ambiguity rather than silently picking one.
		return updateManifest{}, fmt.Errorf("ambiguous expected asset names for component %q: %v", u.component(), expected)
	}
	var assetName string
	for name := range expected {
		assetName = name
	}

	var selected *releaseArtifactAsset
	for i := range manifest.Assets {
		if manifest.Assets[i].Name == assetName {
			selected = &manifest.Assets[i]
			break
		}
	}
	if selected == nil {
		return updateManifest{}, fmt.Errorf("release artifact manifest does not include %s", assetName)
	}
	if !editionAllowed(selected.Edition) {
		return updateManifest{}, fmt.Errorf("update rejected: artifact edition %q does not match this build", selected.Edition)
	}
	if len(selected.SHA256) != 64 {
		return updateManifest{}, fmt.Errorf("release artifact manifest checksum must be SHA-256 hex")
	}
	if _, err := hex.DecodeString(selected.SHA256); err != nil {
		return updateManifest{}, fmt.Errorf("release artifact manifest checksum is not valid hex: %w", err)
	}
	if selected.SHA256 != info.Checksum {
		return updateManifest{}, fmt.Errorf("release artifact manifest does not match download metadata")
	}
	if selected.Size < 0 || selected.Size > maxUpdateBinaryBytes {
		return updateManifest{}, fmt.Errorf("release artifact manifest size %d exceeds allowed bounds", selected.Size)
	}

	return updateManifest{
		Version:   version,
		Component: u.component(),
		Platform:  manifestPlatform(),
		Arch:      runtime.GOARCH,
		URL:       info.URL,
		Checksum:  selected.SHA256,
		Size:      selected.Size,
	}, nil
}

// DownloadBinary is the exported wrapper around downloadBinary used by
// callers that need to pre-download a companion artifact (e.g. the
// breeze-user-helper.exe) outside the full UpdateTo flow. Returns the
// temp-file path on success after verifying the downloaded bytes against
// the signed manifest checksum. The caller is responsible for cleanup.
// Issue #816.
//
// Note on the second verifyChecksum: internal downloadBinary verifies the
// signed MANIFEST (the JSON payload's Ed25519 signature) but does NOT
// verify the downloaded FILE bytes against manifest.Checksum — that
// file-checksum verification is done by callers of downloadBinary
// (e.g. UpdateTo does its own verify post-write). DownloadBinary, as an
// exported method, performs the file-checksum verification HERE so
// exported callers get a verified file without having to know about the
// manifest-vs-file distinction. The second verify is intentional and a
// future simplifier should not delete it as "redundant".
func (u *Updater) DownloadBinary(version string) (string, error) {
	tempPath, manifest, _, err := u.downloadBinary(version)
	if err != nil {
		return "", err
	}
	if err := u.verifyChecksum(tempPath, manifest.Checksum); err != nil {
		removeCleanup(tempPath)
		return "", fmt.Errorf("checksum verification failed: %w", err)
	}
	return tempPath, nil
}

// StageRollbackArtifacts verifies and downloads the complete component set
// before any caller is allowed to cross a live-binary swap boundary.
func (u *Updater) StageRollbackArtifacts(request RollbackStageRequest) (StagedRollbackSet, error) {
	result := StagedRollbackSet{DirectiveID: request.DirectiveID}
	fail := func(err error) (StagedRollbackSet, error) {
		result.Cleanup()
		return StagedRollbackSet{}, err
	}
	if u == nil || u.config == nil {
		return fail(fmt.Errorf("updater configuration is required"))
	}
	if strings.TrimSpace(request.DirectiveID) == "" {
		return fail(fmt.Errorf("rollback directive id is required"))
	}
	if request.Platform != manifestPlatform() {
		return fail(fmt.Errorf("rollback platform mismatch: expected %s, got %s", manifestPlatform(), request.Platform))
	}
	if request.Architecture != runtime.GOARCH {
		return fail(fmt.Errorf("rollback architecture mismatch: expected %s, got %s", runtime.GOARCH, request.Architecture))
	}
	if strings.TrimSpace(request.CurrentVersion) == "" || strings.TrimSpace(request.TargetVersion) == "" {
		return fail(fmt.Errorf("rollback current and target versions are required"))
	}
	if len(request.Artifacts) == 0 || len(request.Artifacts) != len(request.ComponentVersions) {
		return fail(fmt.Errorf("rollback artifact set does not match component versions"))
	}
	agentVersions, ok := request.ComponentVersions[RollbackComponentAgent]
	if !ok || agentVersions.Current != request.CurrentVersion || agentVersions.Target != request.TargetVersion {
		return fail(fmt.Errorf("rollback agent version binding mismatch"))
	}

	seen := make(map[RollbackComponent]struct{}, len(request.Artifacts))
	for _, artifact := range request.Artifacts {
		versions, ok := request.ComponentVersions[artifact.Component]
		if !ok || versions.Current != artifact.CurrentVersion || versions.Target != artifact.TargetVersion || artifact.TargetVersion != request.TargetVersion {
			return fail(fmt.Errorf("rollback artifact version binding mismatch for %s", artifact.Component))
		}
		if _, duplicate := seen[artifact.Component]; duplicate {
			return fail(fmt.Errorf("duplicate rollback artifact component %s", artifact.Component))
		}
		seen[artifact.Component] = struct{}{}
		if artifact.DownloadURL == "" || artifact.Size <= 0 || artifact.Size > maxUpdateBinaryBytes {
			return fail(fmt.Errorf("invalid rollback artifact metadata for %s", artifact.Component))
		}
		if len(artifact.SHA256) != 64 {
			return fail(fmt.Errorf("invalid rollback artifact checksum for %s", artifact.Component))
		}
		if _, err := hex.DecodeString(artifact.SHA256); err != nil {
			return fail(fmt.Errorf("invalid rollback artifact checksum for %s: %w", artifact.Component, err))
		}

		cfg := *u.config
		cfg.Component = string(artifact.Component)
		componentUpdater := &Updater{config: &cfg, client: u.client, clientErr: u.clientErr}
		info := downloadInfo{
			URL: artifact.DownloadURL, Checksum: strings.ToLower(artifact.SHA256),
			Manifest: request.ReleaseManifest, ManifestSignature: request.ManifestSignature,
			SigningKeyID: request.ManifestSigningKeyID,
		}
		manifest, err := componentUpdater.verifyUpdateManifest(info, request.TargetVersion)
		if err != nil {
			return fail(fmt.Errorf("verify rollback artifact %s: %w", artifact.Component, err))
		}
		if manifest.Checksum != strings.ToLower(artifact.SHA256) || manifest.Size != artifact.Size || manifest.Component != string(artifact.Component) {
			return fail(fmt.Errorf("signed manifest does not match rollback artifact %s", artifact.Component))
		}
		path, err := componentUpdater.downloadFromURL(artifact.DownloadURL)
		if err != nil {
			return fail(fmt.Errorf("download rollback artifact %s: %w", artifact.Component, err))
		}
		stat, err := os.Stat(path)
		if err != nil || stat.Size() != artifact.Size {
			removeCleanup(path)
			if err != nil {
				return fail(fmt.Errorf("stat rollback artifact %s: %w", artifact.Component, err))
			}
			return fail(fmt.Errorf("rollback artifact %s size mismatch: expected %d, got %d", artifact.Component, artifact.Size, stat.Size()))
		}
		if err := componentUpdater.verifyChecksum(path, strings.ToLower(artifact.SHA256)); err != nil {
			removeCleanup(path)
			return fail(fmt.Errorf("rollback artifact %s checksum verification failed: %w", artifact.Component, err))
		}
		result.Artifacts = append(result.Artifacts, StagedRollbackArtifact{RollbackArtifactMetadata: artifact, StagedPath: path})
	}
	return result, nil
}

// VerifySignedPayload verifies an arbitrary domain-separated payload against
// the same exact keyed manifest trust set used for release artifacts.
func (u *Updater) VerifySignedPayload(keyID string, payload, signature []byte) error {
	return u.verifyManifestSignature(payload, signature, keyID)
}

// downloadBinary fetches download info from the API and then downloads the binary.
// Supports both legacy redirect responses and JSON info responses.
// downloadBinary returns the temp path of the downloaded binary, the verified
// single-asset manifest view, and the raw signature-VERIFIED release manifest
// payload (info.Manifest). The payload is returned so the macOS update path can
// look up the .pkg asset's signed checksum from the same trust root without a
// second round-trip; it is safe to use because verifyUpdateManifest has already
// checked its Ed25519 signature.
func (u *Updater) downloadBinary(version string) (string, updateManifest, []byte, error) {
	if err := u.checkClient(); err != nil {
		return "", updateManifest{}, nil, err
	}
	if u.config.AuthToken == nil {
		return "", updateManifest{}, nil, fmt.Errorf("auth token not available")
	}
	// Step 1: Get download URL + checksum from API.
	infoURL := fmt.Sprintf("%s/api/v1/agent-versions/%s/download?platform=%s&arch=%s&component=%s",
		u.serverURL(), version, runtime.GOOS, runtime.GOARCH, url.QueryEscape(u.component()))

	req, err := http.NewRequest("GET", infoURL, nil)
	if err != nil {
		return "", updateManifest{}, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+u.config.AuthToken.Reveal())

	resp, err := u.requestWithoutRedirect(req)
	if err != nil {
		return "", updateManifest{}, nil, err
	}
	defer resp.Body.Close()

	info, err := u.parseDownloadInfo(resp)
	if err != nil {
		return "", updateManifest{}, nil, err
	}

	manifest, err := u.verifyUpdateManifest(info, version)
	if err != nil {
		return "", updateManifest{}, nil, err
	}
	// info.Manifest is now signature-verified; capture it for the macOS .pkg
	// checksum lookup in UpdateTo.
	verifiedPayload := []byte(info.Manifest)

	// Step 2: Download the actual binary from the manifest URL. info.URL may
	// be cross-origin from the configured control plane (a signed manifest
	// legitimately points at a public CDN); downloadFromURL no longer
	// enforces an origin match itself — destination safety (scheme, dial-time
	// address, redirect chain, credential stripping) is u.client's job alone,
	// via the netpolicy.Policy built in updaterPolicy.
	tempPath, err := u.downloadFromURL(info.URL)
	if err != nil {
		return "", updateManifest{}, nil, err
	}
	if manifest.Size > 0 {
		stat, err := os.Stat(tempPath)
		if err != nil {
			removeCleanup(tempPath)
			return "", updateManifest{}, nil, err
		}
		if stat.Size() != manifest.Size {
			removeCleanup(tempPath)
			return "", updateManifest{}, nil, fmt.Errorf("downloaded binary size mismatch: expected %d, got %d", manifest.Size, stat.Size())
		}
	}

	return tempPath, manifest, verifiedPayload, nil
}

// verifyChecksum verifies the SHA256 checksum of a file
func (u *Updater) verifyChecksum(path, expectedChecksum string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return err
	}

	actualChecksum := hex.EncodeToString(hasher.Sum(nil))
	if actualChecksum != expectedChecksum {
		return fmt.Errorf("checksum mismatch: expected %s, got %s", expectedChecksum, actualChecksum)
	}

	return nil
}

// backupCurrentBinary creates a backup of the current binary
func (u *Updater) backupCurrentBinary() error {
	// Remove old backup if exists
	removeCleanup(u.config.BackupPath)

	// Copy current binary to backup
	src, err := os.Open(u.config.BinaryPath)
	if err != nil {
		return err
	}
	defer src.Close()

	dst, err := os.Create(u.config.BackupPath)
	if err != nil {
		return err
	}
	defer dst.Close()

	if _, err := io.Copy(dst, src); err != nil {
		return err
	}

	// Copy permissions
	info, err := os.Stat(u.config.BinaryPath)
	if err != nil {
		return err
	}
	return os.Chmod(u.config.BackupPath, info.Mode())
}

// verifyStagedBinarySignature checks that a binary staged for installation
// carries a code signature the OS will accept. macOS is the only platform where
// the agent's code identity — and therefore every TCC grant keyed to it —
// depends on that signature, so it is a no-op elsewhere.
//
// It is a package variable so tests can drive replaceBinary's rejection path on
// any platform, and so the existing replaceBinary tests can use plain-text
// stand-in "binaries" (not Mach-O, so the real check would always reject them).
// Matches the seam style already used in this package
// (missingSigningKeyIDWarner, unusableTrustSetLogger).
var verifyStagedBinarySignature = defaultStagedSignatureCheck

// defaultStagedSignatureCheck runs `codesign --verify` on macOS.
//
// Release binaries are Apple Developer ID signed, notarized, and
// codesign-verified by the release workflow before upload, and locally built
// darwin/arm64 binaries carry the Go linker's own signature, so this passes for
// every artifact the updater is expected to install. A failure means the staged
// artifact is genuinely unsigned or its signature is broken.
func defaultStagedSignatureCheck(path string) error {
	if runtime.GOOS != "darwin" {
		return nil
	}
	out, err := exec.Command("codesign", "--verify", "--verbose", path).CombinedOutput()
	if err == nil {
		return nil
	}
	detail := strings.TrimSpace(string(out))
	if detail == "" {
		detail = err.Error()
	}
	return fmt.Errorf("%w: %s", ErrCodeSignatureInvalid, detail)
}

// replaceBinary replaces the current binary with a new one.
//
// On macOS the incoming binary's code signature is verified BEFORE anything is
// written, so a rejected update leaves the installed binary completely
// untouched — there is nothing to roll back, and the agent keeps running the
// identity its TCC grants are keyed to. See ErrCodeSignatureInvalid for why the
// old ad-hoc re-sign fallback was removed (#3458).
func (u *Updater) replaceBinary(newPath string) error {
	if err := verifyStagedBinarySignature(newPath); err != nil {
		return err
	}

	// On Unix, we can rename over the existing file
	// On Windows, we need to rename the existing file first
	if runtime.GOOS == "windows" {
		oldPath := u.config.BinaryPath + ".old"
		removeCleanup(oldPath)
		if err := os.Rename(u.config.BinaryPath, oldPath); err != nil {
			return err
		}
	}

	// On Unix, unlink the old binary before creating the new file.
	// The kernel keeps the old inode alive for the running process's
	// memory-mapped text segment. The new file gets a fresh inode,
	// avoiding ETXTBSY ("text file busy") errors.
	if runtime.GOOS != "windows" {
		os.Remove(u.config.BinaryPath)
	}

	// Copy new binary to target location
	src, err := os.Open(newPath)
	if err != nil {
		return err
	}
	defer src.Close()

	dst, err := os.Create(u.config.BinaryPath)
	if err != nil {
		return err
	}
	defer dst.Close()

	if _, err := io.Copy(dst, src); err != nil {
		return err
	}

	// Set executable permissions on Unix
	if runtime.GOOS != "windows" {
		if err := os.Chmod(u.config.BinaryPath, 0755); err != nil {
			return err
		}
	}

	return nil
}

// DownloadAndVerify downloads a binary from the URL and verifies its
// SHA-256 checksum, returning the path to the verified temp file. The
// caller is responsible for moving the file into place and removing the
// temp file. Used by dev_push when updating a non-agent binary (e.g. the
// desktop helper) so the updater's automatic replace+restart flow is skipped.
func (u *Updater) DownloadAndVerify(url, expectedChecksum string) (string, error) {
	tempPath, err := u.downloadFromURL(url)
	if err != nil {
		return "", fmt.Errorf("failed to download binary: %w", err)
	}
	if err := u.verifyChecksum(tempPath, expectedChecksum); err != nil {
		removeCleanup(tempPath)
		return "", fmt.Errorf("checksum verification failed: %w", err)
	}
	return tempPath, nil
}

// UpdateFromURL downloads a binary directly from a URL (skipping the version-lookup
// API call used by UpdateTo). Used by dev_push for fast iteration.
//
// opts.UserHelper, when non-nil and on Windows, is threaded through to the
// restart helper script so a dev-push can swap the user-helper alongside the
// agent. Existing dev_push callers (handlers_devupdate.go) pass UpdateOptions{}
// for agent-only behavior. Issue #816 / #845 follow-up (PR B): replaces the
// prior u.extras action-at-a-distance read inside UpdateFromURL — that read
// silently inherited whatever UpdateToWithUserHelper had last stuffed into
// u.extras, which was a real footgun for any future dev-push surface that
// shared an Updater instance with the heartbeat upgrade path.
func (u *Updater) UpdateFromURL(rawURL, expectedChecksum string, opts UpdateOptions) error {
	lease, ok := TryBeginProcessMutation("agent-dev-update")
	if !ok {
		return ErrProcessMutationInProgress
	}
	defer lease.Release()
	// Log only the host, never the full URL: dev_update's downloadUrl is
	// operator/control-plane supplied and may legitimately carry a
	// capability query string (e.g. a signed CDN asset URL), which must
	// never reach a log line. host is best-effort — a parse failure logs
	// "" rather than falling back to the raw URL.
	host := ""
	if parsed, perr := url.Parse(rawURL); perr == nil {
		host = parsed.Host
	}
	log.Info("starting dev update from URL", "host", host)

	// Pre-flight: verify we can write to the binary's directory.
	// Skip on Windows — the running exe is locked by the OS, but
	// RestartWithHelper handles this by waiting for process exit
	// before copying the new binary.
	if runtime.GOOS != "windows" {
		if err := checkWritable(u.config.BinaryPath); err != nil {
			return normalizePreflightErr(err)
		}
	}

	// 1. Download binary directly
	tempPath, err := u.downloadFromURL(rawURL)
	if err != nil {
		return fmt.Errorf("failed to download binary: %w", err)
	}

	// 2. Verify checksum
	if err := u.verifyChecksum(tempPath, expectedChecksum); err != nil {
		removeCleanup(tempPath)
		return fmt.Errorf("checksum verification failed: %w", err)
	}

	// 3. Backup current binary
	if err := u.backupCurrentBinary(); err != nil {
		removeCleanup(tempPath)
		return fmt.Errorf("failed to backup current binary: %w", err)
	}

	// 4. Windows: spawn helper script for binary swap
	if runtime.GOOS == "windows" {
		if err := RestartWithHelper(BinaryPair{Temp: tempPath, Target: u.config.BinaryPath}, opts.UserHelper, opts.Backup); err != nil {
			removeCleanup(tempPath)
			if rbErr := u.Rollback(); rbErr != nil {
				log.Error("rollback also failed", "originalError", err, "rollbackError", rbErr)
			}
			return fmt.Errorf("failed to spawn update helper: %w", err)
		}
		return nil
	}

	// 5. Non-Windows: replace binary inline and restart
	defer removeCleanup(tempPath)
	if err := u.replaceBinary(tempPath); err != nil {
		if isCodeSignatureErr(err) {
			logCodeSignatureRejection("", err)
			return err
		}
		if isReadOnlyErr(err) {
			return fmt.Errorf("%w: %v", ErrReadOnlyFS, err)
		}
		if rbErr := u.Rollback(); rbErr != nil {
			log.Error("rollback also failed after replace error", "replaceError", err, "rollbackError", rbErr)
			return fmt.Errorf("failed to replace binary: %w (rollback also failed: %v)", err, rbErr)
		}
		return fmt.Errorf("failed to replace binary (rolled back): %w", err)
	}

	if err := Restart(); err != nil {
		if rbErr := u.Rollback(); rbErr != nil {
			log.Error("rollback also failed after restart error", "restartError", err, "rollbackError", rbErr)
			return fmt.Errorf("failed to restart: %w (rollback also failed: %v)", err, rbErr)
		}
		return fmt.Errorf("failed to restart (rolled back): %w", err)
	}

	return nil
}

// downloadFromURL downloads a binary directly from the given URL to a temp
// file. rawURL may be cross-origin from the configured control plane — the
// signed-manifest flow legitimately follows a control-plane URL to a public
// CDN — so this method does NOT compare origins itself. All destination
// safety (scheme, dial-time address, redirect chain, credential stripping on
// origin change) is enforced by u.client, which netpolicy.NewClient built
// from updaterPolicy(u.config); this is the single, dial-time-authoritative
// check. A local host/scheme comparison here would be redundant at best and
// a silent divergence risk at worst — removed, not duplicated (#SSRF-AGENT-001).
func (u *Updater) downloadFromURL(rawURL string) (string, error) {
	if err := u.checkClient(); err != nil {
		return "", err
	}
	if u.config.AuthToken == nil {
		return "", fmt.Errorf("auth token not available")
	}

	req, err := http.NewRequest("GET", rawURL, nil)
	if err != nil {
		return "", fmt.Errorf("invalid download URL: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+u.config.AuthToken.Reveal())

	resp, err := u.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to download binary: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("binary download failed with status %d", resp.StatusCode)
	}

	tempFile, err := os.CreateTemp("", "breeze-agent-dev-*")
	if err != nil {
		return "", err
	}
	defer tempFile.Close()

	// CopyBounded, not io.Copy: the transport already caps the response body
	// via Policy.MaxResponseBytes when u.client is netpolicy-backed, but a
	// caller that overrides u.client (or a future policy change) must not be
	// able to reintroduce an unbounded write to disk. CopyBounded errors
	// rather than truncating silently.
	if _, err := netpolicy.CopyBounded(tempFile, resp.Body, maxUpdateBinaryBytes); err != nil {
		removeCleanup(tempFile.Name())
		return "", fmt.Errorf("failed to download binary: %w", err)
	}

	return tempFile.Name(), nil
}

// ErrFileLocked is returned when the binary is locked by another process.
// This is transient (not permanent like ErrReadOnlyFS) and should be retried.
var ErrFileLocked = fmt.Errorf("binary is locked by another process")

// checkWritable verifies we can write to the target binary path by opening
// the existing file for writing without truncating it. This tests file-level
// write permission, matching what replaceBinary (os.Create) does, and works
// correctly with systemd's ReadWritePaths which grants per-file access.
func checkWritable(binaryPath string) error {
	f, err := os.OpenFile(binaryPath, os.O_WRONLY, 0)
	if err != nil {
		if isFileLocked(err) {
			return fmt.Errorf("%w: %v", ErrFileLocked, err)
		}
		// ETXTBSY means the binary is running but the filesystem is writable.
		// replaceBinary handles this via unlink-before-write (fresh inode),
		// so this is not a writability problem — let the update proceed.
		if errors.Is(err, syscall.ETXTBSY) {
			return nil
		}
		return err
	}
	return f.Close()
}

// isReadOnlyErr returns true if the error indicates a read-only filesystem
// or permission denied — used to catch TOCTOU races where the pre-flight
// check passed but the filesystem became read-only before replaceBinary.
func isReadOnlyErr(err error) bool {
	return errors.Is(err, syscall.EROFS) || errors.Is(err, syscall.EACCES)
}

// removeCleanup removes a file and logs a warning on failure.
func removeCleanup(path string) {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		log.Warn("failed to clean up temp file", "path", path, "error", err.Error())
	}
}

// Rollback restores the backup binary
func (u *Updater) Rollback() error {
	log.Info("rolling back to previous version")

	if _, err := os.Stat(u.config.BackupPath); os.IsNotExist(err) {
		return fmt.Errorf("no backup found at %s", u.config.BackupPath)
	}

	// On Unix, unlink the current binary before writing the backup.
	// Same reason as replaceBinary: avoid ETXTBSY on a running executable.
	if runtime.GOOS != "windows" {
		os.Remove(u.config.BinaryPath)
	}

	// Copy backup to current location
	src, err := os.Open(u.config.BackupPath)
	if err != nil {
		return err
	}
	defer src.Close()

	dst, err := os.Create(u.config.BinaryPath)
	if err != nil {
		return err
	}
	defer dst.Close()

	if _, err := io.Copy(dst, src); err != nil {
		return err
	}

	// Set executable permissions on Unix
	if runtime.GOOS != "windows" {
		if err := os.Chmod(u.config.BinaryPath, 0755); err != nil {
			return err
		}
	}

	return nil
}
