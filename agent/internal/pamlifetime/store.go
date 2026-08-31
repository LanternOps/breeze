package pamlifetime

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
)

// ErrLedgerPersist marks a failure to durably WRITE the ledger, as opposed to a
// command the ledger rejected. Callers must map it to its own failure code:
// reporting a broken write path as "invalid_command" is what hid issue #4184
// (a pinned parent directory made every ledger rename fail) from v0.96.0
// through v0.108.0.
var ErrLedgerPersist = errors.New("pam lifetime ledger persist failed")

// ErrLedgerUnavailable is the read-side sibling of ErrLedgerPersist. load runs
// once in NewStore and its failure is sticky for the store's lifetime, so a
// corrupt or unreadable ledger rejects every later apply and cleanup. That is
// an agent-side storage outage, not a malformed command, and callers must map
// it to its own failure code for the same reason.
var ErrLedgerUnavailable = errors.New("pam lifetime ledger unavailable")

type Decision string

const (
	DecisionApply     Decision = "apply"
	DecisionCleanup   Decision = "cleanup"
	DecisionDuplicate Decision = "duplicate"
)

type LedgerEntry struct {
	ActuationID         string       `json:"actuationId"`
	RequestID           string       `json:"requestId"`
	DeviceID            string       `json:"deviceId"`
	OrgID               string       `json:"orgId"`
	Generation          uint64       `json:"generation"`
	DesiredState        DesiredState `json:"desiredState"`
	PID                 int          `json:"pid,omitempty"`
	ProcessCreationTime *time.Time   `json:"processCreationTime,omitempty"`
	JobName             string       `json:"jobName,omitempty"`
	BootID              string       `json:"bootId,omitempty"`
	CreatedAt           time.Time    `json:"createdAt"`
	UpdatedAt           time.Time    `json:"updatedAt"`
	BoundCommandDigest  string       `json:"boundCommandDigest,omitempty"`
}

type ProcessIdentity struct {
	PID                 int
	ProcessCreationTime time.Time
	WindowsSessionID    uint32
	TargetHash          string
	JobName             string
	BootID              string
}

type ledgerFile struct {
	Entries map[string]LedgerEntry `json:"entries"`
}

type Store struct {
	mu      sync.Mutex
	path    string
	entries map[string]LedgerEntry
	loadErr error
}

func NewStore(path string) *Store {
	s := &Store{path: path, entries: make(map[string]LedgerEntry)}
	if err := s.load(); err != nil {
		s.loadErr = fmt.Errorf("%w: %w", ErrLedgerUnavailable, err)
	}
	return s
}

