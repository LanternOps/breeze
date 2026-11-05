package recoveryinstall

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/breeze-rmm/agent/internal/hostpolicy"
)

// TrustPath names how a recovery executable earned the right to run as SYSTEM
// (root on macOS). It is recorded in the journal and reported in the
// capability detail so the console can show which path applied.
type TrustPath string

const (
	// TrustCodeSignature is Path A: the platform code signature (Authenticode
	// via WinVerifyTrust on Windows). Hosted and signed editions use only this.
	TrustCodeSignature TrustPath = "code_signature"
	// TrustManifestHash is Path B, self-host only: the executable's SHA-256
	// equals the entry for its release asset in the Ed25519-signed release
	// manifest, for exactly the version directory it was installed into.
	TrustManifestHash TrustPath = "manifest_hash"
)

// ErrUntrusted means neither trust path accepted the recovery executable.
// Readiness reports it as recovery_untrusted. There is no third path:
// "present but unsigned" is never enough.
var ErrUntrusted = errors.New("recovery executable is untrusted")

const (
	// RecoveryDirName is the per-version parent directory under the install dir:
	// <install dir>\isolation-recovery\<version>\.
	RecoveryDirName = "isolation-recovery"
	// ManifestEnvelopeName is the signed release manifest persisted next to the
	// recovery executable, in the same version directory. Whoever places the
	// executable (MSI bundle or the updater-component fetcher) places this too.
	// It is untrusted input: every check re-verifies its signature.
	ManifestEnvelopeName = "release-manifest.json"

	maxEnvelopeBytes     = 1 << 20
	maxRecoveryExeBytes  = 128 << 20
	recoveryAssetPrefix  = "breeze-isolation-recovery-"
	windowsExecutableExt = ".exe"
)

// ManifestEnvelope is the signed release manifest as the server serves it in
// download info. The JSON names match the updater's downloadInfo fields.
type ManifestEnvelope struct {
	Manifest     string `json:"manifest"`
	Signature    string `json:"manifestSignature"`
	SigningKeyID string `json:"signingKeyId,omitempty"`
}

// AssetDigestFunc verifies env's Ed25519 signature against the updater's trust
// set and returns the SHA-256 hex the signed manifest lists for asset at exactly
// release version. In production it is updater.(*Updater).VerifiedReleaseAssetSHA256,
// the same trust decision the updater makes before it applies a download.
type AssetDigestFunc func(env ManifestEnvelope, version, asset string) (string, error)

// ManifestTrust configures Path B. The zero value disables it.
//
// SelfHostEdition must be true only for a self-host build (the updater's
// !hostpolicy.Enforced()), whose public agent-family executables ship without
// Authenticode (platformTrust "none"). A hosted or signed edition leaves it
// false and keeps Path A only, even if a digest verifier is supplied.
type ManifestTrust struct {
	SelfHostEdition bool
	ManifestDigest  AssetDigestFunc
	// AssetName is the release asset whose manifest entry pins the executable,
	// e.g. breeze-isolation-recovery-windows-amd64.exe (see ReleaseAssetName).
	AssetName string
}

// enabled also consults hostpolicy directly. A hosted (allowlist-enforced)
// build never takes Path B, even if its wiring passes SelfHostEdition by
// mistake. This is the same edition signal the updater's editionAllowed uses.
func (m ManifestTrust) enabled() bool {
	return m.SelfHostEdition && !hostpolicy.Enforced() && m.ManifestDigest != nil && m.AssetName != ""
}

// TrustPolicy decides whether a recovery executable may run as SYSTEM.
// Path A (CodeSignature) is always tried first; Path B only when ManifestTrust
// is enabled.
type TrustPolicy struct {
	CodeSignature func(path string) error
	ManifestTrust
}

// ReleaseAssetName is the recovery executable's release asset name for a
// platform, matching the updater's isolation-recovery component.
func ReleaseAssetName(goos, goarch string) string {
	name := recoveryAssetPrefix + goos + "-" + goarch
	if goos == "windows" {
		name += windowsExecutableExt
	}
	return name
}

