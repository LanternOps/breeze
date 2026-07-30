package config

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/spf13/viper"
)

// ErrManifestTrustRotationRejected is returned by PinManifestKeys when the
// caller supplies a different pubkey for an already-pinned keyId. This is a
// possible compromise signal — callers should surface it loudly.
var ErrManifestTrustRotationRejected = errors.New("manifest trust key rotation rejected")

// ErrManifestTrustExpansionRejected is returned by PinManifestKeys when the
// caller supplies a deployment key the agent has never seen while a
// deployment key is already pinned (or supplies two unseen keys at once).
//
// TOFU accepts exactly ONE first deployment key and then freezes: growing the
// trust set is what let a control plane with API write access — but no signing
// key — quietly introduce a key of its own and sign updates with it. Adding a
// key after bootstrap requires the signed delegation protocol, not a bare
// heartbeat field.
var ErrManifestTrustExpansionRejected = errors.New("manifest trust key expansion rejected")

// maxManifestKeyIDLen bounds a key ID. It matches the API-side
// `signingKeyId: z.string().max(128)` validator, and it is what makes a key ID
// safe to put in a log line or an error string: bounded, and restricted to the
// charset below.
const maxManifestKeyIDLen = 128

// ActiveConfigFile returns the absolute path of the currently loaded agent
// config file, or "" if Load() has not been called. Callers writing changes
// to disk should pass this through to SaveTo / PinManifestKeys.
func ActiveConfigFile() string {
	return viper.ConfigFileUsed()
}

// ManifestTrustKey is a per-deployment Ed25519 public key delivered by the
// API via enrollment or heartbeat ack and pinned TOFU-style on the agent.
// The keyId is opaque to the agent (beyond ValidManifestKeyID's charset), and
// the publicKeyB64 is the raw 32-byte Ed25519 public key, base64-encoded.
type ManifestTrustKey struct {
	KeyID        string
	PublicKeyB64 string
}

// ValidManifestKeyID reports whether id is a well-formed manifest signing key
// ID: 1..128 characters drawn from [A-Za-z0-9._-].
//
// The excluded ':' matters structurally — it is the separator in the pinned
// "<keyId>:<base64>" serialization, so an ID containing one could forge a
// second entry. The rest of the restriction is log hygiene: key IDs (unlike
// key bytes) are logged, so they must never be able to carry newlines,
// control characters, or unbounded attacker text into a log line.
func ValidManifestKeyID(id string) bool {
	if id == "" || len(id) > maxManifestKeyIDLen {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		switch {
		case c >= 'a' && c <= 'z',
			c >= 'A' && c <= 'Z',
			c >= '0' && c <= '9',
			c == '.', c == '_', c == '-':
		default:
			return false
		}
	}
	return true
}

// validManifestPubKeyB64 reports whether b64 decodes to a raw Ed25519 public
// key of exactly the right size.
func validManifestPubKeyB64(b64 string) bool {
	decoded, err := base64.StdEncoding.DecodeString(b64)
	return err == nil && len(decoded) == ed25519.PublicKeySize
}

// ParsePinnedManifestKeys parses the on-disk pinned entries
// ("<keyId>:<base64-raw-pubkey>") into a keyId → base64 map, RETAINING the ID.
//
// It fails on the first malformed or duplicated entry rather than skipping it.
// A silently skipped entry is how a deployment loses its pin without noticing:
// verification would quietly fall back to whatever other key is trusted (the
// embedded vendor root), which is exactly the substitution this package now
// forbids.
// Error messages identify the offending entry precisely enough for an operator
// to fix it without reading source: the 1-based position in
// pinned_manifest_pub_keys always, plus the keyId once the id itself has been
// validated (an unvalidated id is never echoed — it is control-plane supplied
// and reaches log lines). Key BYTES are never included.
func ParsePinnedManifestKeys(pinned []string) (map[string]string, error) {
	out := make(map[string]string, len(pinned))
	for i, entry := range pinned {
		pos := i + 1
		id, pub, ok := strings.Cut(entry, ":")
		if !ok {
			return nil, fmt.Errorf("pinned_manifest_pub_keys entry #%d is malformed: expected \"<keyId>:<base64>\"", pos)
		}
		if !ValidManifestKeyID(id) {
			return nil, fmt.Errorf("pinned_manifest_pub_keys entry #%d is malformed: key id is empty, over %d characters, or contains characters outside [A-Za-z0-9._-]", pos, maxManifestKeyIDLen)
		}
		if !validManifestPubKeyB64(pub) {
			return nil, fmt.Errorf("pinned_manifest_pub_keys entry #%d (keyId=%s) is malformed: value is not a base64-encoded 32-byte Ed25519 public key", pos, id)
		}
		if _, dup := out[id]; dup {
			return nil, fmt.Errorf("pinned_manifest_pub_keys entry #%d duplicates keyId=%s", pos, id)
		}
		out[id] = pub
	}
	return out, nil
}