func (s *Store) PrepareApply(cmd ApplyCommand) (Decision, error) {
	if err := validateApply(cmd); err != nil {
		return "", err
	}
	digest, err := applyDigest(cmd)
	if err != nil {
		return "", err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.loadErr != nil {
		return "", s.loadErr
	}
	previous, exists := s.entries[cmd.ActuationID]
	if exists {
		if err := matchIdentity(previous, cmd.RequestID, cmd.DeviceID, cmd.OrgID); err != nil {
			return "", err
		}
		if previous.DesiredState == DesiredCleanup {
			return "", errors.New("apply rejected after durable cleanup tombstone")
		}
		if cmd.Generation < previous.Generation {
			return "", errors.New("apply generation is stale")
		}
		if cmd.Generation == previous.Generation {
			if previous.BoundCommandDigest != digest {
				return "", errors.New("equal apply generation has different bound content")
			}
			return DecisionDuplicate, nil
		}
		return "", errors.New("active generation must be cleaned before replacement")
	}

	now := time.Now().UTC()
	entry := LedgerEntry{
		ActuationID: cmd.ActuationID, RequestID: cmd.RequestID, DeviceID: cmd.DeviceID,
		OrgID: cmd.OrgID, Generation: cmd.Generation, DesiredState: DesiredActive,
		CreatedAt: now, UpdatedAt: now, BoundCommandDigest: digest,
	}
	if exists {
		entry.CreatedAt = previous.CreatedAt
	}
	if err := s.replaceLocked(cmd.ActuationID, entry); err != nil {
		return "", err
	}
	return DecisionApply, nil
}

func (s *Store) PrepareCleanup(cmd CleanupCommand) (Decision, error) {
	if err := validateIdentity(cmd.ProtocolVersion, cmd.ActuationID, cmd.RequestID, cmd.DeviceID, cmd.OrgID); err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.loadErr != nil {
		return "", s.loadErr
	}
	previous, exists := s.entries[cmd.ActuationID]
	if exists {
		if err := matchIdentity(previous, cmd.RequestID, cmd.DeviceID, cmd.OrgID); err != nil {
			return "", err
		}
		if cmd.Generation < previous.Generation {
			return "", errors.New("cleanup generation is stale")
		}
		if cmd.Generation == previous.Generation {
			if previous.DesiredState == DesiredCleanup {
				return DecisionDuplicate, nil
			}
			return "", errors.New("cleanup generation must exceed active generation")
		}
	}

	now := time.Now().UTC()
	entry := LedgerEntry{
		ActuationID: cmd.ActuationID, RequestID: cmd.RequestID, DeviceID: cmd.DeviceID,
		OrgID: cmd.OrgID, Generation: cmd.Generation, DesiredState: DesiredCleanup,
		CreatedAt: now, UpdatedAt: now,
	}
	if exists {
		entry.CreatedAt = previous.CreatedAt
		entry.PID = previous.PID
		entry.ProcessCreationTime = previous.ProcessCreationTime
		entry.JobName = previous.JobName
		entry.BootID = previous.BootID
	}
	if err := s.replaceLocked(cmd.ActuationID, entry); err != nil {
		return "", err
	}
	return DecisionCleanup, nil
}

func (s *Store) BindProcess(actuationID string, generation uint64, process ProcessIdentity) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.loadErr != nil {
		return s.loadErr
	}
	entry, ok := s.entries[actuationID]
	if !ok || entry.DesiredState != DesiredActive || entry.Generation != generation {
		return errors.New("cannot bind process to non-current active generation")
	}
	entry.PID = process.PID
	creationTime := process.ProcessCreationTime.UTC()
	entry.ProcessCreationTime = &creationTime
	entry.JobName = process.JobName
	entry.BootID = process.BootID
	entry.UpdatedAt = time.Now().UTC()
	return s.replaceLocked(actuationID, entry)
}

func (s *Store) ClearProcessIdentity(actuationID string, generation uint64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.loadErr != nil {
		return s.loadErr
	}
	entry, ok := s.entries[actuationID]
	if !ok || entry.DesiredState != DesiredCleanup || entry.Generation != generation {
		return errors.New("cannot clear process identity from non-current cleanup tombstone")
	}
	entry.PID = 0
	entry.ProcessCreationTime = nil
	entry.JobName = ""
	entry.BootID = ""
	entry.UpdatedAt = time.Now().UTC()
	return s.replaceLocked(actuationID, entry)
}

func (s *Store) Entry(actuationID string) (LedgerEntry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.entries[actuationID]
	return entry, ok
}

func (s *Store) Entries() []LedgerEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries := make([]LedgerEntry, 0, len(s.entries))
	for _, entry := range s.entries {
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].ActuationID < entries[j].ActuationID })
	return entries
}

func (s *Store) load() error {
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read PAM lifetime ledger: %w", err)
	}
	var file ledgerFile
	if err := json.Unmarshal(raw, &file); err != nil {
		return fmt.Errorf("decode PAM lifetime ledger: %w", err)
	}
	if file.Entries != nil {
		s.entries = file.Entries
	}
	return nil
}

