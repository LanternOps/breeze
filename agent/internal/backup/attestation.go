package backup

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"regexp"
	"sort"
)

// Snapshot attestation statement, format 1.
//
// A helper that implements integrity protocol 1 reports, with its terminal
// backup result, a canonical JSON statement over the exact bytes it uploaded
// for the snapshot's control objects (the manifest, the layout manifest and
// the system-state manifest). The API stores the statement verbatim, hashes
// those bytes, binds it to its own records and, for destinations it can read,
// fetches the objects itself and compares.
//
// The byte format is shared with apps/api/src/services/backupAttestation.ts
// through testdata/attestation-vectors.json, which both test suites read:
//   - keys exactly v, snapshotId, jobId, agentId, dispatchedBaseSnapshotId,
//     parentSnapshotId, keyLayout, objects (and per object role, key, sha256,
//     size), in that order, with no insignificant whitespace;
//   - objects sorted by role, one per role, the manifest always present, each
//     key equal to that role's control key under the snapshot;
//   - parentSnapshotId null (a full run, including one that fell back from a
//     dispatched base) or equal to dispatchedBaseSnapshotId;
//   - string fields printable ASCII without '"', '\', '<', '>' or '&', which
//     no JSON encoder escapes, so every implementation emits the same bytes.
const (
	AttestationFormatVersion       = 1
	AttestationKeyLayoutLegacyFlat = "legacy_flat"

	AttestationRoleLayout              = "layout"
	AttestationRoleManifest            = "manifest"
	AttestationRoleSystemStateManifest = "system_state_manifest"

	// attestationMaxBytes mirrors the API's SNAPSHOT_ATTESTATION_MAX_BYTES.
	attestationMaxBytes = 16 * 1024
	// attestationMaxSize mirrors the API's size bound (Number.MAX_SAFE_INTEGER).
	attestationMaxSize = 1<<53 - 1
)

// PublishedObject describes one control object exactly as it was uploaded:
// its role in the snapshot, its object key, and the SHA-256 and length of the
// bytes the upload sent (see uploadWithDigest). Field order is the statement's
// canonical per-object key order.
type PublishedObject struct {
	Role   string `json:"role"`
	Key    string `json:"key"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// AttestationStatement is the statement's content. Field order is the
// canonical key order; EncodeAttestationStatement relies on it.
type AttestationStatement struct {
	V                        int               `json:"v"`
	SnapshotID               string            `json:"snapshotId"`
	JobID                    string            `json:"jobId"`
	AgentID                  string            `json:"agentId"`
	DispatchedBaseSnapshotID *string           `json:"dispatchedBaseSnapshotId"`
	ParentSnapshotID         *string           `json:"parentSnapshotId"`
	KeyLayout                string            `json:"keyLayout"`
	Objects                  []PublishedObject `json:"objects"`
}

// AttestationEnvelope is the `attestation` field of a backup result.
type AttestationEnvelope struct {
	Statement string `json:"statement"`
}

var (
	// Mirrors the API's SNAPSHOT_ID_PATTERN (BACKUP_SNAPSHOT_ID_MAX_LENGTH = 200).
	attestationSnapshotIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`)
	// Mirrors the API's PLAIN_ASCII_PATTERN.
	attestationPlainASCIIPattern = regexp.MustCompile(`^[\x20\x21\x23-\x25\x27-\x3b\x3d\x3f-\x5b\x5d-\x7e]{1,256}$`)
	attestationSHA256Pattern     = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

var attestationRoleOrder = map[string]int{
	AttestationRoleLayout:              0,
	AttestationRoleManifest:            1,
	AttestationRoleSystemStateManifest: 2,
}

// ControlObjectKey returns the object key of a snapshot's control object for
// role. It mirrors the API's expectedControlKey.
func ControlObjectKey(snapshotID, role string) (string, error) {
	switch role {
	case AttestationRoleManifest:
		return path.Join(snapshotRootDir, snapshotID, snapshotManifestKey), nil
	case AttestationRoleLayout:
		return path.Join(snapshotRootDir, snapshotID, layoutManifestKey), nil
	case AttestationRoleSystemStateManifest:
		return path.Join(snapshotRootDir, snapshotID, systemStateDir, systemStateManifestKey), nil
	default:
		return "", fmt.Errorf("unknown control object role %q", role)
	}
}

