package sessionbroker

import (
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

const (
	maxBackoff          = 30 * time.Second
	maxSpawnRetries     = 10
	fatalCooldown       = 10 * time.Minute
	helperFatalExitCode = 2
	helperPanicExitCode = 3

	// helperStartupTimeout bounds how long a helper may sit in helperStarting —
	// launched but not yet connected over IPC — before the lifecycle manager
	// terminates and respawns it.
	//
	// 90s is a conservative guess, NOT a measured value: it must exceed a cold
	// helper start on a loaded RDS host, and no such measurement exists yet. Too
	// low kills healthy slow-starting helpers in a respawn loop, so err high. If
	// the "never reached IPC within startup timeout" warning shows up in fleet
	// logs for helpers that were merely slow, raise this.
	//
	// Bounded by design: this only ever terminates a helper that has NOT
	// connected. main's deleted KillStaleHelpers was strictly more aggressive —
	// it killed before EVERY respawn with no timeout at all.
	helperStartupTimeout = 90 * time.Second
)

type SCMSessionEvent struct {
	EventType uint32
	SessionID uint32
}

type helperProcess interface {
	ProcessID() uint32
	ExecutablePath() string
	// Alive reports liveness. A non-nil error means liveness is UNKNOWN, not
	// false: callers must fail closed and treat unknown as alive. Matches
	// ownedPeerProcess.Alive so the two cannot be confused at a glance.
	Alive() (bool, error)
	Terminate() error
	Wait() (int, error)
	Close() error
}

type helperSpawner interface {
	Spawn(HelperKey) (helperProcess, error)
	Close() error
}

type ownedPeerProcess interface {
	ProcessID() uint32
	Alive() (bool, error)
	Terminate() error
	Close() error
}

type ownedPeerProcessState uint8

const (
	peerProcessActive ownedPeerProcessState = iota
	peerProcessTerminationClaimed
	peerProcessConsumed
)

type ownedPeerProcessRef struct {
	mu      sync.Mutex
	process ownedPeerProcess
	state   ownedPeerProcessState
}

func newOwnedPeerProcessRef(process ownedPeerProcess) *ownedPeerProcessRef {
	if process == nil {
		return nil
	}
	return &ownedPeerProcessRef{process: process, state: peerProcessActive}
}

type ownedPeerTerminationClaim struct {
	ref     *ownedPeerProcessRef
	process ownedPeerProcess
}

func (r *ownedPeerProcessRef) claimTermination() *ownedPeerTerminationClaim {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.state != peerProcessActive || r.process == nil {
		return nil
	}
	r.state = peerProcessTerminationClaimed
	return &ownedPeerTerminationClaim{ref: r, process: r.process}
}

func (c *ownedPeerTerminationClaim) terminateAndClose() error {
	if c == nil || c.process == nil {
		return nil
	}
	terminateErr := c.process.Terminate()
	closeErr := c.process.Close()
	c.ref.mu.Lock()
	c.ref.state = peerProcessConsumed
	c.ref.process = nil
	c.ref.mu.Unlock()
	if terminateErr != nil {
		return terminateErr
	}
	return closeErr
}

func (r *ownedPeerProcessRef) close() error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	if r.state != peerProcessActive || r.process == nil {
		r.mu.Unlock()
		return nil
	}
	process := r.process
	r.process = nil
	r.state = peerProcessConsumed
	r.mu.Unlock()
	return process.Close()
}

type HelperLifecycleManager struct {
	broker   *Broker
	detector SessionDetector
	scmCh    <-chan SCMSessionEvent
	spawner  helperSpawner
	registry *helperRegistry

	mu             sync.Mutex
	desired        map[HelperKey]bool
	stopping       bool
	observerRemove func()
	stopOnce       sync.Once
	stopCh         chan struct{}
	done           chan struct{}
	doneOnce       sync.Once
	gracePeriod    time.Duration
	finalWait      time.Duration
}

