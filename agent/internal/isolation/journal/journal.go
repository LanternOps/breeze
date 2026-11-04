// Package journal is the durable record of a network-isolation episode on
// this device (#10088, plan "Go journal"): <dataDir>/isolation.json, fsynced,
// owner-only (SYSTEM/Administrators on Windows), replaced atomically.
//
// Both the agent's isolation manager and the separately installed
// breeze-isolation-recovery binary read and write it, so this package must
// stay small: it imports nothing from heartbeat, config or updater (a broken
// or half-upgraded agent must not be able to break recovery).
//
// It is deliberately a separate file from the agent's lifecycle state file,
// which the watchdog polls.
//
// Every mutation of the journal (and of the firewall rules it describes)
// happens under the machine-wide lock at <dataDir>/isolation.lock (Lock).
package journal

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/breeze-rmm/agent/internal/atomicrename"
)

const (
	// SchemaVersion is the only version this build reads or writes. A file
	// with any other version is ErrUnknownSchema: the caller deletes every
	// Breeze-owned rule rather than guess at its meaning.
	SchemaVersion = 1
	// FileName is the journal's name inside the agent data directory.
	FileName = "isolation.json"
	// LockName is the machine-wide lock's name inside the data directory.
	LockName = "isolation.lock"
	// MaxEvents bounds the local event log; Save keeps the newest entries.
	// It matches the server's per-report cap (NETWORK_ISOLATION_LIMITS
	// .maxReportEvents) so a report can always carry every retained event.
	MaxEvents = 200
	// maxFileBytes refuses to parse an implausibly large journal.
	maxFileBytes = 4 << 20
)

var (
	// ErrNotFound: there is no journal file.
	ErrNotFound = errors.New("isolation journal not found")
	// ErrCorrupt: the file exists but is not a readable journal (truncated,
	// not JSON, or carrying a phase this build does not recognise).
	ErrCorrupt = errors.New("isolation journal is corrupt")
	// ErrUnknownSchema: the file is JSON but its schemaVersion is not
	// SchemaVersion.
	ErrUnknownSchema = errors.New("isolation journal has an unknown schema version")
)

// Phase is where the local apply/release protocol stands. It is reported to
// the server verbatim (ISOLATION_JOURNAL_PHASES in packages/shared).
type Phase string

const (
	PhaseNone        Phase = "none"
	PhaseProvisional Phase = "provisional"
	PhaseCommitted   Phase = "committed"
	PhaseReleasing   Phase = "releasing"
	PhaseReleased    Phase = "released"
	PhaseRolledBack  Phase = "rolled_back"
)

// Valid reports whether p is one of the six phases.
func (p Phase) Valid() bool {
	switch p {
	case PhaseNone, PhaseProvisional, PhaseCommitted, PhaseReleasing, PhaseReleased, PhaseRolledBack:
		return true
	}
	return false
}

// AllowEntry is one permit of the server-built allowlist. Its JSON shape is
// isolationAllowEntrySchema (packages/shared/src/validators/networkIsolation.ts):
// a `host` entry carries no `cidr` key and a `cidr` entry no `host` key.
type AllowEntry struct {
	Kind  string   `json:"kind"`
	Host  string   `json:"host,omitempty"`
	CIDR  string   `json:"cidr,omitempty"`
	Proto string   `json:"proto"`
	Ports []uint16 `json:"ports"`
	Scope string   `json:"scope"`
}

// EpisodeRecord is the episode this device holds or last held.
type EpisodeRecord struct {
	IsolationID    string       `json:"isolationId"`
	Generation     int          `json:"generation"`
	ExpiresAt      time.Time    `json:"expiresAt"`
	DeadManSeconds int          `json:"deadManSeconds"`
	RemoteRelay    bool         `json:"remoteRelay"`
	Allow          []AllowEntry `json:"allow"`
	// BreakGlassSecret is the per-episode 32-byte secret behind the offline
	// release code. Never logged.
	BreakGlassSecret []byte `json:"breakGlassSecret,omitempty"`
	// Resolved is the last-known-good address set per allowlist host (and
	// the proxy host), as installed.
	Resolved map[string][]string `json:"resolved,omitempty"`
	// Proxy is the permit added for the transport's effective proxy, if any.
	Proxy *AllowEntry `json:"proxy,omitempty"`
	// RuleDigest is the digest the isolator returned for the installed rules.
	RuleDigest     string    `json:"ruleDigest,omitempty"`
	Mechanism      string    `json:"mechanism,omitempty"`
	AppliedAt      time.Time `json:"appliedAt,omitzero"`
	LastVerifiedAt time.Time `json:"lastVerifiedAt,omitzero"`
	LastError      string    `json:"lastError,omitempty"`
	// State is the episode state this device reports (AGENT_REPORTABLE_STATES).
	State string `json:"state,omitempty"`
	// FailureCode is set with State "failed" (the outcome only).
	FailureCode string `json:"failureCode,omitempty"`
	// RollbackCode is set while phase is releasing because an uncommitted
	// apply is being undone: the failure the rollback will report. Empty for
	// a release. The recovery binary reads it to tell the two apart.
	RollbackCode string `json:"rollbackCode,omitempty"`
	// ReleaseKind is set once a release has been decided.
	ReleaseKind string `json:"releaseKind,omitempty"`
}

