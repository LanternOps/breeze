package heartbeat

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/pamlifetime"
	"github.com/google/uuid"
)

const (
	pamReconciliationDirName          = "pam-reconciliation"
	pamReconciliationStatePending     = "pending"
	pamReconciliationStateQuarantined = "quarantined"
	pamReconciliationQuarantineDir    = "quarantine"
)

type pamReconciliationOutboxEntry struct {
	CommandID   string             `json:"commandId"`
	Observation pamlifetime.Result `json:"observation"`
	EnqueuedAt  time.Time          `json:"enqueuedAt"`
	State       string             `json:"state"`
	Reason      string             `json:"reason,omitempty"`
}

type pamReconciliationOutboxSnapshot struct {
	Pending     []pamReconciliationOutboxEntry
	Quarantined []pamReconciliationOutboxEntry
}

type pamReconciliationOutbox struct {
	root          string
	pendingDir    string
	quarantineDir string
	mu            sync.Mutex
	nowFn         func() time.Time
	writeFn       func(*os.File, []byte) error
	syncFn        func(*os.File) error
	renameFn      func(string, string) error
	readFileFn    func(string) ([]byte, error)
}

func newPamReconciliationOutbox(ordinaryOutboxRoot string) *pamReconciliationOutbox {
	root := filepath.Join(ordinaryOutboxRoot, pamReconciliationDirName)
	return &pamReconciliationOutbox{
		root:          root,
		pendingDir:    filepath.Join(root, pamReconciliationStatePending),
		quarantineDir: filepath.Join(root, pamReconciliationQuarantineDir),
		nowFn:         time.Now,
		writeFn: func(file *os.File, payload []byte) error {
			n, err := file.Write(payload)
			if err != nil {
				return err
			}
			if n != len(payload) {
				return fmt.Errorf("short write: wrote %d of %d bytes", n, len(payload))
			}
			return nil
		},
		syncFn:     func(file *os.File) error { return file.Sync() },
		renameFn:   os.Rename,
		readFileFn: os.ReadFile,
	}
}

func canonicalPamUUID(value string) (string, error) {
	parsed, err := uuid.Parse(value)
	if err != nil {
		return "", err
	}
	canonical := parsed.String()
	if value != canonical {
		return "", fmt.Errorf("UUID %q is not canonical %q", value, canonical)
	}
	return canonical, nil
}

func (o *pamReconciliationOutbox) dirForState(state string) (string, error) {
	switch state {
	case pamReconciliationStatePending:
		return o.pendingDir, nil
	case pamReconciliationStateQuarantined:
		return o.quarantineDir, nil
	default:
		return "", fmt.Errorf("invalid PAM reconciliation outbox state %q", state)
	}
}

func (o *pamReconciliationOutbox) entryPath(state, commandID, observationID string) string {
	dir, _ := o.dirForState(state)
	return filepath.Join(dir, commandID+"."+observationID+".json")
}

func validatePamReconciliationEntry(entry pamReconciliationOutboxEntry) error {
	if _, err := canonicalPamUUID(entry.CommandID); err != nil {
		return fmt.Errorf("invalid command ID: %w", err)
	}
	if _, err := canonicalPamUUID(entry.Observation.ObservationID); err != nil {
		return fmt.Errorf("invalid observation ID: %w", err)
	}
	if entry.State != pamReconciliationStatePending && entry.State != pamReconciliationStateQuarantined {
		return fmt.Errorf("invalid state %q", entry.State)
	}
	if entry.EnqueuedAt.IsZero() {
		return errors.New("enqueue time is required")
	}
	return nil
}

func parsePamReconciliationFilename(name string) (string, string, error) {
	if filepath.Base(name) != name || !strings.HasSuffix(name, ".json") {
		return "", "", fmt.Errorf("unexpected PAM reconciliation filename %q", name)
	}
	parts := strings.Split(strings.TrimSuffix(name, ".json"), ".")
	if len(parts) != 2 {
		return "", "", fmt.Errorf("unexpected PAM reconciliation filename %q", name)
	}
	commandID, err := canonicalPamUUID(parts[0])
	if err != nil {
		return "", "", fmt.Errorf("invalid command ID in filename %q: %w", name, err)
	}
	observationID, err := canonicalPamUUID(parts[1])
	if err != nil {
		return "", "", fmt.Errorf("invalid observation ID in filename %q: %w", name, err)
	}
	return commandID, observationID, nil
}

