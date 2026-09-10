package sessionbroker

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestSetClearBackupSession(t *testing.T) {
	b := &Broker{
		sessions:   make(map[string]*Session),
		byIdentity: make(map[string][]*Session),
	}

	s := &Session{SessionID: "backup-test"}
	b.SetBackupSession(s)

	b.mu.RLock()
	if b.backup == nil || b.backup.session == nil {
		b.mu.RUnlock()
		t.Fatal("expected backup session to be set")
	}
	if b.backup.session.SessionID != "backup-test" {
		b.mu.RUnlock()
		t.Errorf("got %s, want backup-test", b.backup.session.SessionID)
	}
	b.mu.RUnlock()

	if !b.ClearBackupSession(s) {
		t.Fatal("expected current backup session to be cleared")
	}
	b.mu.RLock()
	if b.backup.session != nil {
		b.mu.RUnlock()
		t.Error("expected backup session to be cleared")
	}
	b.mu.RUnlock()
}

func TestClearBackupSessionDoesNotClearNewerOwner(t *testing.T) {
	b := New("test", nil)
	oldSession := &Session{SessionID: "old-backup"}
	newSession := &Session{SessionID: "new-backup"}
	b.SetBackupSession(newSession)

	if b.ClearBackupSession(oldSession) {
		t.Fatal("stale backup disconnect cleared the singleton")
	}
	b.mu.RLock()
	got := b.backup.session
	b.mu.RUnlock()
	if got != newSession {
		t.Fatalf("backup owner = %v, want newer session", got)
	}
	if !b.ClearBackupSession(newSession) {
		t.Fatal("current backup disconnect did not clear the singleton")
	}
}

// TestBackupSessionStateConcurrentAccessIsRaceFree exercises SetBackupSession,
// ClearBackupSession, StopBackupHelperIfIdle and a raw session read
// concurrently. b.mu only ever guards the b.backup pointer itself; bh.session
// (and every other backupHelper field) is guarded by bh.mu, so a correct
// reader fetches bh under b.mu and then reads session under bh.mu -- exactly
// as GetOrSpawnBackupHelper and ForwardBackupCommand do.
func TestBackupSessionStateConcurrentAccessIsRaceFree(t *testing.T) {
	b := New("test", nil)
	b.backup = &backupHelper{}
	sessions := []*Session{{SessionID: "one"}, {SessionID: "two"}}

	var wg sync.WaitGroup
	for worker := range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range 500 {
				session := sessions[(worker+i)%len(sessions)]
				switch worker {
				case 0:
					b.SetBackupSession(session)
				case 1:
					b.ClearBackupSession(session)
				case 2:
					b.StopBackupHelperIfIdle()
				default:
					b.mu.RLock()
					bh := b.backup
					b.mu.RUnlock()
					bh.mu.Lock()
					_ = bh.session
					bh.mu.Unlock()
				}
			}
		}()
	}
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("concurrent backup session access deadlocked")
	}
}

func TestStopBackupHelper_NilBroker(t *testing.T) {
	b := &Broker{
		sessions:   make(map[string]*Session),
		byIdentity: make(map[string][]*Session),
	}
	// Should not panic when backup is nil
	b.StopBackupHelper()
}

// TestStopBackupHelper_NoActiveRuns_KillsImmediately locks down the
// pre-existing behaviour: with nothing tracked in activeRuns, StopBackupHelper
// kills the resident process and clears state right away, with no grace wait.
func TestStopBackupHelper_NoActiveRuns_KillsImmediately(t *testing.T) {
	cmd := exec.Command(os.Args[0], "-test.run=TestHelperProcess")
	cmd.Env = append(os.Environ(), "GO_WANT_HELPER_PROCESS=1")
	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start test helper process: %v", err)
	}
	defer func() { _, _ = cmd.Process.Wait() }()

	b := &Broker{
		sessions:   make(map[string]*Session),
		byIdentity: make(map[string][]*Session),
		backup: &backupHelper{
			process: cmd.Process,
			session: &Session{SessionID: "backup-stop-idle"},
		},
	}

	start := time.Now()
	b.StopBackupHelper()
	elapsed := time.Since(start)

	if b.backup.process != nil {
		t.Fatalf("expected process to be cleared, got %+v", b.backup.process)
	}
	if b.backup.session != nil {
		t.Fatalf("expected session to be cleared, got %+v", b.backup.session)
	}
	if elapsed > 500*time.Millisecond {
		t.Fatalf("expected an immediate kill with no active runs, took %v", elapsed)
	}
}