func newHelperLifecycleManager(broker *Broker, detector SessionDetector, scmCh <-chan SCMSessionEvent, spawner helperSpawner) *HelperLifecycleManager {
	m := &HelperLifecycleManager{
		broker:      broker,
		detector:    detector,
		scmCh:       scmCh,
		spawner:     spawner,
		registry:    newHelperRegistry(),
		desired:     make(map[HelperKey]bool),
		done:        make(chan struct{}),
		stopCh:      make(chan struct{}),
		gracePeriod: 2 * time.Second,
		finalWait:   2 * time.Second,
	}
	if broker != nil {
		m.observerRemove = broker.AddSessionLifecycleObserver(m.sessionAuthenticated, m.sessionClosed)
	}
	return m
}

func (m *HelperLifecycleManager) Done() <-chan struct{} { return m.done }

func (m *HelperLifecycleManager) finishStart() {
	m.doneOnce.Do(func() { close(m.done) })
}

func (m *HelperLifecycleManager) detectedDesired() (map[HelperKey]bool, error) {
	if m.detector == nil {
		return map[HelperKey]bool{}, nil
	}
	sessions, err := m.detector.ListSessions()
	if err != nil {
		return nil, err
	}
	desired := make(map[HelperKey]bool, len(sessions)*2)
	for _, session := range sessions {
		if key, ok := helperKeyFromDetected(session, ipc.HelperRoleSystem); ok {
			desired[key] = true
		}
		if key, ok := helperKeyFromDetected(session, ipc.HelperRoleUser); ok {
			desired[key] = true
		}
	}
	return desired, nil
}

// Bootstrap publishes one detector snapshot without spawning. Heartbeat calls
// this before the broker starts accepting helpers so scheduled helpers can
// authenticate against authoritative desired state during startup.
func (m *HelperLifecycleManager) Bootstrap() error {
	if m.broker == nil {
		return nil
	}
	desired, err := m.detectedDesired()
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.stopping {
		return nil
	}
	m.desired = cloneDesired(desired)
	m.publishDesired(desired)
	return nil
}

func (m *HelperLifecycleManager) reconcile() {
	if m.detector == nil || m.broker == nil || m.spawner == nil {
		return
	}
	desired, err := m.detectedDesired()
	if err != nil {
		log.Warn("lifecycle: failed to list sessions", "error", err.Error())
		return
	}

	m.mu.Lock()
	if m.stopping {
		m.mu.Unlock()
		return
	}
	previousDesired := m.desired
	m.desired = cloneDesired(desired)
	m.publishDesired(desired)
	m.mu.Unlock()

	for key := range previousDesired {
		if !desired[key] {
			m.stopKey(key)
		}
	}
	for _, key := range m.registry.keys() {
		if !desired[key] {
			m.stopKey(key)
		}
	}
	// Recycle helpers that launched but never reached IPC. Without this a
	// helperStarting entry blocks reserve forever and nothing terminates the
	// process, so the session/role slot stays dead until the agent restarts.
	// Runs with m.mu released: stopTrackedKey takes the registry lock itself.
	now := time.Now()
	for key := range desired {
		if !m.registry.startupExpired(key, now, helperStartupTimeout) {
			continue
		}
		log.Warn("lifecycle: helper never reached IPC within startup timeout; recycling",
			"helperKey", key.String(), "timeout", helperStartupTimeout.String())
		m.stopTrackedKey(key)
	}
	for key := range desired {
		m.spawnKey(key)
	}
}

func cloneDesired(source map[HelperKey]bool) map[HelperKey]bool {
	copyMap := make(map[HelperKey]bool, len(source))
	for key, desired := range source {
		copyMap[key] = desired
	}
	return copyMap
}

func (m *HelperLifecycleManager) publishDesired(desired map[HelperKey]bool) {
	if m.broker == nil {
		return
	}
	snapshot := make(map[HelperKey]struct{}, len(desired))
	for key, wanted := range desired {
		if wanted {
			snapshot[key] = struct{}{}
		}
	}
	m.broker.UpdateDesiredHelperKeys(snapshot)
}

