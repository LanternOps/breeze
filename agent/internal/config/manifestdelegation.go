package config

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ErrManifestDelegationRejected is returned whenever a signed manifest key
// delegation is not accepted, for ANY reason. Callers treat it as one
// security-relevant outcome; the wrapped message says which rule failed.
//
// Every rejection is atomic with respect to the config file: validation
// completes before SaveTo is reached, so a rejected delegation leaves
// agent.yaml byte-for-byte unchanged and never advances the epoch.
var ErrManifestDelegationRejected = errors.New("manifest key delegation rejected")

// ErrManifestDelegationAlreadyAdopted means the delegation asks for a trust
// state this agent is ALREADY in: the exact key id it delegates to is pinned
// with the exact bytes it names. Applying it would change nothing.
//
// This is deliberately NOT an ErrManifestDelegationRejected. The server keeps
// delivering an in-window record for the whole window so stragglers can still
// adopt, which means every agent that has already adopted receives the same
// record again on its very next heartbeat — and every device enrolled after
// `activate` receives one whose oldKeyId it never had. Both are completely
// routine. Reporting them as security events would emit one SECURITY-level
// error per agent per rotation across the entire fleet, which is exactly the
// signal degradation that makes such an alert worthless when a genuinely
// hostile control plane does show up. Callers log this at debug.
var ErrManifestDelegationAlreadyAdopted = errors.New("manifest key delegation already adopted")

// manifestDelegationDomain is line 1 of the canonical signing payload.
//
// It is a domain separator: without it, a signature over a delegation could
// in principle be replayed as a signature over some other structure signed
// by the same key. Update manifests are JSON objects starting with '{', so
// the two payload spaces cannot collide.
const manifestDelegationDomain = "breeze-manifest-key-delegation-v1"

// manifestDelegationSchemaVersion is the only wire schema this agent accepts.
// An unknown version fails closed rather than being interpreted optimistically
// — a future version may add fields that CHANGE the meaning of the ones we
// understand.
const manifestDelegationSchemaVersion = 1

// manifestDelegationClockSkew is how far the agent's clock may disagree with
// the control plane's before a delegation is refused on timing alone.
//
// The allowance WIDENS the validity window at BOTH ends: a delegation is
// accepted from (notBefore - skew) through (notAfter + skew). That covers an
// agent clock running up to five minutes slow (it would otherwise consider a
// freshly-issued record "not yet valid") and up to five minutes fast (it
// would otherwise consider a still-live record expired). Machines with badly
// wrong clocks simply do not adopt, which is the safe direction: the fleet
// adoption gate catches them before anything is activated.
const manifestDelegationClockSkew = 5 * time.Minute

// ManifestKeyDelegation is the signed, monotonic, time-bounded authorisation
// to add ONE previously unseen manifest signing key to the pinned trust set.
//
// Wave 6 Task 6 froze trust-on-first-use: once a deployment key is pinned,
// any unseen key offered over the wire is rejected outright. This record is
// the sole exception, and only because it carries a signature made by the key
// that is ALREADY trusted. A control plane with API/database write access but
// no signing private key cannot produce one.
type ManifestKeyDelegation struct {
	SchemaVersion   int
	OldKeyID        string
	NewKeyID        string
	NewPublicKeyB64 string
	Epoch           uint64
	NotBefore       string
	NotAfter        string
	SignatureBase64 string
}

// ManifestDelegationCanonicalBytes returns the EXACT bytes covered by the
// signature:
//
//	line 1  breeze-manifest-key-delegation-v1
//	line 2  <old key ID>
//	line 3  <new key ID>
//	line 4  <new public key base64>
//	line 5  <unsigned decimal epoch>
//	line 6  <UTC RFC3339 not-before>
//	line 7  <UTC RFC3339 not-after>
//
// UTF-8, LF-separated, NO trailing newline. This is a wire contract with the
// API's manifestDelegationCanonicalBytes (apps/api/src/services/
// manifestSigning.ts). A one-byte difference — a trailing newline included —
// makes every delegation unverifiable fleet-wide while each side looks
// correct in isolation, so both sides pin the same SHA-256 over the same
// golden fixture in their tests.
//
// The timestamps are used VERBATIM as received. Reformatting them here would
// mean signing bytes the server never produced.
func ManifestDelegationCanonicalBytes(d ManifestKeyDelegation) ([]byte, error) {
	lines := []string{
		manifestDelegationDomain,
		d.OldKeyID,
		d.NewKeyID,
		d.NewPublicKeyB64,
		strconv.FormatUint(d.Epoch, 10),
		d.NotBefore,
		d.NotAfter,
	}

	// A field carrying the line separator could shift the meaning of every
	// later line while still producing bytes that verify — one signature
	// standing for two different delegations. Reject rather than escape: no
	// legitimate value contains a newline.
	for i, line := range lines {
		if strings.ContainsAny(line, "\r\n") {
			return nil, fmt.Errorf("manifest delegation field #%d contains a newline", i+1)
		}
	}

	return []byte(strings.Join(lines, "\n")), nil
}