// TestStopBackupHelper_ActiveRun_WaitsThenKillsAnyway proves change B (D3):
// a run still active when StopBackupHelper is called (the SCM/graceful-stop
// path) must not be silently dropped by an unconditional kill. It waits up
// to backupHelperStopGrace for the run to drain, then kills the process
// anyway so agent shutdown still completes inside its own budget
// (agentapp/shutdown_budget.go).
func TestStopBackupHelper_ActiveRun_WaitsThenKillsAnyway(t *testing.T) {
	orig := backupHelperStopGrace
	backupHelperStopGrace = 150 * time.Millisecond
	defer func() { backupHelperStopGrace = orig }()

	cmd := exec.Command(os.Args[0], "-test.run=TestHelperProcess")
	cmd.Env = append(os.Environ(), "GO_WANT_HELPER_PROCESS=1")
	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start test helper process: %v", err)
	}
	defer func() { _, _ = cmd.Process.Wait() }()

	b := &Broker{
		sessions:   make(map[string]*Session),
		byIdentity: make(map[string][]*Session),
		backup: &backupHelper{
			process: cmd.Process,
			session: &Session{SessionID: "backup-stop-active"},
			activeRuns: map[string]backupRunState{
				"cmd-1": backupRunExecuting,
			},
		},
	}

	start := time.Now()
	b.StopBackupHelper()
	elapsed := time.Since(start)

	if elapsed < backupHelperStopGrace {
		t.Fatalf("expected StopBackupHelper to wait out the grace (%v) before killing, only waited %v", backupHelperStopGrace, elapsed)
	}
	if b.backup.process != nil {
		t.Fatalf("expected process to be killed once the grace expired, got %+v", b.backup.process)
	}
	if b.backup.session != nil {
		t.Fatalf("expected session to be cleared, got %+v", b.backup.session)
	}
}

// TestStopBackupHelper_ActiveRun_DrainsBeforeGraceReturnsEarly proves
// StopBackupHelper polls activeRuns rather than unconditionally sleeping the
// full grace: a run that finishes mid-wait lets the stop proceed well before
// backupHelperStopGrace elapses.
func TestStopBackupHelper_ActiveRun_DrainsBeforeGraceReturnsEarly(t *testing.T) {
	origGrace := backupHelperStopGrace
	backupHelperStopGrace = 5 * time.Second
	defer func() { backupHelperStopGrace = origGrace }()
	origPoll := backupHelperStopPollInterval
	backupHelperStopPollInterval = 20 * time.Millisecond
	defer func() { backupHelperStopPollInterval = origPoll }()

	cmd := exec.Command(os.Args[0], "-test.run=TestHelperProcess")
	cmd.Env = append(os.Environ(), "GO_WANT_HELPER_PROCESS=1")
	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start test helper process: %v", err)
	}
	defer func() { _, _ = cmd.Process.Wait() }()

	bh := &backupHelper{
		process: cmd.Process,
		session: &Session{SessionID: "backup-stop-drain"},
		activeRuns: map[string]backupRunState{
			"cmd-1": backupRunExecuting,
		},
	}
	b := &Broker{
		sessions:   make(map[string]*Session),
		byIdentity: make(map[string][]*Session),
		backup:     bh,
	}

	go func() {
		time.Sleep(80 * time.Millisecond)
		bh.mu.Lock()
		delete(bh.activeRuns, "cmd-1")
		bh.mu.Unlock()
	}()

	start := time.Now()
	b.StopBackupHelper()
	elapsed := time.Since(start)

	if elapsed >= backupHelperStopGrace {
		t.Fatalf("expected an early return once the run drained, took the full grace (%v)", elapsed)
	}
	if elapsed < 80*time.Millisecond {
		t.Fatalf("returned before the run actually drained (%v)", elapsed)
	}
	if b.backup.process != nil {
		t.Fatalf("expected process to be killed once drained, got %+v", b.backup.process)
	}
}

func TestForwardBackupCommand_NotConnected(t *testing.T) {
	b := &Broker{
		sessions:   make(map[string]*Session),
		byIdentity: make(map[string][]*Session),
	}
	_, err := b.ForwardBackupCommand("cmd-1", "backup_run", nil, 5e9, false)
	if err == nil {
		t.Fatal("expected error when backup helper not connected")
	}
}