func (o *pamReconciliationOutbox) loadEntry(path, state string) (pamReconciliationOutboxEntry, error) {
	var entry pamReconciliationOutboxEntry
	raw, err := o.readFileFn(path)
	if err != nil {
		return entry, err
	}
	if err := json.Unmarshal(raw, &entry); err != nil {
		return entry, err
	}
	if err := validatePamReconciliationEntry(entry); err != nil {
		return entry, err
	}
	commandID, observationID, err := parsePamReconciliationFilename(filepath.Base(path))
	if err != nil {
		return entry, err
	}
	if entry.State != state || entry.CommandID != commandID || entry.Observation.ObservationID != observationID {
		return entry, errors.New("PAM reconciliation filename and entry identity disagree")
	}
	return entry, nil
}

func (o *pamReconciliationOutbox) persistNewLocked(entry pamReconciliationOutboxEntry) error {
	if err := validatePamReconciliationEntry(entry); err != nil {
		return err
	}
	dir, err := o.dirForState(entry.State)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("create PAM reconciliation outbox directory: %w", err)
	}
	finalPath := o.entryPath(entry.State, entry.CommandID, entry.Observation.ObservationID)
	if _, err := os.Lstat(finalPath); err == nil {
		existing, loadErr := o.loadEntry(finalPath, entry.State)
		if loadErr != nil {
			return fmt.Errorf("load existing PAM reconciliation entry: %w", loadErr)
		}
		existingObservation, err := json.Marshal(existing.Observation)
		if err != nil {
			return fmt.Errorf("encode existing PAM reconciliation observation: %w", err)
		}
		candidateObservation, err := json.Marshal(entry.Observation)
		if err != nil {
			return fmt.Errorf("encode candidate PAM reconciliation observation: %w", err)
		}
		if existing.CommandID == entry.CommandID &&
			existing.State == entry.State &&
			existing.Reason == entry.Reason &&
			bytes.Equal(existingObservation, candidateObservation) {
			return nil
		}
		return errors.New("PAM reconciliation destination already exists with different immutable content")
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect PAM reconciliation destination: %w", err)
	}

	payload, err := json.Marshal(entry)
	if err != nil {
		return fmt.Errorf("encode PAM reconciliation entry: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".pam-reconciliation-*.tmp")
	if err != nil {
		return fmt.Errorf("create PAM reconciliation temporary file: %w", err)
	}
	tmpPath := tmp.Name()
	keepTemp := true
	defer func() {
		if keepTemp {
			_ = os.Remove(tmpPath)
		}
	}()
	if err := tmp.Chmod(0600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("chmod PAM reconciliation temporary file: %w", err)
	}
	if err := o.writeFn(tmp, payload); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write PAM reconciliation temporary file: %w", err)
	}
	if err := o.syncFn(tmp); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("sync PAM reconciliation temporary file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close PAM reconciliation temporary file: %w", err)
	}
	if _, err := os.Lstat(finalPath); err == nil {
		return errors.New("PAM reconciliation destination appeared before rename")
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("reinspect PAM reconciliation destination: %w", err)
	}
	if err := o.renameFn(tmpPath, finalPath); err != nil {
		return fmt.Errorf("rename PAM reconciliation entry: %w", err)
	}
	keepTemp = false
	return nil
}

func (o *pamReconciliationOutbox) Enqueue(commandID string, observation pamlifetime.Result) error {
	if _, err := canonicalPamUUID(commandID); err != nil {
		return fmt.Errorf("invalid command ID: %w", err)
	}
	if _, err := canonicalPamUUID(observation.ObservationID); err != nil {
		return fmt.Errorf("invalid observation ID: %w", err)
	}

	o.mu.Lock()
	defer o.mu.Unlock()
	return o.persistNewLocked(pamReconciliationOutboxEntry{
		CommandID:   commandID,
		Observation: observation,
		EnqueuedAt:  o.nowFn(),
		State:       pamReconciliationStatePending,
	})
}