// Verify returns the path that accepted the executable at path, or an error
// wrapping ErrUntrusted.
//
// Like the Authenticode check it replaces for self-host, this is a
// time-of-check decision. The executable lives in the SYSTEM-only protected
// install directory, and every readiness probe and task arm re-verifies it.
func (p TrustPolicy) Verify(path string) (TrustPath, error) {
	if p.CodeSignature == nil {
		return "", fmt.Errorf("%w: no code-signature verifier", ErrUntrusted)
	}
	sigErr := p.CodeSignature(path)
	if sigErr == nil {
		return TrustCodeSignature, nil
	}
	if !p.enabled() {
		return "", fmt.Errorf("%w: code signature: %w", ErrUntrusted, sigErr)
	}
	if err := p.verifyManifestHash(path); err != nil {
		return "", fmt.Errorf("%w: code signature: %w; manifest hash: %w", ErrUntrusted, sigErr, err)
	}
	return TrustManifestHash, nil
}

func (p TrustPolicy) verifyManifestHash(path string) error {
	version, err := VersionFromPath(path)
	if err != nil {
		return err
	}
	env, err := readManifestEnvelope(filepath.Join(filepath.Dir(path), ManifestEnvelopeName))
	if err != nil {
		return err
	}
	wantHex, err := p.ManifestDigest(env, version, p.AssetName)
	if err != nil {
		return fmt.Errorf("signed release manifest %s: %w", version, err)
	}
	want, err := hex.DecodeString(strings.ToLower(strings.TrimSpace(wantHex)))
	if err != nil || len(want) != sha256.Size {
		return fmt.Errorf("signed release manifest %s lists a malformed SHA-256 for %s", version, p.AssetName)
	}
	got, err := fileSHA256(path)
	if err != nil {
		return err
	}
	if subtle.ConstantTimeCompare(got, want) != 1 {
		return fmt.Errorf("SHA-256 does not match the signed release manifest entry for %s at %s", p.AssetName, version)
	}
	return nil
}

// VersionFromPath is the version directory a recovery executable was installed
// into: path must be <dir>/isolation-recovery/<version>/<file>. Path B binds
// the manifest to exactly this version, never to whatever release is newest.
func VersionFromPath(path string) (string, error) {
	dir := filepath.Dir(filepath.Clean(path))
	version := filepath.Base(dir)
	if !strings.EqualFold(filepath.Base(filepath.Dir(dir)), RecoveryDirName) {
		return "", fmt.Errorf("recovery executable is not in an %s version directory", RecoveryDirName)
	}
	if !validVersion(version) {
		return "", fmt.Errorf("recovery version directory %q is not a release version", version)
	}
	return version, nil
}

func validVersion(v string) bool {
	return len(v) <= 128 && versionPattern.MatchString(v) && !strings.Contains(v, "..")
}

func readManifestEnvelope(path string) (ManifestEnvelope, error) {
	data, err := readRegularFile(path, maxEnvelopeBytes)
	if err != nil {
		return ManifestEnvelope{}, fmt.Errorf("read signed release manifest: %w", err)
	}
	var env ManifestEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return ManifestEnvelope{}, fmt.Errorf("decode signed release manifest: %w", err)
	}
	if env.Manifest == "" || env.Signature == "" {
		return ManifestEnvelope{}, errors.New("release manifest envelope is missing the manifest or its signature")
	}
	return env, nil
}

func readRegularFile(path string, limit int64) ([]byte, error) {
	if err := regularFile(path); err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("%s is larger than %d bytes", filepath.Base(path), limit)
	}
	return data, nil
}

func fileSHA256(path string) ([]byte, error) {
	if err := regularFile(path); err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(f, maxRecoveryExeBytes+1))
	if err != nil {
		return nil, fmt.Errorf("hash recovery executable: %w", err)
	}
	if n > maxRecoveryExeBytes {
		return nil, fmt.Errorf("recovery executable is larger than %d bytes", int64(maxRecoveryExeBytes))
	}
	return h.Sum(nil), nil
}