// TestForwardBackupCommand_ThreadsAsyncFlag proves the async parameter reaches
// the helper on the wire as BackupCommandRequest.Async, and that the sync
// (false) path is unaffected — the field must default off so an old server
// (whose forwarder never passes true) round-trips a byte-identical request.
func TestForwardBackupCommand_ThreadsAsyncFlag(t *testing.T) {
	tests := []struct {
		name  string
		async bool
	}{
		{"async true", true},
		{"async false (compat default)", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			serverConn, clientConn := net.Pipe()
			defer func() { _ = serverConn.Close() }()
			defer func() { _ = clientConn.Close() }()

			brokerSideConn := ipc.NewConn(serverConn)
			helperSideConn := ipc.NewConn(clientConn)

			s := &Session{
				SessionID: "backup-async-test",
				conn:      brokerSideConn,
				pending:   make(map[string]pendingResponse),
				done:      make(chan struct{}),
			}
			go s.RecvLoop(func(*Session, *ipc.Envelope) {})

			b := &Broker{
				sessions:   make(map[string]*Session),
				byIdentity: make(map[string][]*Session),
			}
			b.SetBackupSession(s)

			reqCh := make(chan backupipc.BackupCommandRequest, 1)
			go func() {
				env, err := helperSideConn.Recv()
				if err != nil {
					return
				}
				var req backupipc.BackupCommandRequest
				if jsonErr := json.Unmarshal(env.Payload, &req); jsonErr != nil {
					return
				}
				reqCh <- req
				result := backupipc.BackupCommandResult{CommandID: req.CommandID, Success: true}
				_ = helperSideConn.SendTyped(env.ID, backupipc.TypeBackupResult, result)
			}()

			if _, err := b.ForwardBackupCommand("cmd-async-1", "backup_run", nil, 5*time.Second, tt.async); err != nil {
				t.Fatalf("ForwardBackupCommand error: %v", err)
			}

			select {
			case req := <-reqCh:
				if req.Async != tt.async {
					t.Fatalf("got Async=%v, want %v", req.Async, tt.async)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("timed out waiting for helper to receive request")
			}
		})
	}
}

func TestBackupHelperScopes(t *testing.T) {
	if len(backupHelperScopes) != 1 || backupHelperScopes[0] != "backup" {
		t.Errorf("unexpected backup helper scopes: %v", backupHelperScopes)
	}
}

func TestHelperRoleBackupConstant(t *testing.T) {
	if backupipc.HelperRoleBackup != "backup" {
		t.Errorf("expected 'backup', got %s", backupipc.HelperRoleBackup)
	}
}

func TestBackupRoleRequiresPrivilegedIdentity(t *testing.T) {
	tests := []struct {
		name       string
		goos       string
		sid        string
		uid        uint32
		wantReject bool
		wantReason string
	}{
		{
			name:       "Windows user is rejected",
			goos:       "windows",
			sid:        "S-1-5-21-1-2-3-1001",
			wantReject: true,
			wantReason: "backup role requires SYSTEM identity",
		},
		{name: "Windows SYSTEM is allowed", goos: "windows", sid: systemSID},
		{
			name:       "Linux user is rejected",
			goos:       "linux",
			uid:        1000,
			wantReject: true,
			wantReason: "backup role requires root identity",
		},
		{name: "Linux root is allowed", goos: "linux", uid: 0},
		{
			name:       "macOS user is rejected",
			goos:       "darwin",
			uid:        501,
			wantReject: true,
			wantReason: "backup role requires root identity",
		},
		{name: "macOS root is allowed", goos: "darwin", uid: 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reason, rejected := roleIdentityRejection(
				backupipc.HelperRoleBackup, tt.sid, tt.uid, "0", "0", "0", tt.goos,
			)
			if rejected != tt.wantReject {
				t.Fatalf("rejected = %v, want %v (reason %q)", rejected, tt.wantReject, reason)
			}
			if reason != tt.wantReason {
				t.Fatalf("reason = %q, want %q", reason, tt.wantReason)
			}
		})
	}
}

func readyBackupSpawnReservation(pid uint32) *backupSpawnReservation {
	ready := make(chan struct{})
	close(ready)
	return &backupSpawnReservation{
		ready:     ready,
		pid:       pid,
		published: true,
	}
}