// StatementSHA256 is the lowercase-hex SHA-256 of a statement's bytes, the
// value the API records as statement_sha256.
func StatementSHA256(statement string) string {
	sum := sha256.Sum256([]byte(statement))
	return hex.EncodeToString(sum[:])
}

// EncodeAttestationStatement validates s and returns its canonical encoding.
// Objects are sorted by role on a copy; s is not modified. Any statement the
// API would refuse is refused here instead, so a helper never reports one.
func EncodeAttestationStatement(s AttestationStatement) (string, error) {
	if s.V != AttestationFormatVersion {
		return "", fmt.Errorf("unsupported attestation format version %d", s.V)
	}
	if s.KeyLayout != AttestationKeyLayoutLegacyFlat {
		return "", fmt.Errorf("unsupported key layout %q", s.KeyLayout)
	}
	if !attestationSnapshotIDPattern.MatchString(s.SnapshotID) {
		return "", fmt.Errorf("snapshot id %q is not a valid statement snapshot id", s.SnapshotID)
	}
	if !attestationPlainASCIIPattern.MatchString(s.JobID) {
		return "", errors.New("job id is empty, too long or contains characters a statement cannot carry")
	}
	if !attestationPlainASCIIPattern.MatchString(s.AgentID) {
		return "", errors.New("agent id is empty, too long or contains characters a statement cannot carry")
	}
	for _, id := range []*string{s.DispatchedBaseSnapshotID, s.ParentSnapshotID} {
		if id != nil && !attestationSnapshotIDPattern.MatchString(*id) {
			return "", fmt.Errorf("base snapshot id %q is not a valid statement snapshot id", *id)
		}
	}
	if s.ParentSnapshotID != nil && (s.DispatchedBaseSnapshotID == nil || *s.ParentSnapshotID != *s.DispatchedBaseSnapshotID) {
		return "", errors.New("parent snapshot is not the dispatched base")
	}
	if len(s.Objects) == 0 || len(s.Objects) > len(attestationRoleOrder) {
		return "", fmt.Errorf("statement must carry 1..%d control objects, got %d", len(attestationRoleOrder), len(s.Objects))
	}

	objects := append([]PublishedObject(nil), s.Objects...)
	seen := make(map[string]bool, len(objects))
	for _, o := range objects {
		if _, known := attestationRoleOrder[o.Role]; !known {
			return "", fmt.Errorf("unknown control object role %q", o.Role)
		}
		if seen[o.Role] {
			return "", fmt.Errorf("duplicate control object role %q", o.Role)
		}
		seen[o.Role] = true
		want, _ := ControlObjectKey(s.SnapshotID, o.Role)
		if o.Key != want {
			return "", fmt.Errorf("control object key %q does not match role %q (want %q)", o.Key, o.Role, want)
		}
		if !attestationSHA256Pattern.MatchString(o.SHA256) {
			return "", fmt.Errorf("control object %q digest is not lowercase hex SHA-256", o.Role)
		}
		if o.Size < 0 || o.Size > attestationMaxSize {
			return "", fmt.Errorf("control object %q size %d out of range", o.Role, o.Size)
		}
	}
	if !seen[AttestationRoleManifest] {
		return "", errors.New("statement has no manifest object")
	}
	sort.Slice(objects, func(i, j int) bool {
		return attestationRoleOrder[objects[i].Role] < attestationRoleOrder[objects[j].Role]
	})
	s.Objects = objects

	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	// Validation above already excludes every character the default encoder
	// would escape; turning escaping off keeps the two guarantees independent.
	enc.SetEscapeHTML(false)
	if err := enc.Encode(s); err != nil {
		return "", fmt.Errorf("encode attestation statement: %w", err)
	}
	out := bytes.TrimSuffix(buf.Bytes(), []byte("\n"))
	if len(out) > attestationMaxBytes {
		return "", fmt.Errorf("attestation statement is %d bytes, over the %d byte limit", len(out), attestationMaxBytes)
	}
	return string(out), nil
}
