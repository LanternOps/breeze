package sessionbroker

import (
	"sync"
	"time"
)

type helperState string

const (
	helperStarting  helperState = "starting"
	helperConnected helperState = "connected"
	helperStopping  helperState = "stopping"
	helperExited    helperState = "exited"
)

type trackedHelper struct {
	key            HelperKey
	process        helperProcess
	generation     uint64
	state          helperState
	launchedAt     time.Time
	retryCount     int
	lastFailure    time.Time
	fatalExitUntil time.Time
	executablePath string
	commandMode    string
	done           chan struct{}
	exitCode       int
	brokerSession  *Session
	doneOnce       sync.Once
}

type helperRegistry struct {
	mu         sync.Mutex
	next       uint64
	current    map[HelperKey]*trackedHelper
	generation map[uint64]*trackedHelper
}

func newHelperRegistry() *helperRegistry {
	return &helperRegistry{
		current:    make(map[HelperKey]*trackedHelper),
		generation: make(map[uint64]*trackedHelper),
	}
}

func (r *helperRegistry) newEntryLocked(key HelperKey, previous *trackedHelper) *trackedHelper {
	r.next++
	entry := &trackedHelper{
		key:        key,
		generation: r.next,
		state:      helperStarting,
		done:       make(chan struct{}),
		exitCode:   -1,
	}
	if previous != nil {
		entry.retryCount = previous.retryCount
		entry.lastFailure = previous.lastFailure
		entry.fatalExitUntil = previous.fatalExitUntil
	}
	r.current[key] = entry
	r.generation[entry.generation] = entry
	return entry
}

func (r *helperRegistry) reserve(key HelperKey, now time.Time) (uint64, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	previous := r.current[key]
	if previous != nil {
		if previous.state == helperStarting || previous.state == helperStopping {
			return 0, false
		}
		if previous.process != nil && previous.process.Alive() {
			return 0, false
		}
		if !previous.fatalExitUntil.IsZero() && now.Before(previous.fatalExitUntil) {
			return 0, false
		}
		if previous.retryCount >= maxSpawnRetries {
			return 0, false
		}
		if previous.retryCount > 0 {
			backoff := time.Duration(1<<uint(previous.retryCount)) * time.Second
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
			if now.Sub(previous.lastFailure) < backoff {
				return 0, false
			}
		}
	}
	entry := r.newEntryLocked(key, previous)
	entry.retryCount++
	entry.lastFailure = now
	return entry.generation, true
}

func (r *helperRegistry) attach(key HelperKey, process helperProcess, executablePath, commandMode string) uint64 {
	r.mu.Lock()
	entry := r.newEntryLocked(key, r.current[key])
	entry.process = process
	entry.launchedAt = time.Now()
	entry.executablePath = executablePath
	entry.commandMode = commandMode
	r.mu.Unlock()
	return entry.generation
}

func (r *helperRegistry) attachReserved(key HelperKey, generation uint64, process helperProcess, commandMode string) (*trackedHelper, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry := r.current[key]
	if entry == nil || entry.generation != generation || entry.state != helperStarting {
		return nil, false
	}
	entry.process = process
	entry.launchedAt = time.Now()
	entry.executablePath = process.ExecutablePath()
	entry.commandMode = commandMode
	return entry, true
}

func (r *helperRegistry) noteSpawnFailure(key HelperKey, generation uint64) {
	r.mu.Lock()
	entry := r.generation[generation]
	if entry != nil && entry.key == key {
		entry.state = helperExited
		entry.doneOnce.Do(func() { close(entry.done) })
		delete(r.generation, generation)
	}
	r.mu.Unlock()
}

func (r *helperRegistry) noteExit(key HelperKey, generation uint64, exitCode int) {
	r.mu.Lock()
	entry := r.generation[generation]
	if entry == nil || entry.key != key {
		r.mu.Unlock()
		return
	}
	entry.exitCode = exitCode
	entry.state = helperExited
	entry.brokerSession = nil
	if exitCode == helperFatalExitCode {
		entry.fatalExitUntil = time.Now().Add(fatalCooldown)
	}
	entry.doneOnce.Do(func() { close(entry.done) })
	delete(r.generation, generation)
	if current := r.current[key]; current != entry {
		// A newer generation owns the one-process slot.
	} else {
		r.current[key] = entry
	}
	r.mu.Unlock()
}

func (r *helperRegistry) detach(key HelperKey, generation uint64) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry := r.current[key]
	if entry == nil || entry.generation != generation {
		return false
	}
	if entry.state != helperStopping && entry.process != nil && entry.process.Alive() {
		return false
	}
	delete(r.current, key)
	return true
}

func (r *helperRegistry) beginStop(key HelperKey) *trackedHelper {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry := r.current[key]
	if entry == nil {
		return nil
	}
	if entry.state == helperExited {
		delete(r.current, key)
		return nil
	}
	if entry.state == helperStopping {
		return nil
	}
	entry.state = helperStopping
	return entry
}

func (r *helperRegistry) markConnected(key HelperKey, pid uint32, session *Session) {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry := r.current[key]
	if entry == nil || entry.process == nil || entry.process.ProcessID() != pid || entry.state == helperStopping {
		return
	}
	entry.state = helperConnected
	entry.retryCount = 0
	entry.lastFailure = time.Time{}
	entry.brokerSession = session
}

func (r *helperRegistry) markSessionClosed(key HelperKey, session *Session) {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry := r.current[key]
	if entry == nil || entry.brokerSession != session {
		return
	}
	entry.brokerSession = nil
	if entry.process != nil && entry.process.Alive() {
		entry.state = helperStarting
	} else {
		entry.state = helperExited
	}
}

func (r *helperRegistry) clearFatal(sessionID uint32) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, role := range []string{"system", "user"} {
		if entry := r.current[HelperKey{WindowsSessionID: sessionID, Role: role}]; entry != nil {
			entry.fatalExitUntil = time.Time{}
		}
	}
}

func (r *helperRegistry) processID(key HelperKey) uint32 {
	r.mu.Lock()
	defer r.mu.Unlock()
	if entry := r.current[key]; entry != nil && entry.process != nil {
		return entry.process.ProcessID()
	}
	return 0
}

func (r *helperRegistry) keys() []HelperKey {
	r.mu.Lock()
	defer r.mu.Unlock()
	keys := make([]HelperKey, 0, len(r.current))
	for key, entry := range r.current {
		if entry.state != helperExited {
			keys = append(keys, key)
		}
	}
	return keys
}

func (r *helperRegistry) len() int {
	return len(r.keys())
}