func TestBackupHelperAdmissionRequiresAgentSpawnReservation(t *testing.T) {
	t.Run("no agent spawn", func(t *testing.T) {
		b := New("test", nil)
		if _, err := b.claimBackupHelperAdmission(41); !errors.Is(err, errBackupHelperNotReserved) {
			t.Fatalf("claim error = %v, want %v", err, errBackupHelperNotReserved)
		}
	})

	t.Run("wrong pid does not consume exact reservation", func(t *testing.T) {
		reservation := readyBackupSpawnReservation(42)
		b := New("test", nil)
		b.backup = &backupHelper{spawnDone: make(chan struct{}), reservation: reservation, process: &os.Process{Pid: 42}}

		if _, err := b.claimBackupHelperAdmission(41); !errors.Is(err, errBackupHelperPeerMismatch) {
			t.Fatalf("wrong-pid claim error = %v, want %v", err, errBackupHelperPeerMismatch)
		}
		if _, err := b.claimBackupHelperAdmission(42); err != nil {
			t.Fatalf("exact-pid claim: %v", err)
		}
		if _, err := b.claimBackupHelperAdmission(42); !errors.Is(err, errBackupHelperReservationUsed) {
			t.Fatalf("replayed claim error = %v, want %v", err, errBackupHelperReservationUsed)
		}
	})

	t.Run("failed spawn is rejected", func(t *testing.T) {
		reservation := readyBackupSpawnReservation(0)
		reservation.startErr = errors.New("synthetic start failure")
		b := New("test", nil)
		b.backup = &backupHelper{spawnDone: make(chan struct{}), reservation: reservation}
		if _, err := b.claimBackupHelperAdmission(42); !errors.Is(err, errBackupHelperReservationFailed) {
			t.Fatalf("claim error = %v, want %v", err, errBackupHelperReservationFailed)
		}
	})
}

func TestBackupHelperAdmissionConcurrentClaimIsSingleUse(t *testing.T) {
	reservation := readyBackupSpawnReservation(42)
	b := New("test", nil)
	b.backup = &backupHelper{spawnDone: make(chan struct{}), reservation: reservation, process: &os.Process{Pid: 42}}

	start := make(chan struct{})
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := b.claimBackupHelperAdmission(42)
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errs)

	var accepted, replayed int
	for err := range errs {
		switch {
		case err == nil:
			accepted++
		case errors.Is(err, errBackupHelperReservationUsed):
			replayed++
		default:
			t.Fatalf("unexpected claim error: %v", err)
		}
	}
	if accepted != 1 || replayed != 1 {
		t.Fatalf("accepted=%d replayed=%d, want 1/1", accepted, replayed)
	}
}

func TestBackupHelperAdmissionWaitsForSpawnedPIDPublication(t *testing.T) {
	reservation := &backupSpawnReservation{ready: make(chan struct{})}
	b := New("test", nil)
	b.backup = &backupHelper{spawnDone: make(chan struct{}), reservation: reservation}

	errCh := make(chan error, 1)
	go func() {
		_, err := b.claimBackupHelperAdmission(42)
		errCh <- err
	}()

	b.backup.mu.Lock()
	b.backup.process = &os.Process{Pid: 42}
	reservation.pid = 42
	reservation.published = true
	close(reservation.ready)
	b.backup.mu.Unlock()

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("claim after PID publication: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("claim did not resume after PID publication")
	}
}

func TestBackupSessionRegistrationRequiresClaimedReservation(t *testing.T) {
	reservation := readyBackupSpawnReservation(42)
	b := New("test", nil)
	b.backup = &backupHelper{spawnDone: make(chan struct{}), reservation: reservation, process: &os.Process{Pid: 42}}

	unclaimed, unclaimedClient := newPairedSession(t, "unclaimed", "0")
	defer unclaimedClient.Close()
	unclaimed.HelperRole = backupipc.HelperRoleBackup
	if err := b.registerNonLifecycleSession("0", backupipc.HelperRoleBackup, unclaimed, reservation); !errors.Is(err, errBackupHelperNotReserved) {
		t.Fatalf("unclaimed registration error = %v, want %v", err, errBackupHelperNotReserved)
	}

	claimed, err := b.claimBackupHelperAdmission(42)
	if err != nil {
		t.Fatalf("claim exact reservation: %v", err)
	}
	accepted, acceptedClient := newPairedSession(t, "accepted", "0")
	defer acceptedClient.Close()
	accepted.HelperRole = backupipc.HelperRoleBackup
	if err := b.registerNonLifecycleSession("0", backupipc.HelperRoleBackup, accepted, claimed); err != nil {
		t.Fatalf("claimed registration: %v", err)
	}
	if b.backup.session != accepted || !reservation.committed {
		t.Fatal("claimed reservation did not publish the exact backup session")
	}

	replay, replayClient := newPairedSession(t, "replay", "0")
	defer replayClient.Close()
	replay.HelperRole = backupipc.HelperRoleBackup
	if err := b.registerNonLifecycleSession("0", backupipc.HelperRoleBackup, replay, claimed); !errors.Is(err, errBackupHelperNotReserved) {
		t.Fatalf("replayed registration error = %v, want %v", err, errBackupHelperNotReserved)
	}
}