// collapseManifestTrustKeys validates a delivered batch and collapses it by
// keyId. Conflicting bytes for the same id inside one delivery is a rotation
// attempt, not an expansion, and is reported as such.
func collapseManifestTrustKeys(keys []ManifestTrustKey) (map[string]string, error) {
	out := make(map[string]string, len(keys))
	for _, k := range keys {
		if !ValidManifestKeyID(k.KeyID) {
			return nil, fmt.Errorf("malformed manifest trust key: invalid key id")
		}
		if !validManifestPubKeyB64(k.PublicKeyB64) {
			return nil, fmt.Errorf("malformed manifest trust key for keyId=%s: not a base64 Ed25519 public key", k.KeyID)
		}
		if prev, ok := out[k.KeyID]; ok && prev != k.PublicKeyB64 {
			return nil, fmt.Errorf("%w for keyId=%s: conflicting pubkeys supplied in one update", ErrManifestTrustRotationRejected, k.KeyID)
		}
		out[k.KeyID] = k.PublicKeyB64
	}
	return out, nil
}

// BootstrapPinnedManifestKeys validates a fresh-trust delivery (enrollment,
// where there is no config file to merge into yet) and returns the serialized
// pinned set to store.
//
// It applies the same rules PinManifestKeys applies to a first bootstrap: every
// entry must be well-formed, and the delivery may establish exactly ONE
// deployment key. Enrollment used to write the response through unvalidated,
// which was both a TOFU bypass (a control plane could seed several keys at
// once) and a way to persist bytes that are not a usable Ed25519 key at all —
// which the updater now treats as an unusable trust set, leaving the agent
// unable to update at all.
//
// An empty delivery returns (nil, nil); callers should leave any existing
// pinned set untouched rather than clearing it.
func BootstrapPinnedManifestKeys(keys []ManifestTrustKey) ([]string, error) {
	if len(keys) == 0 {
		return nil, nil
	}
	collapsed, err := collapseManifestTrustKeys(keys)
	if err != nil {
		return nil, err
	}

	ids := make([]string, 0, len(collapsed))
	for id := range collapsed {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	if len(ids) > 1 {
		return nil, fmt.Errorf("%w: enrollment delivered %d distinct manifest trust keys (%s); trust bootstrap establishes exactly one",
			ErrManifestTrustExpansionRejected, len(ids), strings.Join(ids, ","))
	}
	return []string{ids[0] + ":" + collapsed[ids[0]]}, nil
}

// PinManifestKeys applies the supplied trust keys to the on-disk config at
// cfgPath under frozen TOFU rules:
//
//   - no deployment key pinned yet → accept exactly one valid first key;
//   - same keyId, same bytes → idempotent, no write at all;
//   - same keyId, different bytes → ErrManifestTrustRotationRejected;
//   - any previously unseen keyId (including a second one in the same call)
//     → ErrManifestTrustExpansionRejected.
//
// The embedded LanternOps release root is NOT a deployment-pinned key — it
// lives in the updater package and never appears here — so an agent that has
// only the embedded root still gets its one TOFU bootstrap.
//
// Rejection is atomic with respect to the file: every validation happens
// before SaveTo is reached, so a rejected update leaves agent.yaml
// byte-for-byte unchanged (there is a test for exactly this).
// The whole read-modify-write runs under persistMu (loadLocked + saveToLocked
// rather than Load + SaveTo). Dropping the lock between the two halves would
// let the cert-renewal goroutine's SaveTo land in between and be overwritten by
// the stale snapshot read here — and would leave Load racing viper's maps,
// which is a process-killing throw rather than a lost value.
func PinManifestKeys(cfgPath string, keys []ManifestTrustKey) error {
	if len(keys) == 0 {
		return nil
	}

	persistMu.Lock()
	defer persistMu.Unlock()

	cfg, err := loadLocked(cfgPath)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	existing, err := ParsePinnedManifestKeys(cfg.PinnedManifestPubKeys)
	if err != nil {
		return fmt.Errorf("pinned manifest trust set is unreadable: %w", err)
	}

	incoming, err := collapseManifestTrustKeys(keys)
	if err != nil {
		return err
	}

	var unseen []string
	for id, pub := range incoming {
		cur, known := existing[id]
		if !known {
			unseen = append(unseen, id)
			continue
		}
		if cur != pub {
			return fmt.Errorf("%w for keyId=%s: pinned pubkey differs from new value", ErrManifestTrustRotationRejected, id)
		}
	}

	if len(unseen) == 0 {
		// Every supplied key is already pinned with identical bytes.
		return nil
	}

	// Sorted so the error message (and the bootstrap choice below) does not
	// depend on Go's randomized map iteration order.
	sort.Strings(unseen)

	if len(existing) > 0 || len(unseen) > 1 {
		return fmt.Errorf("%w: refusing to add unseen keyId(s) %s to an already-bootstrapped trust set (pinned=%d)",
			ErrManifestTrustExpansionRejected, strings.Join(unseen, ","), len(existing))
	}

	// First bootstrap: exactly one unseen key and nothing pinned yet.
	id := unseen[0]
	cfg.PinnedManifestPubKeys = []string{id + ":" + incoming[id]}

	return saveToLocked(cfg, cfgPath)
}
