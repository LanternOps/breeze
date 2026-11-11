package heartbeat

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/security"
)

// recoveryKeyServer records recovery-key escrow PUTs by source.
type recoveryKeyServer struct {
	mu      sync.Mutex
	sources []string
	fail    bool
}

func (s *recoveryKeyServer) puts() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.sources...)
}

func newRecoveryKeyTestHeartbeat(t *testing.T) (*Heartbeat, *recoveryKeyServer, *int) {
	t.Helper()
	rec := &recoveryKeyServer{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/security/recovery-keys") {
			http.NotFound(w, r)
			return
		}
		var body struct {
			Source string `json:"source"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		rec.mu.Lock()
		fail := rec.fail
		if !fail {
			rec.sources = append(rec.sources, body.Source)
		}
		rec.mu.Unlock()
		if fail {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	collects := 0
	prev := collectRecoveryKeys
	collectRecoveryKeys = func() ([]security.RecoveryKey, error) {
		collects++
		return []security.RecoveryKey{{Mount: "C:", ProtectorID: "11111111-2222-3333-4444-555555555555", KeyType: security.KeyTypeBitLocker, Key: "fixture"}}, nil
	}
	t.Cleanup(func() { collectRecoveryKeys = prev })

	h := &Heartbeat{config: &config.Config{AgentID: "agent-1", AuthToken: "agent-token", ServerURL: srv.URL}, client: srv.Client()}
	return h, rec, &collects
}

// #9267: the BitLocker recovery-protector read is a PowerShell spawn on
// Windows. The 5-minute security tick must re-read it at most every
// recoveryKeyCollectInterval, not on every tick.
func TestSendRecoveryKeysCollectsAtMostOncePerInterval(t *testing.T) {
	h, rec, collects := newRecoveryKeyTestHeartbeat(t)

	for range 6 { // six 5-minute ticks
		h.sendRecoveryKeys()
	}
	if *collects != 1 {
		t.Fatalf("recovery key collections over 6 ticks = %d, want 1", *collects)
	}
	if got := rec.puts(); len(got) != 1 || got[0] != "snapshot" {
		t.Fatalf("escrow puts = %v, want one snapshot", got)
	}

	h.mu.Lock()
	h.lastRecoveryKeysCollect = time.Now().Add(-recoveryKeyCollectInterval - time.Second)
	h.mu.Unlock()
	h.sendRecoveryKeys()
	if *collects != 2 {
		t.Fatalf("collections after interval = %d, want 2", *collects)
	}
	if got := rec.puts(); len(got) != 1 {
		t.Fatalf("unchanged key set re-escrowed: %v", got)
	}
}

// A failed escrow upload is retried after recoveryKeyErrorRetry — sooner
// than the full interval (the keys were never escrowed), but not on every
// tick (a server outage must not put the PowerShell read back on the tick).
func TestSendRecoveryKeysRetriesSoonAfterUploadFailure(t *testing.T) {
	h, rec, collects := newRecoveryKeyTestHeartbeat(t)

	rec.mu.Lock()
	rec.fail = true
	rec.mu.Unlock()
	h.sendRecoveryKeys()
	h.sendRecoveryKeys() // next tick: still backing off
	if *collects != 1 {
		t.Fatalf("collections right after failed upload = %d, want 1 (no per-tick retry)", *collects)
	}

	rec.mu.Lock()
	rec.fail = false
	rec.mu.Unlock()
	h.mu.Lock()
	h.lastRecoveryKeysCollect = h.lastRecoveryKeysCollect.Add(-recoveryKeyErrorRetry)
	h.mu.Unlock()
	h.sendRecoveryKeys()

	if *collects != 2 {
		t.Fatalf("collections after error retry = %d, want 2", *collects)
	}
	if got := rec.puts(); len(got) != 1 || got[0] != "snapshot" {
		t.Fatalf("escrow puts = %v, want one successful snapshot", got)
	}
}

// A failed collection (e.g. no BitLocker module) is not re-spawned every tick.
func TestSendRecoveryKeysCollectFailureIsRateLimited(t *testing.T) {
	h, rec, _ := newRecoveryKeyTestHeartbeat(t)
	attempts := 0
	collectRecoveryKeys = func() ([]security.RecoveryKey, error) {
		attempts++
		return nil, errors.New("Get-BitLockerVolume is not recognized")
	}
	for range 3 {
		h.sendRecoveryKeys()
	}
	if attempts != 1 {
		t.Fatalf("failed collections over 3 ticks = %d, want 1", attempts)
	}
	h.mu.Lock()
	h.lastRecoveryKeysCollect = h.lastRecoveryKeysCollect.Add(-recoveryKeyErrorRetry)
	h.mu.Unlock()
	h.sendRecoveryKeys()
	if attempts != 2 {
		t.Fatalf("failed read not retried after %s (attempts %d)", recoveryKeyErrorRetry, attempts)
	}
	if got := rec.puts(); len(got) != 0 {
		t.Fatalf("unexpected escrow puts: %v", got)
	}
}

// #10902: a host without BitLocker (Server without the feature, Windows
// Home) is a permanent condition, not a failed read. It must not WARN, and it
// waits out the full interval instead of the shortened error retry.
func TestSendRecoveryKeysBitLockerUnavailableIsQuiet(t *testing.T) {
	h, rec, _ := newRecoveryKeyTestHeartbeat(t)
	var logs bytes.Buffer
	prevLog := log
	log = slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	t.Cleanup(func() { log = prevLog })

	attempts := 0
	collectRecoveryKeys = func() ([]security.RecoveryKey, error) {
		attempts++
		return nil, fmt.Errorf("collect: %w", security.ErrBitLockerUnavailable)
	}
	h.sendRecoveryKeys()
	if strings.Contains(logs.String(), "level=WARN") || strings.Contains(logs.String(), "level=ERROR") {
		t.Fatalf("unavailable BitLocker logged above debug: %q", logs.String())
	}

	h.mu.Lock()
	h.lastRecoveryKeysCollect = h.lastRecoveryKeysCollect.Add(-recoveryKeyErrorRetry)
	h.mu.Unlock()
	h.sendRecoveryKeys()
	if attempts != 1 {
		t.Fatalf("collections after %s = %d, want 1 (unavailable is not a retryable error)", recoveryKeyErrorRetry, attempts)
	}

	h.mu.Lock()
	h.lastRecoveryKeysCollect = time.Now().Add(-recoveryKeyCollectInterval)
	h.mu.Unlock()
	h.sendRecoveryKeys()
	if attempts != 2 {
		t.Fatalf("collections after full interval = %d, want 2", attempts)
	}
	if got := rec.puts(); len(got) != 0 {
		t.Fatalf("unexpected escrow puts: %v", got)
	}
}

// Technician commands re-detect BitLocker availability so a feature installed
// after the agent cached "unavailable" is seen at once (#10902).
func TestEncryptionCommandsRedetectBitLocker(t *testing.T) {
	h, _, _ := newRecoveryKeyTestHeartbeat(t)
	redetects := 0
	prevRedetect, prevRotate := redetectBitLocker, rotateBitLockerKey
	redetectBitLocker = func() { redetects++ }
	rotateBitLockerKey = func(string) (security.RecoveryKey, error) {
		return security.RecoveryKey{}, errors.New("stub: rotation failed")
	}
	t.Cleanup(func() { redetectBitLocker, rotateBitLockerKey = prevRedetect, prevRotate })

	_ = handleEncryptionCollectKeys(h, Command{ID: "c1", Type: tools.CmdEncryptionCollectKeys})
	if redetects != 1 {
		t.Fatalf("redetects after collect command = %d, want 1", redetects)
	}
	if runtime.GOOS == "windows" {
		_ = handleEncryptionRotateKey(h, Command{ID: "r1", Type: tools.CmdEncryptionRotateKey})
		if redetects != 2 {
			t.Fatalf("redetects after rotate command = %d, want 2", redetects)
		}
	}
}

// Parked rotation keys are drained on every tick regardless of the
// collection interval.
func TestSendRecoveryKeysDrainsPendingEveryTick(t *testing.T) {
	h, rec, _ := newRecoveryKeyTestHeartbeat(t)
	h.sendRecoveryKeys() // first tick: snapshot, interval starts

	h.mu.Lock()
	h.pendingRecoveryKeys = []security.RecoveryKey{{Mount: "C:", KeyType: security.KeyTypeBitLocker, Key: "rotated"}}
	h.mu.Unlock()
	h.sendRecoveryKeys()

	if got := rec.puts(); len(got) != 2 || got[1] != "rotation" {
		t.Fatalf("escrow puts = %v, want [snapshot rotation]", got)
	}
}

// A rotation (successful or not) makes the next tick re-read and
// re-snapshot the protector set instead of waiting out the interval.
func TestEncryptionRotateKeyResetsCollectInterval(t *testing.T) {
	h, _, collects := newRecoveryKeyTestHeartbeat(t)
	prevB, prevF := rotateBitLockerKey, rotateFileVaultKey
	rotateBitLockerKey = func(string) (security.RecoveryKey, error) {
		return security.RecoveryKey{}, errors.New("stub: rotation failed")
	}
	rotateFileVaultKey = func(string, string, string) (security.RecoveryKey, error) {
		return security.RecoveryKey{}, errors.New("stub: rotation failed")
	}
	t.Cleanup(func() { rotateBitLockerKey, rotateFileVaultKey = prevB, prevF })

	h.sendRecoveryKeys() // interval starts
	_ = handleEncryptionRotateKey(h, Command{ID: "r1", Type: tools.CmdEncryptionRotateKey})
	h.sendRecoveryKeys()
	if *collects != 2 {
		t.Fatalf("collections after rotation = %d, want 2 (rotation must reset the interval)", *collects)
	}
}

// An explicit collect command resets the interval so the next tick does not
// immediately spawn the same read again.
func TestEncryptionCollectKeysCommandStampsInterval(t *testing.T) {
	h, _, collects := newRecoveryKeyTestHeartbeat(t)
	res := handleEncryptionCollectKeys(h, Command{ID: "c1", Type: tools.CmdEncryptionCollectKeys})
	if res.Status != "completed" {
		t.Fatalf("collect command status = %q (%s)", res.Status, res.Error)
	}
	h.sendRecoveryKeys()
	if *collects != 1 {
		t.Fatalf("collections = %d, want 1 (tick right after the command must not re-collect)", *collects)
	}
}