// Event is one entry of the append-only local event log, reported to the
// server (isolationJournalEventSchema). Seq is strictly increasing.
type Event struct {
	Seq         int64     `json:"seq"`
	At          time.Time `json:"at"`
	Type        string    `json:"type"`
	IsolationID string    `json:"isolationId,omitempty"`
	Generation  int       `json:"generation,omitempty"`
	Detail      string    `json:"detail,omitempty"`
}

// TerminalReceipt is the durable record of how an episode ended, kept until
// the server stops asserting that episode so the outcome is reported even
// across restarts.
type TerminalReceipt struct {
	IsolationID string    `json:"isolationId"`
	Generation  int       `json:"generation"`
	State       string    `json:"state"`
	Kind        string    `json:"kind,omitempty"`
	FailureCode string    `json:"failureCode,omitempty"`
	At          time.Time `json:"at"`
	JournalSeq  int64     `json:"journalSeq"`
}

// Journal is the whole file.
type Journal struct {
	SchemaVersion int            `json:"schemaVersion"`
	Episode       *EpisodeRecord `json:"episode,omitempty"`
	Phase         Phase          `json:"phase"`
	// AttemptID names the apply (or refresh) in flight; a worker re-checks
	// it under the lock before it commits.
	AttemptID           string    `json:"attemptId,omitempty"`
	ProvisionalDeadline time.Time `json:"provisionalDeadline,omitzero"`
	// AttemptBootID and AttemptMono let an overdue provisional apply be
	// detected without trusting the wall clock. Every *Mono field is the
	// Clock.Mono reading in nanoseconds, comparable only within one boot.
	AttemptBootID string `json:"attemptBootId,omitempty"`
	AttemptMono   int64  `json:"attemptMono,omitempty"`
	// AppliedAtWall / AppliedAtMono / BootID anchor the monotonic expiry
	// clause (plan "Clock rule"); AppliedAtMono is only meaningful while the
	// running boot's ID equals BootID.
	AppliedAtWall time.Time `json:"appliedAtWall,omitzero"`
	AppliedAtMono int64     `json:"appliedAtMono,omitempty"`
	BootID        string    `json:"bootId,omitempty"`
	// HighWaterWall is the largest wall time journalled by the agent or
	// recovery, or taken from a server Date header.
	HighWaterWall      time.Time        `json:"highWaterWall,omitzero"`
	Events             []Event          `json:"events,omitempty"`
	NextSeq            int64            `json:"nextSeq"`
	BreakGlassAttempts []time.Time      `json:"breakGlassAttempts,omitempty"`
	SecretAckSeq       int64            `json:"secretAckSeq,omitempty"`
	RecoveryPath       string           `json:"recoveryPath,omitempty"`
	PendingReport      *TerminalReceipt `json:"pendingReport,omitempty"`
}

// New returns an empty journal at the current schema.
func New() *Journal {
	return &Journal{SchemaVersion: SchemaVersion, Phase: PhaseNone, NextSeq: 1}
}

// Path returns the journal path inside dataDir.
func Path(dataDir string) string { return filepath.Join(dataDir, FileName) }

// Append records an event with the next sequence number and returns it.
func (j *Journal) Append(at time.Time, typ, isolationID string, generation int, detail string) int64 {
	if j.NextSeq < 1 {
		j.NextSeq = 1
	}
	seq := j.NextSeq
	j.NextSeq++
	j.Events = append(j.Events, Event{Seq: seq, At: at.UTC(), Type: typ, IsolationID: isolationID, Generation: generation, Detail: detail})
	if over := len(j.Events) - MaxEvents; over > 0 {
		j.Events = append([]Event(nil), j.Events[over:]...)
	}
	return seq
}