func (o *pamReconciliationOutbox) Snapshot() (pamReconciliationOutboxSnapshot, error) {
	o.mu.Lock()
	defer o.mu.Unlock()

	var snapshot pamReconciliationOutboxSnapshot
	var loadErrors []error
	for _, state := range []string{pamReconciliationStatePending, pamReconciliationStateQuarantined} {
		dir, _ := o.dirForState(state)
		files, err := os.ReadDir(dir)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			loadErrors = append(loadErrors, fmt.Errorf("read %s PAM reconciliation directory: %w", state, err))
			continue
		}
		for _, file := range files {
			path := filepath.Join(dir, file.Name())
			if file.IsDir() {
				loadErrors = append(loadErrors, fmt.Errorf("unexpected directory in PAM reconciliation outbox: %s", path))
				continue
			}
			entry, err := o.loadEntry(path, state)
			if err != nil {
				loadErrors = append(loadErrors, fmt.Errorf("load PAM reconciliation entry %s: %w", path, err))
				continue
			}
			if state == pamReconciliationStatePending {
				snapshot.Pending = append(snapshot.Pending, entry)
			} else {
				snapshot.Quarantined = append(snapshot.Quarantined, entry)
			}
		}
	}
	sortEntries := func(entries []pamReconciliationOutboxEntry) {
		sort.Slice(entries, func(i, j int) bool {
			if entries[i].EnqueuedAt.Equal(entries[j].EnqueuedAt) {
				left := entries[i].CommandID + entries[i].Observation.ObservationID
				right := entries[j].CommandID + entries[j].Observation.ObservationID
				return left < right
			}
			return entries[i].EnqueuedAt.Before(entries[j].EnqueuedAt)
		})
	}
	sortEntries(snapshot.Pending)
	sortEntries(snapshot.Quarantined)
	return snapshot, errors.Join(loadErrors...)
}

func (o *pamReconciliationOutbox) Rebind(commandID, observationID, newCommandID string) error {
	for label, value := range map[string]string{
		"command ID": commandID, "observation ID": observationID, "new command ID": newCommandID,
	} {
		if _, err := canonicalPamUUID(value); err != nil {
			return fmt.Errorf("invalid %s: %w", label, err)
		}
	}
	if commandID == newCommandID {
		return nil
	}

	o.mu.Lock()
	defer o.mu.Unlock()
	oldPath := o.entryPath(pamReconciliationStatePending, commandID, observationID)
	entry, err := o.loadEntry(oldPath, pamReconciliationStatePending)
	if err != nil {
		return fmt.Errorf("load PAM reconciliation entry for rebind: %w", err)
	}
	entry.CommandID = newCommandID
	if err := o.persistNewLocked(entry); err != nil {
		return fmt.Errorf("persist rebound PAM reconciliation entry: %w", err)
	}
	if err := os.Remove(oldPath); err != nil {
		return fmt.Errorf("remove old PAM reconciliation binding: %w", err)
	}
	return nil
}

func (o *pamReconciliationOutbox) Quarantine(commandID, observationID, reason string) error {
	if strings.TrimSpace(reason) == "" {
		return errors.New("quarantine reason is required")
	}
	if _, err := canonicalPamUUID(commandID); err != nil {
		return fmt.Errorf("invalid command ID: %w", err)
	}
	if _, err := canonicalPamUUID(observationID); err != nil {
		return fmt.Errorf("invalid observation ID: %w", err)
	}

	o.mu.Lock()
	defer o.mu.Unlock()
	oldPath := o.entryPath(pamReconciliationStatePending, commandID, observationID)
	entry, err := o.loadEntry(oldPath, pamReconciliationStatePending)
	if err != nil {
		return fmt.Errorf("load PAM reconciliation entry for quarantine: %w", err)
	}
	entry.State = pamReconciliationStateQuarantined
	entry.Reason = reason
	if err := o.persistNewLocked(entry); err != nil {
		return fmt.Errorf("persist quarantined PAM reconciliation entry: %w", err)
	}
	if err := os.Remove(oldPath); err != nil {
		return fmt.Errorf("remove pending PAM reconciliation entry: %w", err)
	}
	return nil
}

func (o *pamReconciliationOutbox) Remove(state, commandID, observationID string) error {
	if _, err := o.dirForState(state); err != nil {
		return err
	}
	if _, err := canonicalPamUUID(commandID); err != nil {
		return fmt.Errorf("invalid command ID: %w", err)
	}
	if _, err := canonicalPamUUID(observationID); err != nil {
		return fmt.Errorf("invalid observation ID: %w", err)
	}

	o.mu.Lock()
	defer o.mu.Unlock()
	path := o.entryPath(state, commandID, observationID)
	entry, err := o.loadEntry(path, state)
	if err != nil {
		return fmt.Errorf("load exact PAM reconciliation entry for removal: %w", err)
	}
	if entry.CommandID != commandID || entry.Observation.ObservationID != observationID {
		return errors.New("PAM reconciliation removal identity mismatch")
	}
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("remove PAM reconciliation entry: %w", err)
	}
	return nil
}
