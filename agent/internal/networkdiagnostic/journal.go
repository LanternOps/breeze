package networkdiagnostic

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var ErrJournalFull = errors.New("diagnostic journal full")
var ErrCancelled = errors.New("diagnostic cancelled")
var ErrJournalConflict = errors.New("diagnostic identity conflict")
var ErrExpired = errors.New("diagnostic expired")

type journalCommand struct {
	Cancelled bool      `json:"cancelled,omitempty"`
	RunID     string    `json:"runId"`
	AttemptID string    `json:"attemptId"`
	Digest    string    `json:"digest"`
	ExpiresAt time.Time `json:"expiresAt"`
}
type journalEntry struct {
	Intent *StepResult `json:"intent,omitempty"`
	Key    StepKey     `json:"key"`
	Result *StepResult `json:"result,omitempty"`
}
type journalData struct {
	Version   int                       `json:"version"`
	Commands  map[string]journalCommand `json:"commands"`
	Entries   map[string]journalEntry   `json:"entries"`
	LastClock time.Time                 `json:"lastClock"`
}
type Journal struct {
	mu     sync.Mutex
	path   string
	data   journalData
	write  func(string, []byte) error
	clock  func() time.Time
	lock   *os.File
	closed bool
}

func OpenJournal(path string) (opened *Journal, err error) {
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	defer func() {
		if opened == nil {
			_ = lock.Close()
		}
	}()
	if err = lockJournal(lock); err != nil {
		return nil, err
	}

	j := &Journal{lock: lock, path: path, write: writeJournal, clock: time.Now, data: journalData{Version: 1, Commands: map[string]journalCommand{}, Entries: map[string]journalEntry{}}}
	b, e := os.ReadFile(path)
	if errors.Is(e, os.ErrNotExist) {
		return j, nil
	}
	if e != nil {
		return nil, e
	}
	if len(b) > 128*1024*1024 {
		return nil, ErrJournalFull
	}
	if e = json.Unmarshal(b, &j.data); e != nil || j.data.Version != 1 || j.data.Commands == nil || j.data.Entries == nil || len(j.data.Commands)+len(j.data.Entries) > 10000 {
		return nil, errors.New("corrupt diagnostic journal")
	}
	for key, entry := range j.data.Entries {
		command, ok := j.data.Commands[entry.Key.CommandID]
		if key != entry.Key.String() || !ok || command.RunID != entry.Key.RunID || command.AttemptID != entry.Key.AttemptID {
			return nil, errors.New("corrupt diagnostic journal identity")
		}
	}
	if _, e = j.Recover(); e != nil {
		return nil, e
	}
	return j, nil
}
func cloneJournal(data journalData) journalData {
	out := data
	out.Commands = map[string]journalCommand{}
	out.Entries = map[string]journalEntry{}
	for k, v := range data.Commands {
		out.Commands[k] = v
	}
	for k, v := range data.Entries {
		out.Entries[k] = v
	}
	return out
}
func (j *Journal) commit(next journalData) error {
	if j.closed {
		return os.ErrClosed
	}
	b, e := json.Marshal(next)
	if e != nil {
		return e
	}
	if e = j.write(j.path, b); e != nil {
		return e
	}
	j.data = next
	return nil
}
func (j *Journal) cleanup(next *journalData, now time.Time) {
	// A clock rollback cannot shorten replay protection. Use the last durable
	// clock as the lower bound, but never expire solely from a future caller time.
	if now.Before(next.LastClock) {
		return
	}
	next.LastClock = now
	for id, command := range next.Commands {
		if !now.Before(command.ExpiresAt.Add(24 * time.Hour)) {
			delete(next.Commands, id)
			for key, entry := range next.Entries {
				if entry.Key.CommandID == id {
					delete(next.Entries, key)
				}
			}
		}
	}
}
func (j *Journal) Accept(command Command) (bool, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed {
		return false, os.ErrClosed
	}
	if old, ok := j.data.Commands[command.CommandID]; ok {
		if old.Cancelled && old.RunID == command.RunID && old.AttemptID == command.AttemptID {
			return false, ErrCancelled
		}
		if old.RunID != command.RunID || old.AttemptID != command.AttemptID || old.Digest != command.PlanDigest || !old.ExpiresAt.Equal(command.ExpiresAt) {
			return false, ErrJournalConflict
		}
		return false, nil
	}
	next := cloneJournal(j.data)
	j.cleanup(&next, j.clock())
	for _, old := range next.Commands {
		if old.RunID == command.RunID && old.AttemptID == command.AttemptID {
			return false, ErrJournalConflict
		}
	}
	if len(next.Commands)+len(next.Entries) >= 10000 {
		return false, ErrJournalFull
	}
	next.Commands[command.CommandID] = journalCommand{RunID: command.RunID, AttemptID: command.AttemptID, Digest: command.PlanDigest, ExpiresAt: command.ExpiresAt}
	if err := j.commit(next); err != nil {
		return false, err
	}
	return true, nil
}
func (j *Journal) StartStep(key StepKey, initial ...StepResult) (bool, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed {
		return false, os.ErrClosed
	}
	if _, ok := j.data.Entries[key.String()]; ok {
		return false, nil
	}
	command, ok := j.data.Commands[key.CommandID]
	if !ok || command.RunID != key.RunID || command.AttemptID != key.AttemptID {
		return false, ErrJournalConflict
	}
	if command.Cancelled {
		return false, ErrCancelled
	}
	if !j.clock().Before(command.ExpiresAt) {
		return false, ErrExpired
	}
	next := cloneJournal(j.data)
	j.cleanup(&next, j.clock())
	if len(next.Commands)+len(next.Entries) >= 10000 {
		return false, ErrJournalFull
	}
	entry := journalEntry{Key: key}
	if len(initial) > 0 {
		copy := initial[0]
		entry.Intent = &copy
	}
	next.Entries[key.String()] = entry
	if e := j.commit(next); e != nil {
		return false, e
	}
	return true, nil
}
func (j *Journal) FinishStep(key StepKey, result StepResult) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	entry, ok := j.data.Entries[key.String()]
	if !ok || result.ID != key.StepID {
		return ErrJournalConflict
	}
	if entry.Result != nil {
		return nil
	}
	next := cloneJournal(j.data)
	entry.Result = &result
	next.Entries[key.String()] = entry
	return j.commit(next)
}
func (j *Journal) Result(key StepKey) (*StepResult, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	entry, ok := j.data.Entries[key.String()]
	if !ok {
		return nil, false
	}
	if entry.Result == nil {
		return nil, true
	}
	b, _ := json.Marshal(entry.Result)
	var result StepResult
	_ = json.Unmarshal(b, &result)
	return &result, true
}
func (j *Journal) Recover() ([]StepResult, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	next := cloneJournal(j.data)
	recovered := []StepResult{}
	now := j.clock().UTC()
	for key, entry := range next.Entries {
		if entry.Result != nil {
			continue
		}
		result := StepResult{ID: entry.Key.StepID, State: "execution_error", Reason: ptr("outcome_indeterminate"), FinishedAt: &now, Attribution: Attribution{Quality: "unknown", EvidenceRefs: []string{}}}
		if entry.Intent != nil {
			result = *entry.Intent
			result.State = "execution_error"
			result.Reason = ptr("outcome_indeterminate")
			result.FinishedAt = &now
		}
		entry.Result = &result
		next.Entries[key] = entry
		recovered = append(recovered, result)
	}
	if len(recovered) == 0 {
		return recovered, nil
	}
	return recovered, j.commit(next)
}
func (j *Journal) Close() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed {
		return nil
	}
	j.closed = true
	return j.lock.Close()
}