// ApplyManifestKeyDelegation validates a delegation against the on-disk trust
// state and, only if ALL of the following hold, adds the new key and records
// the epoch in ONE SaveTo:
//
//  1. the old key ID is currently trusted (present in the pinned set);
//  2. the signature verifies with EXACTLY that key;
//  3. the new key ID is unseen (not already pinned);
//  4. the epoch is STRICTLY greater than the persisted epoch;
//  5. local time is inside the validity window, ±5 minutes of clock skew;
//  6. the new public key is exactly 32 bytes once decoded.
//
// The old key is deliberately RETAINED rather than replaced. The server does
// not begin signing with the new key until an operator runs `activate`, which
// happens only after the fleet has adopted — dropping the old key on adoption
// would break manifest verification for the entire adoption window.
// Like PinManifestKeys, the config read-modify-write runs under persistMu
// (loadLocked + saveToLocked). The epoch monotonicity check in particular is
// only meaningful if nothing can write the config between reading the adopted
// epoch and persisting the new one.
func ApplyManifestKeyDelegation(cfgPath string, d ManifestKeyDelegation, now time.Time) error {
	if d.SchemaVersion != manifestDelegationSchemaVersion {
		return fmt.Errorf("%w: unsupported schemaVersion %d (this agent understands %d)",
			ErrManifestDelegationRejected, d.SchemaVersion, manifestDelegationSchemaVersion)
	}

	// --- Structural validation (no config read needed) ---
	if !ValidManifestKeyID(d.OldKeyID) {
		return fmt.Errorf("%w: old key id is malformed", ErrManifestDelegationRejected)
	}
	if !ValidManifestKeyID(d.NewKeyID) {
		return fmt.Errorf("%w: new key id is malformed", ErrManifestDelegationRejected)
	}

	// Length is checked AFTER decoding — a base64 string of the "right"
	// visual length can decode to any number of bytes.
	newPubRaw, err := base64.StdEncoding.DecodeString(d.NewPublicKeyB64)
	if err != nil || len(newPubRaw) != ed25519.PublicKeySize {
		return fmt.Errorf("%w for newKeyId=%s: new public key is not a base64-encoded %d-byte Ed25519 public key",
			ErrManifestDelegationRejected, d.NewKeyID, ed25519.PublicKeySize)
	}

	signature, err := base64.StdEncoding.DecodeString(d.SignatureBase64)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return fmt.Errorf("%w for newKeyId=%s: signature is not a base64-encoded %d-byte Ed25519 signature",
			ErrManifestDelegationRejected, d.NewKeyID, ed25519.SignatureSize)
	}

	// --- Trust state, read BEFORE any rejection branch ---
	//
	// The already-adopted short-circuit below has to come before the window
	// and trust checks: an agent can legitimately receive a re-delivered
	// record that has just expired (the window closes between the server's
	// query and the agent's clock), and a post-activation enrollee's copy
	// names an oldKeyId it never had. Neither is an attack.
	// Locked here, not earlier: every check above is pure structural
	// validation on the record itself and touches no shared state, so the lock
	// is held only for the config read-modify-write.
	persistMu.Lock()
	defer persistMu.Unlock()

	cfg, err := loadLocked(cfgPath)
	if err != nil {
		return fmt.Errorf("%w: load config: %v", ErrManifestDelegationRejected, err)
	}

	pinned, err := ParsePinnedManifestKeys(cfg.PinnedManifestPubKeys)
	if err != nil {
		return fmt.Errorf("%w: pinned manifest trust set is unreadable: %v",
			ErrManifestDelegationRejected, err)
	}

	// Already in the requested state? Only when the id AND the bytes match
	// what is pinned. A record naming an ALREADY-PINNED id with DIFFERENT
	// bytes is an attempt to swap the key behind an established id — that
	// stays a hard rejection and a SECURITY line.
	if current, seen := pinned[d.NewKeyID]; seen && current == d.NewPublicKeyB64 {
		return fmt.Errorf("%w: newKeyId=%s is already pinned with these bytes (epoch %d, adopted epoch %d)",
			ErrManifestDelegationAlreadyAdopted, d.NewKeyID, d.Epoch, cfg.ManifestDelegationEpoch)
	}

	notBefore, err := parseDelegationTime(d.NotBefore)
	if err != nil {
		return fmt.Errorf("%w for newKeyId=%s: notBefore is invalid: %v",
			ErrManifestDelegationRejected, d.NewKeyID, err)
	}
	notAfter, err := parseDelegationTime(d.NotAfter)
	if err != nil {
		return fmt.Errorf("%w for newKeyId=%s: notAfter is invalid: %v",
			ErrManifestDelegationRejected, d.NewKeyID, err)
	}
	if !notAfter.After(notBefore) {
		return fmt.Errorf("%w for newKeyId=%s: validity window is empty or inverted",
			ErrManifestDelegationRejected, d.NewKeyID)
	}

	// Condition 5. The skew allowance widens the window at both ends.
	if now.Before(notBefore.Add(-manifestDelegationClockSkew)) {
		return fmt.Errorf("%w for newKeyId=%s: not yet valid (notBefore=%s, local time is earlier by more than the %s skew allowance)",
			ErrManifestDelegationRejected, d.NewKeyID, d.NotBefore, manifestDelegationClockSkew)
	}
	if now.After(notAfter.Add(manifestDelegationClockSkew)) {
		return fmt.Errorf("%w for newKeyId=%s: expired (notAfter=%s, local time is later by more than the %s skew allowance)",
			ErrManifestDelegationRejected, d.NewKeyID, d.NotAfter, manifestDelegationClockSkew)
	}

	// Condition 1. Note this also means a delegation can NEVER bootstrap
	// trust: with an empty pinned set there is no key that could have
	// authorised it, so a hostile control plane cannot use a delegation to
	// skip trust-on-first-use.
	oldPubB64, trusted := pinned[d.OldKeyID]
	if !trusted {
		return fmt.Errorf("%w: oldKeyId=%s is not currently trusted (pinned=%d)",
			ErrManifestDelegationRejected, d.OldKeyID, len(pinned))
	}

	// Condition 3.
	if _, seen := pinned[d.NewKeyID]; seen {
		return fmt.Errorf("%w: newKeyId=%s is already pinned — a delegation may only introduce an unseen key",
			ErrManifestDelegationRejected, d.NewKeyID)
	}

	// Condition 4. EQUAL is a replay, not a no-op: accepting it would let the
	// same record be re-adopted forever.
	if d.Epoch <= cfg.ManifestDelegationEpoch {
		return fmt.Errorf("%w for newKeyId=%s: epoch %d is not greater than the adopted epoch %d (replay or rollback)",
			ErrManifestDelegationRejected, d.NewKeyID, d.Epoch, cfg.ManifestDelegationEpoch)
	}

	// Condition 2 + 6. Verify against EXACTLY the named old key — never
	// "try every trusted key", which is the substitution Task 6 removed.
	oldPubRaw, err := base64.StdEncoding.DecodeString(oldPubB64)
	if err != nil || len(oldPubRaw) != ed25519.PublicKeySize {
		return fmt.Errorf("%w: pinned key oldKeyId=%s is not a usable Ed25519 public key",
			ErrManifestDelegationRejected, d.OldKeyID)
	}

	payload, err := ManifestDelegationCanonicalBytes(d)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrManifestDelegationRejected, err)
	}
	if !ed25519.Verify(ed25519.PublicKey(oldPubRaw), payload, signature) {
		return fmt.Errorf("%w for newKeyId=%s: signature does not verify with oldKeyId=%s",
			ErrManifestDelegationRejected, d.NewKeyID, d.OldKeyID)
	}

	// --- Accepted. Persist the new key AND the epoch in ONE SaveTo. ---
	//
	// They must land together. Key without epoch would leave the very same
	// record adoptable again forever; epoch without key would burn the epoch
	// without gaining the trust, stranding the agent on the next rotation.
	pinned[d.NewKeyID] = d.NewPublicKeyB64
	cfg.PinnedManifestPubKeys = serializePinnedManifestKeys(pinned)
	cfg.ManifestDelegationEpoch = d.Epoch

	return saveToLocked(cfg, cfgPath)
}

// serializePinnedManifestKeys renders the trust set as sorted
// "<keyId>:<base64>" entries. Sorted so repeated writes are byte-stable
// regardless of Go's randomized map iteration order (#644).
func serializePinnedManifestKeys(pinned map[string]string) []string {
	ids := make([]string, 0, len(pinned))
	for id := range pinned {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	out := make([]string, 0, len(ids))
	for _, id := range ids {
		out = append(out, id+":"+pinned[id])
	}
	return out
}

// parseDelegationTime accepts ONLY canonical UTC RFC3339 with a literal 'Z',
// which is exactly what the API emits (delegationTimestamp).
//
// Offset forms like "+00:00" are rejected even though they denote the same
// instant: the timestamp string is part of the SIGNED payload, so accepting
// an alternative spelling would mean accepting bytes that could not have been
// produced by the signer anyway. Rejecting here gives a precise error instead
// of an opaque signature failure.
func parseDelegationTime(value string) (time.Time, error) {
	if !strings.HasSuffix(value, "Z") {
		return time.Time{}, fmt.Errorf("must be UTC RFC3339 ending in 'Z'")
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("not a valid RFC3339 timestamp")
	}
	return parsed.UTC(), nil
}