// LastSeq is the sequence number of the newest event, or 0.
func (j *Journal) LastSeq() int64 {
	if j.NextSeq <= 1 {
		return 0
	}
	return j.NextSeq - 1
}

// Clone returns a deep copy.
func (j *Journal) Clone() *Journal {
	if j == nil {
		return nil
	}
	data, err := json.Marshal(j)
	if err != nil {
		panic(fmt.Sprintf("journal: clone marshal: %v", err))
	}
	var out Journal
	if err := json.Unmarshal(data, &out); err != nil {
		panic(fmt.Sprintf("journal: clone unmarshal: %v", err))
	}
	return &out
}

// Load reads the journal at path. A missing file is ErrNotFound; an
// unreadable one ErrCorrupt; an unknown schema ErrUnknownSchema. Callers treat
// the last two the same way: delete every Breeze-owned rule.
func Load(path string) (*Journal, error) {
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, fmt.Errorf("%w: %s", ErrNotFound, path)
		}
		return nil, fmt.Errorf("open isolation journal: %w", err)
	}
	defer func() { _ = f.Close() }()
	data, err := io.ReadAll(io.LimitReader(f, maxFileBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read isolation journal: %w", err)
	}
	if len(data) > maxFileBytes {
		return nil, fmt.Errorf("%w: larger than %d bytes", ErrCorrupt, maxFileBytes)
	}

	var probe struct {
		SchemaVersion *int `json:"schemaVersion"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCorrupt, err)
	}
	if probe.SchemaVersion == nil {
		return nil, fmt.Errorf("%w: no schemaVersion", ErrCorrupt)
	}
	if *probe.SchemaVersion != SchemaVersion {
		return nil, fmt.Errorf("%w: %d", ErrUnknownSchema, *probe.SchemaVersion)
	}
	// Unknown fields are tolerated: an additive field from a newer agent or
	// recovery binary must not read as corruption, because corruption deletes
	// every rule. A change an older binary must not silently drop (it would
	// rewrite the file without the field) needs a schemaVersion bump instead.
	var j Journal
	if err := json.Unmarshal(data, &j); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCorrupt, err)
	}
	if !j.Phase.Valid() {
		return nil, fmt.Errorf("%w: unknown phase %q", ErrCorrupt, j.Phase)
	}
	if j.NextSeq < 1 {
		return nil, fmt.Errorf("%w: nextSeq %d", ErrCorrupt, j.NextSeq)
	}
	return &j, nil
}

// Save writes j to path: a temp file in the same directory, owner-only
// (SYSTEM/Administrators on Windows) before any content is written, fsynced,
// then atomicrename.Replace over path and (on Unix) the directory fsynced.
func Save(path string, j *Journal) error {
	if j == nil {
		return errors.New("save isolation journal: nil journal")
	}
	if j.SchemaVersion != SchemaVersion {
		return fmt.Errorf("save isolation journal: schemaVersion %d, want %d", j.SchemaVersion, SchemaVersion)
	}
	if !j.Phase.Valid() {
		return fmt.Errorf("save isolation journal: unknown phase %q", j.Phase)
	}
	if over := len(j.Events) - MaxEvents; over > 0 {
		j.Events = append([]Event(nil), j.Events[over:]...)
	}
	data, err := json.Marshal(j)
	if err != nil {
		return fmt.Errorf("encode isolation journal: %w", err)
	}

	dir := filepath.Dir(path)
	tmp := filepath.Join(dir, "."+filepath.Base(path)+".tmp-"+randomSuffix())
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("create isolation journal temp file: %w", err)
	}
	cleanup := func() { _ = os.Remove(tmp) }
	if err := restrictFile(f, tmp); err != nil {
		_ = f.Close()
		cleanup()
		return fmt.Errorf("restrict isolation journal temp file: %w", err)
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		cleanup()
		return fmt.Errorf("write isolation journal: %w", err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		cleanup()
		return fmt.Errorf("fsync isolation journal: %w", err)
	}
	if err := f.Close(); err != nil {
		cleanup()
		return fmt.Errorf("close isolation journal: %w", err)
	}
	if err := atomicrename.Replace(tmp, path); err != nil {
		cleanup()
		return fmt.Errorf("replace isolation journal: %w", err)
	}
	if err := syncDir(dir); err != nil {
		return fmt.Errorf("fsync isolation journal directory: %w", err)
	}
	return nil
}

func randomSuffix() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}
