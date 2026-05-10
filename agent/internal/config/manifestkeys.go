package config

import (
	"fmt"
	"strings"
)

// ManifestTrustKey is a per-deployment Ed25519 public key delivered by the
// API via enrollment or heartbeat ack and pinned TOFU-style on the agent.
// The keyId is opaque to the agent; the publicKeyB64 is the raw 32-byte
// Ed25519 public key, base64-encoded.
type ManifestTrustKey struct {
	KeyID        string
	PublicKeyB64 string
}

// PinManifestKeys merges the supplied trust keys into the on-disk config at
// cfgPath. Returns an error if a different pubkey is supplied for an
// already-pinned keyId — TOFU semantics: a server cannot silently rotate a
// key out from under us. The keyset is deduplicated by keyId.
//
// Returns nil if there are no changes (already-known keys), or after a
// successful append + save.
func PinManifestKeys(cfgPath string, keys []ManifestTrustKey) error {
	if len(keys) == 0 {
		return nil
	}

	cfg, err := Load(cfgPath)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	existing := make(map[string]string, len(cfg.PinnedManifestPubKeys))
	for _, entry := range cfg.PinnedManifestPubKeys {
		id, pub, ok := splitPinnedEntry(entry)
		if !ok {
			continue
		}
		existing[id] = pub
	}

	changed := false
	for _, k := range keys {
		if k.KeyID == "" || k.PublicKeyB64 == "" {
			continue
		}
		if cur, ok := existing[k.KeyID]; ok {
			if cur != k.PublicKeyB64 {
				return fmt.Errorf("manifest key rotation rejected for keyId=%s: pinned pubkey differs from new value", k.KeyID)
			}
			continue
		}
		existing[k.KeyID] = k.PublicKeyB64
		changed = true
	}

	if !changed {
		return nil
	}

	pinned := make([]string, 0, len(existing))
	for id, pub := range existing {
		pinned = append(pinned, id+":"+pub)
	}
	cfg.PinnedManifestPubKeys = pinned

	return SaveTo(cfg, cfgPath)
}

// splitPinnedEntry parses a "<keyId>:<base64>" entry into its components.
// Returns ("", "", false) if the entry is malformed.
func splitPinnedEntry(entry string) (string, string, bool) {
	parts := strings.SplitN(entry, ":", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	return parts[0], parts[1], true
}

// PinnedManifestPubKeyBytes returns the decoded raw pubkey bytes for each
// pinned entry that parses cleanly. Used by the updater when assembling the
// trust set for manifest verification.
func PinnedManifestPubKeyBytes(pinned []string) []string {
	out := make([]string, 0, len(pinned))
	for _, entry := range pinned {
		_, pub, ok := splitPinnedEntry(entry)
		if ok {
			out = append(out, pub)
		}
	}
	return out
}