func TestBackupSessionRegistrationDoesNotReplaceLiveOwner(t *testing.T) {
	reservation := readyBackupSpawnReservation(42)
	existing := &Session{SessionID: "existing"}
	b := New("test", nil)
	b.backup = &backupHelper{
		spawnDone:   make(chan struct{}),
		reservation: reservation,
		process:     &os.Process{Pid: 42},
		session:     existing,
	}
	claimed, err := b.claimBackupHelperAdmission(42)
	if err != nil {
		t.Fatalf("claim exact reservation: %v", err)
	}

	replacement, replacementClient := newPairedSession(t, "replacement", "0")
	defer replacementClient.Close()
	replacement.HelperRole = backupipc.HelperRoleBackup
	if err := b.registerNonLifecycleSession("0", backupipc.HelperRoleBackup, replacement, claimed); !errors.Is(err, errBackupHelperAlreadyConnected) {
		t.Fatalf("replacement registration error = %v, want %v", err, errBackupHelperAlreadyConnected)
	}
	if b.backup.session != existing {
		t.Fatal("rejected replacement changed the live backup owner")
	}
}

// TestBackupBinaryName pins the platform-suffix contract for the breeze-backup
// helper. The helper is built for every supported OS (see agent/Makefile), and
// is installed as breeze-backup.exe on Windows but breeze-backup elsewhere. The
// original bug resolved the sibling fallback as "breeze-backup" on every OS, so
// on Windows os.Stat could never find the installed breeze-backup.exe and every
// backup run failed with "backup binary not found". No non-Windows CI run could
// have caught it, hence this GOOS-parameterized test.
func TestBackupBinaryName(t *testing.T) {
	tests := []struct {
		goos string
		want string
	}{
		{"windows", "breeze-backup.exe"},
		{"linux", "breeze-backup"},
		{"darwin", "breeze-backup"},
	}
	for _, tt := range tests {
		if got := backupBinaryName(tt.goos); got != tt.want {
			t.Errorf("backupBinaryName(%q) = %q, want %q", tt.goos, got, tt.want)
		}
	}
}

// TestStopBackupHelperIfIdle_NilBroker: nothing spawned yet — nothing blocks
// a swap, so it must report idle (true) rather than panic or false-positive
// "busy".
func TestStopBackupHelperIfIdle_NilBroker(t *testing.T) {
	b := &Broker{
		sessions:   make(map[string]*Session),
		byIdentity: make(map[string][]*Session),
	}
	if !b.StopBackupHelperIfIdle() {
		t.Fatal("expected idle=true when no backup helper has ever been spawned")
	}
}

// TestStopBackupHelperIfIdle_ActiveRunBlocks: a tracked in-flight run (any
// state — pending-ack, executing, or the doomed tombstone) must defer the
// swap rather than kill a helper mid-job.
func TestStopBackupHelperIfIdle_ActiveRunBlocks(t *testing.T) {
	for _, state := range []backupRunState{backupRunPendingAck, backupRunExecuting, backupRunDoomed} {
		b := &Broker{
			sessions:   make(map[string]*Session),
			byIdentity: make(map[string][]*Session),
			backup: &backupHelper{
				activeRuns: map[string]backupRunState{"cmd-1": state},
			},
		}
		if b.StopBackupHelperIfIdle() {
			t.Fatalf("expected idle=false with an active run in state %v", state)
		}
		// The tracked run must be left untouched — deferring must not itself
		// mutate broker state.
		if len(b.backup.activeRuns) != 1 {
			t.Fatalf("expected activeRuns to be untouched by a deferred check, got %v", b.backup.activeRuns)
		}
	}
}