func (m *HelperLifecycleManager) spawnKey(key HelperKey) {
	m.mu.Lock()
	if m.stopping || !m.desired[key] {
		m.mu.Unlock()
		return
	}
	if !helperRoleSpawnable(key.Role) {
		m.mu.Unlock()
		log.Error("lifecycle: refusing to spawn helper for non-lifecycle role", "helperKey", key.String(), "role", key.Role)
		return
	}
	// helperKeySpawnBlocked blocks not only on a live authenticated owner but
	// also on a bounded post-kill retention window, so a scheduled helper that
	// survived a failed TerminateHelperKey cannot be duplicated by a respawn
	// while its PID is still alive (#2530).
	if m.broker != nil && m.broker.helperKeySpawnBlocked(key) {
		m.mu.Unlock()
		return
	}
	generation, reserved := m.registry.reserve(key, time.Now())
	m.mu.Unlock()
	if !reserved {
		return
	}
	process, err := m.spawner.Spawn(key)
	if err != nil {
		m.registry.noteSpawnFailure(key, generation)
		log.Warn("lifecycle: failed to spawn helper", "helperKey", key.String(), "error", err.Error())
		return
	}
	mode := string(key.Role) + "-helper"
	entry, attached := m.registry.attachReserved(key, generation, process, mode)
	if !attached {
		_ = process.Terminate()
		go m.watchDetachedProcess(key, generation, process)
		return
	}
	go m.watchProcess(entry)
	if m.broker != nil {
		if ownerPID, owned := m.broker.helperKeyOwnerPID(key); owned && ownerPID != process.ProcessID() {
			m.stopTrackedKey(key)
			return
		}
	}
	log.Info("proactively spawned helper in session", "helperKey", key.String(), "pid", process.ProcessID())
}

func (m *HelperLifecycleManager) watchProcess(entry *trackedHelper) {
	exitCode, err := entry.process.Wait()
	if err != nil {
		log.Warn("lifecycle: wait on helper process failed", "helperKey", entry.key.String(), "pid", entry.process.ProcessID(), "error", err.Error())
	}
	_ = entry.process.Close()
	m.registry.noteExit(entry.key, entry.generation, exitCode)
}

func (m *HelperLifecycleManager) watchDetachedProcess(key HelperKey, generation uint64, process helperProcess) {
	exitCode, err := process.Wait()
	_ = process.Close()
	if err != nil {
		// Mirror watchProcess: never swallow this. Wait returns (-1, err) on
		// failure, and recording -1 as a real exit code marks a possibly-live
		// helper exited.
		log.Warn("lifecycle: wait on detached helper process failed", "helperKey", key.String(), "pid", processID(process), "error", err.Error())
		m.registry.noteExitUnknown(key, generation)
		return
	}
	m.registry.noteExit(key, generation, exitCode)
}

func (m *HelperLifecycleManager) stopSession(sessionID uint32) {
	m.removeDesired(HelperKey{WindowsSessionID: sessionID, Role: ipc.HelperRoleSystem}, HelperKey{WindowsSessionID: sessionID, Role: ipc.HelperRoleUser})
	m.stopKey(HelperKey{WindowsSessionID: sessionID, Role: ipc.HelperRoleUser})
	m.stopKey(HelperKey{WindowsSessionID: sessionID, Role: ipc.HelperRoleSystem})
}

func (m *HelperLifecycleManager) removeDesired(keys ...HelperKey) {
	m.mu.Lock()
	for _, key := range keys {
		delete(m.desired, key)
	}
	desired := cloneDesired(m.desired)
	m.publishDesired(desired)
	m.mu.Unlock()
}

func (m *HelperLifecycleManager) stopKey(key HelperKey) {
	if m.broker != nil {
		m.broker.TerminateHelperKey(key)
	}
	m.stopTrackedKey(key)
}

