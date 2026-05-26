// Package pam provides the agent-side rule cache for the PAM (Privileged Access
// Management) rule engine. The cache lets the agent enforce PAM rules while
// offline from the Breeze API.
//
// File layout (uses config.GetDataDir under the hood):
//
//	Windows:  %ProgramData%\Breeze\data\pam-rules.json
//	Linux:    /var/lib/breeze/pam-rules.json
//	macOS:    /Library/Application Support/Breeze/data/pam-rules.json
//
// The HMAC key lives in a sibling `keys/` subdir under the same data root
// (see DefaultKeyPath). Co-locating the key with the cache file would mean a
// single ACL regression on the data dir exposes both; the separation buys
// defense in depth.
//
// The file is an HMAC-SHA256-authenticated JSON envelope. The rule body itself
// is opaque to this package (json.RawMessage) — the actual rule schema is
// defined by the rule engine (separate PR, not in this track).
//
// Tampering with the file on disk is detected via the HMAC. Read-only-to-SYSTEM
// NTFS ACLs on Windows raise the bar further, but the HMAC is the
// authoritative trust boundary.
//
// # Threat model — cache file vs key co-location
//
// The cache envelope and its HMAC key are stored in sibling directories
// (data/pam-rules.json vs data/keys/pam-rules.key) rather than alongside each
// other in the same dir. Both paths inherit hardened parent-dir perms today,
// but if a future change ever loosens the data dir's ACL/perms (e.g. to let
// the Breeze Helper running as the logged-in user read agent.yaml), the key
// still sits behind a separately ACL'd subdir (0700 on Unix, SYSTEM+Admins-
// only DACL on Windows). An attacker who can read the envelope still can't
// forge a new MAC without also breaching the keys dir.
//
// # Threat model — staleness
//
// The 7-day refuse-stale gate (RefuseAfter) uses wall-clock time via
// time.Since(SignedFields.SyncedAt). A local-admin attacker with the ability
// to roll the system clock back can defeat this gate and keep a stale
// envelope "fresh" indefinitely. This is acceptable for the threat the gate
// is designed to catch — "agent forgotten / VPN broken for >7d, rules need
// to fail closed" — but is NOT a defense against an active local-admin
// attacker.
//
// Defense in depth for the air-gapped-endpoint threat model would require a
// monotonic "last-seen-fresh" watermark file that only ever moves forward
// (max(previous, time.Now()) on every successful sync), so that rolling the
// clock back cannot make the watermark younger. That is out of scope for
// this PR and tracked as a follow-up.
package pam

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
)

// FormatVersion is the on-disk envelope schema version. Bump on any breaking
// envelope change. The rule body (Rules) is versioned independently by the
// rule engine.
const FormatVersion = 1

// StaleAfter is the duration after which a cached ruleset is considered stale
// for alerting purposes. Load returns ErrStale once SyncedAt + StaleAfter is in
// the past; callers may keep using the rules anyway (fail-closed) but should
// raise an alert.
const StaleAfter = 24 * time.Hour

// RefuseAfter is the hard upper bound. Once a cached ruleset is older than
// RefuseAfter, Load returns (nil, ErrRefuseStale) and refuses to hand back the
// envelope at all. The cache is too far out of sync with the server to be
// safely enforceable; the caller must either re-sync or fail-closed at the
// policy layer (block everything) rather than enforce ancient rules.
const RefuseAfter = 7 * 24 * time.Hour

// ErrCacheMissing is returned by Load when the cache file does not exist.
var ErrCacheMissing = errors.New("pam: cache file missing")

// ErrCorrupt is returned by Load when the JSON envelope cannot be parsed or
// required fields are missing/zero. Callers should treat this the same as
// ErrCacheMissing and request a full re-sync from the server.
var ErrCorrupt = errors.New("pam: cache envelope corrupt")

// ErrHMACMismatch is returned by Verify (and Load on error path) when the
// stored MAC does not match the recomputed MAC. Indicates tampering or HMAC-key
// drift; callers MUST NOT trust the rule body.
var ErrHMACMismatch = errors.New("pam: HMAC mismatch")

// ErrStale is returned by Load when the cache is older than StaleAfter but
// still within RefuseAfter. The returned *Envelope is still valid (HMAC was
// checked) — this is a signal to alert the user, not to discard the rules.
var ErrStale = errors.New("pam: cache stale")