// TestStopBackupHelperIfIdle_IdleStopsProcessAndClearsSession verifies the
// success path: no active runs, so the resident process is killed, process
// and session are cleared, and the call reports idle=true.
func TestStopBackupHelperIfIdle_IdleStopsProcessAndClearsSession(t *testing.T) {
	// Re-exec this test binary as a long-lived helper process (the standard
	// os/exec self-exec pattern) rather than shelling out to `sleep`, which
	// doesn't exist on Windows — this package's tests run in the Windows CI
	// job (see ci.yml test-agent-windows). See TestHelperProcess below.
	cmd := exec.Command(os.Args[0], "-test.run=TestHelperProcess")
	cmd.Env = append(os.Environ(), "GO_WANT_HELPER_PROCESS=1")
	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start test helper process: %v", err)
	}
	defer func() { _, _ = cmd.Process.Wait() }()

	b := &Broker{
		sessions:   make(map[string]*Session),
		byIdentity: make(map[string][]*Session),
		backup: &backupHelper{
			process: cmd.Process,
			session: &Session{SessionID: "backup-idle-test"},
		},
	}

	if !b.StopBackupHelperIfIdle() {
		t.Fatal("expected idle=true with no active runs")
	}
	if b.backup.process != nil {
		t.Fatalf("expected process to be cleared, got %+v", b.backup.process)
	}
	if b.backup.session != nil {
		t.Fatalf("expected session to be cleared, got %+v", b.backup.session)
	}
}

// TestActiveBackupRunCount_NilBroker verifies a broker that has never
// spawned a backup helper reports 0 rather than panicking — the heartbeat's
// state_sync sender (sendWatchdogStateSync) calls this unconditionally on
// every tick, including before any backup has ever run.
func TestActiveBackupRunCount_NilBroker(t *testing.T) {
	b := &Broker{
		sessions:   make(map[string]*Session),
		byIdentity: make(map[string][]*Session),
	}
	if got := b.ActiveBackupRunCount(); got != 0 {
		t.Fatalf("expected 0 with no backup helper ever spawned, got %d", got)
	}
}

// TestActiveBackupRunCount_ReflectsActiveRuns verifies the count is read
// straight from activeRuns, regardless of which per-run state (pending-ack,
// executing, doomed) each entry is in — CheckIPC's D3 veto (checks.go) needs
// this to reflect "any run this helper is tracking", not just confirmed-
// executing ones.
func TestActiveBackupRunCount_ReflectsActiveRuns(t *testing.T) {
	b := &Broker{
		sessions:   make(map[string]*Session),
		byIdentity: make(map[string][]*Session),
		backup: &backupHelper{
			activeRuns: map[string]backupRunState{
				"cmd-1": backupRunPendingAck,
				"cmd-2": backupRunExecuting,
				"cmd-3": backupRunDoomed,
			},
		},
	}
	if got := b.ActiveBackupRunCount(); got != 3 {
		t.Fatalf("expected 3 active runs, got %d", got)
	}
}

// TestActiveBackupRunCount_ZeroWhenEmpty verifies a spawned-but-idle helper
// (backup non-nil, no tracked runs) reports 0, not some sentinel.
func TestActiveBackupRunCount_ZeroWhenEmpty(t *testing.T) {
	b := &Broker{
		sessions:   make(map[string]*Session),
		byIdentity: make(map[string][]*Session),
		backup:     &backupHelper{},
	}
	if got := b.ActiveBackupRunCount(); got != 0 {
		t.Fatalf("expected 0 with an idle helper, got %d", got)
	}
}

// TestHelperProcess is not a real test — it's the re-exec target for
// TestStopBackupHelperIfIdle_IdleStopsProcessAndClearsSession's cross-platform
// long-lived-process stand-in. It no-ops unless GO_WANT_HELPER_PROCESS=1 is
// set, so a normal `go test` run treats it as a (trivially passing) test.
func TestHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_HELPER_PROCESS") != "1" {
		return
	}
	time.Sleep(30 * time.Second)
	os.Exit(0)
}