func (s *Store) replaceLocked(key string, next LedgerEntry) error {
	previous, existed := s.entries[key]
	s.entries[key] = next
	if err := s.persistLocked(); err != nil {
		if existed {
			s.entries[key] = previous
		} else {
			delete(s.entries, key)
		}
		return fmt.Errorf("%w: %w", ErrLedgerPersist, err)
	}
	return nil
}

func (s *Store) persistLocked() error {
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create PAM lifetime ledger directory: %w", err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return fmt.Errorf("secure PAM lifetime ledger directory: %w", err)
	}
	raw, err := json.Marshal(ledgerFile{Entries: s.entries})
	if err != nil {
		return fmt.Errorf("encode PAM lifetime ledger: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".pam-lifetime-*")
	if err != nil {
		return fmt.Errorf("create PAM lifetime ledger temporary file: %w", err)
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("secure PAM lifetime ledger temporary file: %w", err)
	}
	if _, err := tmp.Write(raw); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write PAM lifetime ledger: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("flush PAM lifetime ledger: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close PAM lifetime ledger: %w", err)
	}
	if err := replaceFile(tmpPath, s.path); err != nil {
		return fmt.Errorf("replace PAM lifetime ledger: %w", err)
	}
	if err := os.Chmod(s.path, 0o600); err != nil {
		return fmt.Errorf("secure PAM lifetime ledger: %w", err)
	}
	return nil
}

func validateApply(cmd ApplyCommand) error {
	if err := validateIdentity(cmd.ProtocolVersion, cmd.ActuationID, cmd.RequestID, cmd.DeviceID, cmd.OrgID); err != nil {
		return err
	}
	if cmd.Generation == 0 {
		return errors.New("generation must be positive")
	}
	if cmd.TargetPath == "" || cmd.SubjectUsername == "" {
		return errors.New("target path and subject username are required")
	}
	if cmd.ServerTime.IsZero() || cmd.ExpiresAt.IsZero() || cmd.MaxRemainingLifetimeMS <= 0 {
		return errors.New("lifetime bounds are required")
	}
	if cmd.MaxRemainingLifetimeMS > math.MaxInt64/int64(time.Millisecond) {
		return errors.New("maximum remaining lifetime overflows local duration")
	}
	if !cmd.ExpiresAt.After(time.Now()) {
		return errors.New("command is expired")
	}
	maximum := cmd.ServerTime.Add(time.Duration(cmd.MaxRemainingLifetimeMS) * time.Millisecond)
	if cmd.ExpiresAt.After(maximum) {
		return errors.New("command exceeds maximum remaining lifetime")
	}
	return nil
}

func validateIdentity(protocol int, values ...string) error {
	if protocol != 2 {
		return errors.New("unsupported PAM lifetime protocol version")
	}
	for _, value := range values {
		if _, err := uuid.Parse(value); err != nil {
			return errors.New("PAM lifetime identity must be a UUID")
		}
	}
	return nil
}

func matchIdentity(entry LedgerEntry, requestID, deviceID, orgID string) error {
	if entry.RequestID != requestID || entry.DeviceID != deviceID || entry.OrgID != orgID {
		return errors.New("PAM lifetime identity does not match durable ledger")
	}
	return nil
}

func applyDigest(cmd ApplyCommand) (string, error) {
	bound := struct {
		RequestID, DeviceID, OrgID, TargetPath string
		TargetHash                             *string
		SubjectUsername                        string
		ExpiresAt, ServerTime                  time.Time
		MaxRemainingLifetimeMS                 int64
	}{cmd.RequestID, cmd.DeviceID, cmd.OrgID, cmd.TargetPath, cmd.TargetHash, cmd.SubjectUsername, cmd.ExpiresAt, cmd.ServerTime, cmd.MaxRemainingLifetimeMS}
	raw, err := json.Marshal(bound)
	if err != nil {
		return "", fmt.Errorf("encode bound PAM lifetime command: %w", err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}