// ErrRefuseStale is returned by Load when the cache is older than RefuseAfter.
// The returned envelope is nil — the cache is too old to be trusted for
// enforcement and callers must re-sync or fail-closed.
var ErrRefuseStale = errors.New("pam: cache exceeds RefuseAfter, refusing to enforce")

// Envelope is the on-disk format. Field order is significant only for human
// readability — the HMAC is computed over the canonical JSON of the inner
// SignedFields, NOT over the whole envelope serialization, so field reordering
// during round-trip cannot break verification.
type Envelope struct {
	// Version is the envelope schema version (currently 1). A loader sees a
	// version it doesn't understand → returns ErrCorrupt.
	Version int `json:"version"`

	// SignedFields holds everything covered by the MAC. Kept as a nested
	// struct (not flattened) so the MAC computation has one well-defined
	// JSON shape independent of envelope-level fields added later.
	SignedFields SignedFields `json:"signed"`

	// MAC is hex(HMAC-SHA256(key, canonical-json(SignedFields))).
	MAC string `json:"mac"`
}

// SignedFields is the portion of the envelope covered by the HMAC.
type SignedFields struct {
	// RulesetID identifies the server-side ruleset revision this cache
	// represents. Opaque string; server-assigned (e.g. ULID or short hash).
	// Empty string is invalid → ErrCorrupt.
	RulesetID string `json:"ruleset_id"`

	// SyncedAt is when the agent last received this ruleset from the server.
	// Used for staleness alerting. UTC, RFC3339 in JSON.
	SyncedAt time.Time `json:"synced_at"`

	// Rules is the opaque rule body. The rule engine (separate PR) is the
	// only consumer that understands its shape. Keeping it as RawMessage
	// here means this package never has to change when the rule schema does.
	Rules json.RawMessage `json:"rules"`
}

// Save writes env to path atomically and applies tight ACLs on Windows.
// It computes (or overwrites) env.MAC using key.
//
// Atomicity follows the same pattern as agent.yaml SaveTo
// (agent/internal/config/config.go:519 `atomicWriteFile`):
// write to "<path>.partial" → fsync → rename. On power loss the destination
// either holds the previous good copy or nothing — never a torn write.
func Save(path string, env *Envelope, key []byte) error {
	if env == nil {
		return errors.New("pam: nil envelope")
	}
	if env.SignedFields.RulesetID == "" {
		return errors.New("pam: empty ruleset_id")
	}
	if env.SignedFields.SyncedAt.IsZero() {
		return errors.New("pam: zero SyncedAt")
	}
	if len(key) == 0 {
		return errors.New("pam: empty HMAC key")
	}
	if env.Version == 0 {
		env.Version = FormatVersion
	}

	mac, err := computeMAC(&env.SignedFields, key)
	if err != nil {
		return fmt.Errorf("pam: compute MAC: %w", err)
	}
	env.MAC = mac

	// Compact marshal (no MarshalIndent): keeps the on-disk byte form stable
	// across round-trips and matches the compact form used when computing the
	// MAC over SignedFields. A pretty-printed file would still verify
	// correctly (the MAC is over the inner signed struct, not the file bytes)
	// but it makes diffing the file by hand harder for no real benefit — the
	// cache is machine-only.
	data, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("pam: marshal envelope: %w", err)
	}

	// Make sure the parent dir exists with restrictive perms before writing.
	// On Windows, applyCacheACL (cache_windows.go) tightens to SYSTEM+Admins
	// only after the file lands.
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0750); err != nil {
		return fmt.Errorf("pam: mkdir %s: %w", dir, err)
	}

	if err := atomicWriteFile(path, data, 0600); err != nil {
		return fmt.Errorf("pam: atomic write: %w", err)
	}

	// ACL hardening is best-effort: on Windows we tighten the DACL; on other
	// platforms applyCacheACL is a no-op (Chmod already happened via perm bits).
	if err := applyCacheACL(path); err != nil {
		// Don't fail the Save — file is written, MAC protects integrity.
		// Caller can log the warning.
		return fmt.Errorf("pam: apply ACL (file written): %w", err)
	}
	return nil
}