type journalFileOps struct {
	write   func(*os.File, []byte) (int, error)
	sync    func(*os.File) error
	replace func(string, string) error
}

func nativeJournalOps() journalFileOps {
	return journalFileOps{(*os.File).Write, (*os.File).Sync, replaceJournal}
}
func writeJournal(path string, data []byte) error {
	return writeJournalWithOps(path, data, nativeJournalOps())
}
func writeJournalWithOps(path string, data []byte, ops journalFileOps) error {
	dir := filepath.Dir(path)
	if e := os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(dir, ".diagnostic-journal-*")
	if e != nil {
		return e
	}
	name := f.Name()
	defer os.Remove(name)
	if e = f.Chmod(0600); e != nil {
		f.Close()
		return e
	}
	if _, e = ops.write(f, data); e != nil {
		f.Close()
		return e
	}
	if e = ops.sync(f); e != nil {
		f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	return ops.replace(name, path)
}

func (j *Journal) accepted(c Command) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	old, ok := j.data.Commands[c.CommandID]
	return ok && old.RunID == c.RunID && old.AttemptID == c.AttemptID && old.Digest == c.PlanDigest && old.ExpiresAt.Equal(c.ExpiresAt)
}

func (j *Journal) Cancel(commandID, runID, attemptID string) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	next := cloneJournal(j.data)
	j.cleanup(&next, j.clock())
	command, exists := next.Commands[commandID]
	if exists && (command.RunID != runID || command.AttemptID != attemptID) {
		return ErrJournalConflict
	}
	if !exists {
		if len(next.Commands)+len(next.Entries) >= 10000 {
			return ErrJournalFull
		}
		command = journalCommand{RunID: runID, AttemptID: attemptID, ExpiresAt: j.clock().Add(120 * time.Second)}
	}
	command.Cancelled = true
	next.Commands[commandID] = command
	return j.commit(next)
}