func (m *HelperLifecycleManager) stopTrackedKey(key HelperKey) {
	entry := m.registry.beginStop(key)
	if entry == nil {
		return
	}
	if waitDone(entry.done, m.gracePeriod) {
		m.registry.detach(key, entry.generation)
		return
	}
	if entry.process != nil {
		alive, err := entry.process.Alive()
		if err != nil {
			log.Warn("lifecycle: helper liveness unknown; terminating to fail closed", "helperKey", key.String(), "pid", entry.process.ProcessID(), "error", err.Error())
		}
		if err != nil || alive {
			if err := entry.process.Terminate(); err != nil {
				log.Warn("lifecycle: failed to terminate helper", "helperKey", key.String(), "pid", entry.process.ProcessID(), "error", err.Error())
			}
		}
	}
	if waitDone(entry.done, m.finalWait) {
		m.registry.detach(key, entry.generation)
		return
	}
	if !m.registry.detach(key, entry.generation) {
		log.Warn("lifecycle: helper process did not reap before shutdown deadline; retaining live stopping generation", "helperKey", key.String(), "pid", processID(entry.process))
	}
}

func processID(process helperProcess) uint32 {
	if process == nil {
		return 0
	}
	return process.ProcessID()
}

func waitDone(done <-chan struct{}, timeout time.Duration) bool {
	if done == nil {
		return true
	}
	if timeout <= 0 {
		select {
		case <-done:
			return true
		default:
			return false
		}
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-done:
		return true
	case <-timer.C:
		return false
	}
}

func (m *HelperLifecycleManager) Stop() {
	m.stopOnce.Do(func() {
		close(m.stopCh)
		m.mu.Lock()
		m.stopping = true
		m.desired = make(map[HelperKey]bool)
		m.publishDesired(nil)
		m.mu.Unlock()
		keys := make(map[HelperKey]struct{})
		for _, key := range m.registry.keys() {
			keys[key] = struct{}{}
		}
		if m.broker != nil {
			for _, key := range m.broker.LifecycleHelperKeys() {
				keys[key] = struct{}{}
			}
		}
		var stopWG sync.WaitGroup
		for key := range keys {
			key := key
			stopWG.Add(1)
			go func() {
				defer stopWG.Done()
				m.stopKey(key)
			}()
		}
		stopWG.Wait()
		if m.spawner != nil {
			if err := m.spawner.Close(); err != nil {
				log.Warn("lifecycle: failed to close helper spawner", "error", err.Error())
			}
		}
		if m.observerRemove != nil {
			m.observerRemove()
		}
	})
}

func (m *HelperLifecycleManager) sessionAuthenticated(session *Session) {
	key, ok := helperKeyFromSession(session)
	if !ok {
		return
	}
	if m.broker == nil {
		return
	}
	rollbackProactive := false
	m.broker.whileHelperKeyOwnedBy(key, session, func() {
		trackedPID := m.registry.processID(key)
		if trackedPID != 0 && trackedPID != uint32(session.PID) {
			rollbackProactive = true
			return
		}
		m.registry.markConnected(key, uint32(session.PID), session)
	})
	if rollbackProactive {
		m.stopTrackedKey(key)
	}
}

func (m *HelperLifecycleManager) sessionClosed(session *Session) {
	key, ok := helperKeyFromSession(session)
	if !ok {
		return
	}
	m.registry.markSessionClosed(key, session)
}

func helperKeyFromSession(session *Session) (HelperKey, bool) {
	if session == nil || (session.HelperRole != ipc.HelperRoleSystem && session.HelperRole != ipc.HelperRoleUser) {
		return HelperKey{}, false
	}
	id, err := strconv.ParseUint(session.WinSessionID, 10, 32)
	if err != nil || id == 0 {
		return HelperKey{}, false
	}
	return HelperKey{WindowsSessionID: uint32(id), Role: session.HelperRole}, true
}

func (m *HelperLifecycleManager) String() string {
	return fmt.Sprintf("HelperLifecycleManager(tracked=%d)", m.registry.len())
}