func TestGetOrSpawnBackupHelper_ExistingSession(t *testing.T) {
	b := &Broker{
		sessions:   make(map[string]*Session),
		byIdentity: make(map[string][]*Session),
	}

	// Pre-set a backup session
	s := &Session{
		SessionID: "backup-existing",
		conn:      &ipc.Conn{},
		pending:   make(map[string]pendingResponse),
	}
	b.SetBackupSession(s)

	got, err := b.GetOrSpawnBackupHelper("")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.SessionID != "backup-existing" {
		t.Errorf("got %s, want backup-existing", got.SessionID)
	}
}

// TestGetOrSpawnBackupHelper_ConcurrentCallersWaitForSpawn covers the case
// where a profile with `file` + `system_image` selections dispatches two
// backup_run commands within milliseconds of each other. The first caller
// spawns the helper; the second caller must WAIT for that in-flight spawn to
// finish and then reuse the resulting session, instead of failing instantly
// with "backup helper is already being spawned".
//
// It simulates the in-flight spawn without a real process by setting
// bh.spawnDone directly (what spawnBackupHelper does at the start of a real
// spawn attempt), then -- from the test goroutine, after the concurrent
// caller has had a chance to observe it and start waiting -- completing that
// spawn the way the real spawning goroutine's deferred cleanup does:
// attaching the session and closing spawnDone under bh.mu.
func TestGetOrSpawnBackupHelper_ConcurrentCallersWaitForSpawn(t *testing.T) {
	b := &Broker{
		sessions:   make(map[string]*Session),
		byIdentity: make(map[string][]*Session),
	}

	bh := &backupHelper{spawnDone: make(chan struct{})}
	b.backup = bh

	type result struct {
		session *Session
		err     error
	}
	resultCh := make(chan result, 1)

	go func() {
		s, err := b.GetOrSpawnBackupHelper("")
		resultCh <- result{s, err}
	}()

	time.Sleep(50 * time.Millisecond)

	s := &Session{
		SessionID: "backup-concurrent",
		conn:      &ipc.Conn{},
		pending:   make(map[string]pendingResponse),
	}

	// Complete the in-flight spawn the way the real spawning goroutine does:
	// attach the session and close spawnDone, all under bh.mu.
	bh.mu.Lock()
	bh.session = s
	done := bh.spawnDone
	bh.spawnDone = nil
	close(done)
	bh.mu.Unlock()

	select {
	case res := <-resultCh:
		if res.err != nil {
			t.Fatalf("unexpected error: %v", res.err)
		}
		if res.session == nil || res.session.SessionID != "backup-concurrent" {
			t.Fatalf("got %+v, want session backup-concurrent", res.session)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for concurrent caller to return")
	}
}

// TestGetOrSpawnBackupHelper_ConcurrentCallerSeesSpawnFailure: when the
// in-flight spawn finishes WITHOUT producing a session (the spawn failed), a
// concurrent waiter must get a non-nil error mentioning the spawn failure --
// not hang, and not silently succeed with a nil session.
func TestGetOrSpawnBackupHelper_ConcurrentCallerSeesSpawnFailure(t *testing.T) {
	b := &Broker{
		sessions:   make(map[string]*Session),
		byIdentity: make(map[string][]*Session),
	}

	bh := &backupHelper{spawnDone: make(chan struct{})}
	b.backup = bh

	type result struct {
		session *Session
		err     error
	}
	resultCh := make(chan result, 1)

	go func() {
		s, err := b.GetOrSpawnBackupHelper("")
		resultCh <- result{s, err}
	}()

	time.Sleep(50 * time.Millisecond)

	// The in-flight spawn finishes WITHOUT a session: record the failure and
	// close spawnDone, exactly as spawnBackupHelper's deferred cleanup does
	// on a failed attempt.
	spawnFailure := errors.New("backup binary not found at /nonexistent: stat /nonexistent: no such file or directory")
	bh.mu.Lock()
	bh.spawnErr = spawnFailure
	done := bh.spawnDone
	bh.spawnDone = nil
	close(done)
	bh.mu.Unlock()

	select {
	case res := <-resultCh:
		if res.err == nil {
			t.Fatal("expected an error when the concurrent spawn failed, got nil")
		}
		if res.session != nil {
			t.Fatalf("expected nil session on spawn failure, got %+v", res.session)
		}
		if !strings.Contains(res.err.Error(), spawnFailure.Error()) {
			t.Errorf("expected error to mention the concurrent spawn failure %q, got %q", spawnFailure.Error(), res.err.Error())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for concurrent caller to return")
	}
}
