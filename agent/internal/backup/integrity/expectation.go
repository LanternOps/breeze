// Package integrity checks restored bytes against the integrity expectation
// the server sends with every restore-shaped command and with the recovery
// bootstrap.
//
// The expectation names the snapshot's control objects (manifest, layout
// manifest, system-state manifest) with the SHA-256 and length the server
// holds in its snapshot attestation. In attested mode a helper verifies each
// control object against it before parsing a byte of it, and then requires
// every restored object to match its (now attested) manifest entry exactly.
// Without an expectation (a server that predates it) restores keep their
// earlier checks.
//
// The package depends only on providers, so every restore consumer
// (file restore, VM and database restores, bare-metal recovery and rebuild)
// can share one set of rules.
package integrity

import (
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"regexp"
)

// Expectation modes.
const (
	// ModeAttested: the server holds an attestation for the snapshot; the
	// helper checks every control object and every restored object exactly.
	ModeAttested = "attested"
	// ModeUnattestedOverride: the snapshot has no attestation and a
	// technician confirmed the restore; earlier checks apply, with a warning.
	ModeUnattestedOverride = "unattested_override"
	// ModeUnattested: the snapshot has no attestation (informational); earlier
	// checks apply, with a warning.
	ModeUnattested = "unattested"

	// TrustServerVerified: the server fetched the control objects itself
	// and compared them with the producing helper's statement.
	TrustServerVerified = "server_verified"
	// TrustProducerOnly: a device-local destination the server cannot read;
	// the digests are the producing helper's own statement.
	TrustProducerOnly = "producer_only"

	RoleManifest            = "manifest"
	RoleLayout              = "layout"
	RoleSystemStateManifest = "system_state_manifest"

	// ExpectationVersion is the only expectation format this helper reads.
	ExpectationVersion = 1
)

// ProtocolVersion is the snapshot integrity protocol this build implements
// (backup.IntegrityProtocolVersion, reported by --protocol-info and by the
// recovery client): 1 = produces snapshot attestations and checks an
// incremental's base; 2 = also checks attestations at every restore.
const ProtocolVersion = 2

// Control object key layout under a snapshot. Mirrors the backup package's
// snapshotRootDir/snapshotManifestKey/layoutManifestKey/systemStateDir
// constants (a backup package test asserts they agree).
const (
	snapshotRootDir        = "snapshots"
	manifestName           = "manifest.json"
	layoutName             = "layout.json"
	systemStateDirName     = "system-state"
	systemStateManifestKey = "manifest.json"
)