// Load reads the cache from path and verifies its HMAC against key.
//
// Returns:
//   - (nil, ErrCacheMissing)   — file does not exist
//   - (nil, ErrCorrupt)        — JSON parse failure or missing required fields
//   - (nil, ErrHMACMismatch)   — MAC verification failed
//   - (nil, ErrRefuseStale)    — verified but older than RefuseAfter (7d)
//   - (env, ErrStale)          — verified but older than StaleAfter (24h)
//   - (env, nil)               — verified and fresh
//
// On ErrStale the returned envelope is still usable; the caller decides
// whether to enforce stale rules or refuse. The PAM design (per Billy) is to
// keep enforcing while raising an alert — up to RefuseAfter. Past RefuseAfter
// the cache is withheld entirely (Load returns nil envelope) and the policy
// layer must fail-closed.
func Load(path string, key []byte) (*Envelope, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ErrCacheMissing
		}
		return nil, fmt.Errorf("pam: read cache: %w", err)
	}

	var env Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCorrupt, err)
	}
	if env.Version != FormatVersion {
		return nil, fmt.Errorf("%w: unknown version %d", ErrCorrupt, env.Version)
	}
	if env.SignedFields.RulesetID == "" {
		return nil, fmt.Errorf("%w: empty ruleset_id", ErrCorrupt)
	}
	if env.SignedFields.SyncedAt.IsZero() {
		return nil, fmt.Errorf("%w: zero SyncedAt", ErrCorrupt)
	}
	if env.MAC == "" {
		return nil, fmt.Errorf("%w: empty MAC", ErrCorrupt)
	}

	if err := verifyMAC(&env, key); err != nil {
		return nil, err
	}

	age := time.Since(env.SignedFields.SyncedAt)
	if age > RefuseAfter {
		return nil, ErrRefuseStale
	}
	if age > StaleAfter {
		return &env, ErrStale
	}
	return &env, nil
}

// Verify re-checks the MAC on an already-loaded envelope using key. Useful for
// the staleness alerter or any caller that wants to revalidate without
// re-reading the file.
func Verify(env *Envelope, key []byte) error {
	if env == nil {
		return errors.New("pam: nil envelope")
	}
	return verifyMAC(env, key)
}

// verifyMAC recomputes the MAC and compares constant-time.
func verifyMAC(env *Envelope, key []byte) error {
	if len(key) == 0 {
		return errors.New("pam: empty HMAC key")
	}
	want, err := computeMAC(&env.SignedFields, key)
	if err != nil {
		return fmt.Errorf("pam: compute MAC: %w", err)
	}
	wantBytes, err := hex.DecodeString(want)
	if err != nil {
		return fmt.Errorf("pam: decode computed MAC: %w", err)
	}
	gotBytes, err := hex.DecodeString(env.MAC)
	if err != nil {
		return fmt.Errorf("%w: invalid hex", ErrHMACMismatch)
	}
	if !hmac.Equal(wantBytes, gotBytes) {
		return ErrHMACMismatch
	}
	return nil
}

// computeMAC computes hex(HMAC-SHA256(key, canonical-json(signed))).
//
// "Canonical" here means: encoding/json's default Marshal output for
// SignedFields with no indentation. Because SignedFields is a struct (not a
// map), Go's encoder emits fields in struct declaration order deterministically.
// json.RawMessage is written verbatim — which means the server MUST produce the
// rules body in a stable byte form, OR the agent must canonicalize it on
// receive (recommended path: server emits compact JSON, agent stores verbatim,
// MAC covers exactly what was received).
//
// This mirrors the IPC HMAC pattern (agent/internal/ipc/protocol.go:196
// `computeHMAC`) but uses encoded JSON as the MAC input rather than
// concatenating fields, because the rule body is variable-shape.
func computeMAC(signed *SignedFields, key []byte) (string, error) {
	buf, err := json.Marshal(signed)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, key)
	mac.Write(buf)
	return hex.EncodeToString(mac.Sum(nil)), nil
}

// DefaultPath returns the platform default cache file path. Routes through
// config.GetDataDir so all platforms land under the same data root the rest
// of the agent uses (Windows: %ProgramData%\Breeze\data,
// macOS: /Library/Application Support/Breeze/data, Linux: /var/lib/breeze).
func DefaultPath() string {
	return filepath.Join(config.GetDataDir(), "pam-rules.json")
}

// atomicWriteFile mirrors the pattern at
// agent/internal/config/config.go:519. Duplicated locally (rather than
// imported) because the upstream helper is unexported.
func atomicWriteFile(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".partial"
	_ = os.Remove(tmp)
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL|os.O_TRUNC, perm)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	// Best-effort dir fsync; Windows no-ops are expected.
	if d, derr := os.Open(filepath.Dir(path)); derr == nil {
		_ = d.Sync()
		d.Close()
	}
	return nil
}