var (
	// ErrInvalidExpectation wraps every reason an expectation block is
	// refused. A refused block fails the command: the helper never guesses.
	ErrInvalidExpectation = errors.New("backup integrity: invalid integrity expectation")
	// ErrObjectNotAttested: attested mode, but the expectation carries no
	// digest for a control object the restore needs.
	ErrObjectNotAttested = errors.New("backup integrity: control object is not in the snapshot attestation")

	snapshotIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`)
	sha256Pattern     = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// maxObjectSize mirrors the attestation's size bound (Number.MAX_SAFE_INTEGER).
const maxObjectSize = 1<<53 - 1

// Object is one attested control object.
type Object struct {
	Role   string `json:"role"`
	Key    string `json:"key"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// Expectation is the `integrity` block of a restore command or recovery
// bootstrap. A nil *Expectation means "absent" and every method is nil-safe.
type Expectation struct {
	V               int      `json:"v"`
	Mode            string   `json:"mode"`
	Trust           string   `json:"trust,omitempty"`
	SnapshotID      string   `json:"snapshotId"`
	Objects         []Object `json:"objects,omitempty"`
	AuthorizationID string   `json:"authorizationId,omitempty"`
	Reason          string   `json:"reason,omitempty"`
}

// FromPayload reads the `integrity` field of a command payload. It returns
// (nil, nil) when the payload has none.
func FromPayload(payload json.RawMessage) (*Expectation, error) {
	if len(payload) == 0 {
		return nil, nil
	}
	var p struct {
		Integrity json.RawMessage `json:"integrity"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return nil, fmt.Errorf("%w: decode payload: %v", ErrInvalidExpectation, err)
	}
	return Parse(p.Integrity)
}

// Parse validates an integrity block. It returns (nil, nil) for an absent or
// JSON-null block and an error wrapping ErrInvalidExpectation for anything it
// cannot fully understand: an unknown version or mode, an attested block
// without a manifest digest, or an object key that is not its role's control
// key under the snapshot.
func Parse(raw json.RawMessage) (*Expectation, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var e Expectation
	if err := json.Unmarshal(raw, &e); err != nil {
		return nil, fmt.Errorf("%w: decode: %v", ErrInvalidExpectation, err)
	}
	if e.V != ExpectationVersion {
		return nil, fmt.Errorf("%w: unsupported version %d", ErrInvalidExpectation, e.V)
	}
	if !snapshotIDPattern.MatchString(e.SnapshotID) {
		return nil, fmt.Errorf("%w: snapshot id %q is not a valid snapshot id", ErrInvalidExpectation, e.SnapshotID)
	}
	switch e.Mode {
	case ModeUnattested, ModeUnattestedOverride:
		return &e, nil
	case ModeAttested:
	default:
		return nil, fmt.Errorf("%w: unknown mode %q", ErrInvalidExpectation, e.Mode)
	}
	if e.Trust != TrustServerVerified && e.Trust != TrustProducerOnly {
		return nil, fmt.Errorf("%w: unknown trust %q", ErrInvalidExpectation, e.Trust)
	}
	seen := make(map[string]bool, len(e.Objects))
	for _, o := range e.Objects {
		want, err := ControlObjectKey(e.SnapshotID, o.Role)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidExpectation, err)
		}
		if seen[o.Role] {
			return nil, fmt.Errorf("%w: duplicate control object role %q", ErrInvalidExpectation, o.Role)
		}
		seen[o.Role] = true
		if o.Key != want {
			return nil, fmt.Errorf("%w: control object key %q does not match role %q (want %q)", ErrInvalidExpectation, o.Key, o.Role, want)
		}
		if !sha256Pattern.MatchString(o.SHA256) {
			return nil, fmt.Errorf("%w: control object %q digest is not lowercase hex SHA-256", ErrInvalidExpectation, o.Role)
		}
		if o.Size < 0 || o.Size > maxObjectSize {
			return nil, fmt.Errorf("%w: control object %q size %d out of range", ErrInvalidExpectation, o.Role, o.Size)
		}
	}
	if !seen[RoleManifest] {
		return nil, fmt.Errorf("%w: attested expectation has no manifest object", ErrInvalidExpectation)
	}
	return &e, nil
}

// Present reports whether an expectation was delivered at all.
func (e *Expectation) Present() bool { return e != nil }

// Attested reports whether restored bytes must match the attestation exactly.
func (e *Expectation) Attested() bool { return e != nil && e.Mode == ModeAttested }

// Object returns the attested control object for role.
func (e *Expectation) Object(role string) (Object, bool) {
	if e == nil {
		return Object{}, false
	}
	for _, o := range e.Objects {
		if o.Role == role {
			return o, true
		}
	}
	return Object{}, false
}

// CheckSnapshot refuses an expectation issued for another snapshot than the
// one the command restores. An absent expectation checks nothing.
func (e *Expectation) CheckSnapshot(snapshotID string) error {
	if e == nil {
		return nil
	}
	if e.SnapshotID != snapshotID {
		return fmt.Errorf("%w: expectation is for snapshot %q, the restore is of %q", ErrInvalidExpectation, e.SnapshotID, snapshotID)
	}
	return nil
}

// UnattestedWarning is the result warning for a restore of a snapshot that
// has no attestation (override or informational mode). "" for attested mode
// and for an absent expectation.
func (e *Expectation) UnattestedWarning() string {
	if e == nil || e.Attested() {
		return ""
	}
	return UnattestedRestoreWarning
}

// UnattestedRestoreWarning labels a result whose bytes were not checked
// against a snapshot attestation.
const UnattestedRestoreWarning = "restored from an unattested snapshot: files were not checked against a snapshot attestation"

// ControlObjectKey returns the object key of a snapshot's control object.
func ControlObjectKey(snapshotID, role string) (string, error) {
	switch role {
	case RoleManifest:
		return path.Join(snapshotRootDir, snapshotID, manifestName), nil
	case RoleLayout:
		return path.Join(snapshotRootDir, snapshotID, layoutName), nil
	case RoleSystemStateManifest:
		return path.Join(snapshotRootDir, snapshotID, systemStateDirName, systemStateManifestKey), nil
	default:
		return "", fmt.Errorf("unknown control object role %q", role)
	}
}
