//go:build windows

package vss

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// Live VSS tests. These need the real Volume Shadow Copy Service, an elevated
// process, and they create (briefly) a real shadow copy of the system volume,
// so they are opt-in:
//
//	set BREEZE_VSS_LIVE=1 && go test ./internal/backup/vss/ -run Live -v
//
// Everything in the VSS provider below CreateShadowCopy is raw COM vtable
// dispatch against a service that cannot be faked, so there is no honest unit
// test for it — a mock would only assert that our own wrong constants are
// still our own wrong constants, which is precisely what let #2999 ship. The
// checkable ABI facts are pinned in vss_windows_layout_test.go; correctness of
// the call sequence is only observable against the live service, here.

func requireLiveVSS(t *testing.T) {
	t.Helper()
	if os.Getenv("BREEZE_VSS_LIVE") != "1" {
		t.Skip("set BREEZE_VSS_LIVE=1 to run live VSS tests (needs an elevated process)")
	}
}

// systemVolume returns the volume of the Windows drive in the same form
// backup.go's extractVolumes produces: "C:", with no trailing separator.
func systemVolume(t *testing.T) string {
	t.Helper()
	sysRoot := os.Getenv("SystemRoot")
	if sysRoot == "" {
		sysRoot = `C:\Windows`
	}
	return filepath.VolumeName(sysRoot)
}

// TestLive_CreateShadowCopy_EndToEnd is the regression test for #2999. Before
// the fix, this failed at InitializeForBackup with HRESULT 0x80070057.
//
// Its central assertion was INVERTED by #3269. It used to prove that the shadow
// device survived CreateShadowCopy's own Release + CoUninitialize, on the theory
// that a VSS_CTX_BACKUP copy is only reclaimed at requester process exit. That
// theory was wrong — the copies are auto-release — and the test could not have
// caught it: it read through the device seconds after the Release, and deletion
// of an auto-release copy is not synchronous with it. Now the session HOLDS its
// IVssBackupComponents, so what this checks is that the device is readable while
// the session is held, and that the session releases cleanly afterwards. The
// multi-minute hold that the old assertion could never have covered lives in
// TestLive_ShadowCopySurvivesALongHold.
func TestLive_CreateShadowCopy_EndToEnd(t *testing.T) {
	requireLiveVSS(t)

	vol := systemVolume(t)
	p := NewProvider(DefaultConfig())

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	session, err := p.CreateShadowCopy(ctx, []string{vol})
	if err != nil {
		t.Fatalf("CreateShadowCopy(%q) failed: %v", vol, err)
	}
	released := false
	defer func() {
		if !released {
			p.ReleaseShadowCopy(session) //nolint:errcheck
		}
	}()

	if session.ID == "" {
		t.Error("session ID is empty")
	}
	// The session must be keyed by the caller's volume string, not the
	// normalised mount point — backup.go looks it up with filepath.VolumeName.
	shadow, ok := session.ShadowPaths[vol]
	if !ok {
		t.Fatalf("ShadowPaths has no entry for %q; keys=%v", vol, keysOf(session.ShadowPaths))
	}
	if !strings.HasPrefix(shadow, `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy`) {
		t.Errorf("unexpected shadow device path %q", shadow)
	}

	// GetShadowPath must agree with the map.
	got, err := p.GetShadowPath(session, vol)
	if err != nil {
		t.Fatalf("GetShadowPath: %v", err)
	}
	if got != shadow {
		t.Errorf("GetShadowPath = %q, want %q", got, shadow)
	}

	if len(session.UnprotectedVolumes) != 0 {
		t.Errorf("expected no unprotected volumes, got %v", session.UnprotectedVolumes)
	}

	// The shadow copy must be readable while the session is held. The GC and the
	// sleep are kept because they still rule out a timing accident, but the claim
	// they support is now the correct one: the device survives because this
	// process is still holding a reference to the IVssBackupComponents, NOT
	// because Windows defers reclamation to process exit.
	runtime.GC()
	time.Sleep(5 * time.Second)

	// The shadow copy must actually be readable: list the Windows directory
	// through the device path.
	shadowWindows := shadow + `\Windows`
	entries, err := os.ReadDir(shadowWindows)
	if err != nil {
		t.Fatalf("reading %q through the shadow copy failed: %v", shadowWindows, err)
	}
	if len(entries) == 0 {
		t.Errorf("%q is empty through the shadow copy", shadowWindows)
	}

	// Which form of the ROOT itself is stat-able, recorded on real hardware.
	//
	// This is the arming precondition for the #3260 mid-run snapshot-loss guard
	// (backup.newShadowRootLiveness): it calibrates by os.Stat-ing each shadow
	// root and watches only the roots that answer. Everything above goes through
	// a SUBDIRECTORY, so none of it says whether the bare device path — which is
	// what CreateShadowCopy returns, and what the guard is handed — resolves.
	// If neither form did, the guard would silently disarm on every real run.
	//
	// Not a hard failure on the bare form: the guard tries `root + "\\"` as a
	// fallback precisely because the bare device object may not be stat-able.
	// At least ONE of them must work, and the log line records which, so a
	// future change to resolveStatablePath can be checked against reality.
	_, bareErr := os.Stat(shadow)
	withSep := shadow + `\`
	_, sepErr := os.Stat(withSep)
	t.Logf("shadow root stat: bare %q -> %v; with separator %q -> %v", shadow, bareErr, withSep, sepErr)
	if bareErr != nil && sepErr != nil {
		t.Errorf("neither shadow root form is stat-able (bare: %v; with separator: %v) — "+
			"backup.newShadowRootLiveness would exclude every root and the #3260 guard would be inert",
			bareErr, sepErr)
	}

	t.Logf("shadow copy %s -> %s (%d entries under \\Windows, %d writers)",
		vol, shadow, len(entries), len(session.Writers))

	// Release must succeed and must be idempotent — RunBackupContext's deferred
	// release is the only caller, but a double release must never manufacture a
	// failure on a run that has already finished.
	if err := p.ReleaseShadowCopy(session); err != nil {
		t.Errorf("ReleaseShadowCopy: %v", err)
	}
	released = true
	if err := p.ReleaseShadowCopy(session); err != nil {
		t.Errorf("second ReleaseShadowCopy should be a no-op, got %v", err)
	}

	// The provider must be reusable after a release. If p.live were left set,
	// every later run on this manager would fail to get a shadow copy and
	// silently degrade to a live read.
	second, err := p.CreateShadowCopy(ctx, []string{vol})
	if err != nil {
		t.Fatalf("a new session could not be created after release (the provider leaked its live session): %v", err)
	}
	if err := p.ReleaseShadowCopy(second); err != nil {
		t.Errorf("releasing the second session: %v", err)
	}

	// Writers should have been signalled. This is reported rather than asserted:
	// BackupComplete is best-effort by design, and a machine with a
	// non-conforming third-party writer must not turn a green backup red here.
	// The log line is what a human checks when verifying #3269 by hand.
	writers, err := p.ListWriters(ctx)
	if err != nil {
		t.Logf("post-release ListWriters failed (not fatal): %v", err)
		return
	}
	waiting := 0
	for _, w := range writers {
		if w.State == "waiting" {
			waiting++
			t.Logf("writer %q (%s) is still %q after BackupComplete", w.Name, w.ID, w.State)
		}
	}
	t.Logf("post-release writer states: %d writers, %d still waiting", len(writers), waiting)
}

// TestLive_ShadowCopySurvivesALongHold is THE regression test for #3269, and the
// one the old suite structurally could not contain.
//
// The field failure (#3260) was a shadow copy that stopped resolving roughly 390
// seconds into a run while the process was still alive. Every previous live test
// read through the device within seconds of creating it, which proves nothing
// about an auto-release copy: Windows deletes those when the requester drops its
// references, and that deletion is not synchronous with the Release. So the only
// honest test is a long one — hold the session, and keep reading through the
// device for longer than the window in which the field failure appeared.
//
// Default hold is 8 minutes (comfortably past the observed ~390s). Override with
// BREEZE_VSS_HOLD_SECONDS. Run it against a build WITHOUT the fix and it should
// fail; that is the point.
func TestLive_ShadowCopySurvivesALongHold(t *testing.T) {
	requireLiveVSS(t)

	hold := 8 * time.Minute
	if raw := os.Getenv("BREEZE_VSS_HOLD_SECONDS"); raw != "" {
		secs, err := strconv.Atoi(raw)
		if err != nil || secs <= 0 {
			t.Fatalf("BREEZE_VSS_HOLD_SECONDS=%q must be a positive integer", raw)
		}
		hold = time.Duration(secs) * time.Second
	}

	vol := systemVolume(t)
	p := NewProvider(DefaultConfig())

	ctx, cancel := context.WithTimeout(context.Background(), hold+10*time.Minute)
	defer cancel()

	session, err := p.CreateShadowCopy(ctx, []string{vol})
	if err != nil {
		t.Fatalf("CreateShadowCopy(%q) failed: %v", vol, err)
	}
	defer p.ReleaseShadowCopy(session) //nolint:errcheck

	shadow, ok := session.ShadowPaths[vol]
	if !ok {
		t.Fatalf("no shadow path for %q", vol)
	}
	shadowWindows := shadow + `\Windows`

	// Drop every Go-side reference we can and force a collection, so a copy that
	// only survives because something is incidentally pinned is not mistaken for
	// one the session is deliberately holding.
	runtime.GC()

	const probeInterval = 30 * time.Second
	deadline := time.Now().Add(hold)
	probes := 0
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		sleep := probeInterval
		if remaining < sleep {
			sleep = remaining
		}
		time.Sleep(sleep)
		probes++

		elapsed := time.Since(session.CreatedAt)
		if _, err := os.Stat(shadow + `\`); err != nil {
			t.Fatalf("shadow root %q stopped resolving after %s (probe %d): %v — "+
				"this is #3269: the auto-release copy was reclaimed while the run was still in progress",
				shadow, elapsed.Round(time.Second), probes, err)
		}
		entries, err := os.ReadDir(shadowWindows)
		if err != nil {
			t.Fatalf("reading %q through the shadow copy failed after %s (probe %d): %v — this is #3269",
				shadowWindows, elapsed.Round(time.Second), probes, err)
		}
		if len(entries) == 0 {
			t.Fatalf("%q read empty through the shadow copy after %s (probe %d)",
				shadowWindows, elapsed.Round(time.Second), probes)
		}
		t.Logf("t+%s: shadow copy still readable (%d entries)", elapsed.Round(time.Second), len(entries))
	}
	t.Logf("shadow copy survived a %s hold across %d probes", hold, probes)
}

// TestLive_ConcurrentSessionsCoexist pins the scope of the creation gate on real
// COM, which is the part of #3269 most likely to be got wrong in a later change.
//
// Two concurrent backup_run commands each build their own ephemeral
// BackupManager and their own provider. Both are entitled to a shadow copy: VSS
// serialises the creation interval (StartSnapshotSet → DoSnapshotSet), not the
// lifetime of finished snapshot sets. So the second creation may queue behind the
// first, but it must SUCCEED — and, critically, releasing either session must
// not disturb the other's device. A gate that covered the whole session would
// instead silently downgrade one of the two runs to a live read.
func TestLive_ConcurrentSessionsCoexist(t *testing.T) {
	requireLiveVSS(t)

	vol := systemVolume(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	first := NewProvider(DefaultConfig())
	firstSession, err := first.CreateShadowCopy(ctx, []string{vol})
	if err != nil {
		t.Fatalf("first CreateShadowCopy failed: %v", err)
	}
	defer first.ReleaseShadowCopy(firstSession) //nolint:errcheck

	// The same provider must refuse a second session: it has exactly one slot to
	// park the components object in, so a second would strand the first's COM
	// objects with no handle left to release them by.
	if _, err := first.CreateShadowCopy(ctx, []string{vol}); !errors.Is(err, ErrVSSSessionInProgress) {
		t.Errorf("same-provider second CreateShadowCopy = %v, want ErrVSSSessionInProgress", err)
	}

	// A DIFFERENT provider, as a concurrent ephemeral BackupManager would build,
	// must get its own snapshot.
	second := NewProvider(DefaultConfig())
	secondSession, err := second.CreateShadowCopy(ctx, []string{vol})
	if err != nil {
		t.Fatalf("a second concurrent provider must still get its own shadow copy, got %v", err)
	}
	defer second.ReleaseShadowCopy(secondSession) //nolint:errcheck

	if firstSession.ID == secondSession.ID {
		t.Errorf("both providers reported the same snapshot set ID %q", firstSession.ID)
	}
	firstShadow := firstSession.ShadowPaths[vol]
	secondShadow := secondSession.ShadowPaths[vol]
	if firstShadow == "" || secondShadow == "" {
		t.Fatalf("missing shadow path (first=%q second=%q)", firstShadow, secondShadow)
	}
	if firstShadow == secondShadow {
		t.Errorf("both sessions resolved the same shadow device %q", firstShadow)
	}

	// ListWriters must stay usable while sessions are held: it is call-scoped,
	// creates no snapshot, and the vss_writer_list IPC command polls it
	// independently of any running backup.
	if _, err := second.ListWriters(ctx); err != nil {
		t.Errorf("ListWriters during a held session: %v", err)
	}

	// Releasing one must NOT take the other's device with it.
	if err := second.ReleaseShadowCopy(secondSession); err != nil {
		t.Errorf("releasing the second session: %v", err)
	}
	if _, err := os.ReadDir(firstShadow + `\Windows`); err != nil {
		t.Fatalf("the first session's shadow copy became unreadable after the SECOND was released: %v", err)
	}
	t.Logf("two concurrent sessions coexisted: %s and %s", firstShadow, secondShadow)
}

// TestLive_ShadowCopyReadsExclusivelyLockedFile is the reason #2999 matters:
// without a shadow copy, in-use files (browser profiles, PST/OST, NTUSER.DAT)
// fail with ERROR_SHARING_VIOLATION. This proves the snapshot makes an
// unshareable file readable.
func TestLive_ShadowCopyReadsExclusivelyLockedFile(t *testing.T) {
	requireLiveVSS(t)

	vol := systemVolume(t)
	dir := filepath.Join(vol+`\`, "breeze-vss-test")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	defer os.RemoveAll(dir)

	target := filepath.Join(dir, "locked.txt")
	const payload = "breeze vss 2999 locked-file probe"
	if err := os.WriteFile(target, []byte(payload), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	// Re-open with no sharing at all, exactly like a running browser holds its
	// profile database.
	namePtr, err := windows.UTF16PtrFromString(target)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(namePtr, windows.GENERIC_READ|windows.GENERIC_WRITE,
		0 /* no FILE_SHARE_* */, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatalf("exclusive open: %v", err)
	}
	defer windows.CloseHandle(h)

	// Sanity: the direct read must fail while the handle is held. If it does
	// not, the rest of this test proves nothing.
	if _, err := os.ReadFile(target); err == nil {
		t.Skip("file is not actually locked on this system; cannot prove the VSS benefit")
	}

	p := NewProvider(DefaultConfig())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	session, err := p.CreateShadowCopy(ctx, []string{vol})
	if err != nil {
		t.Fatalf("CreateShadowCopy(%q) failed: %v", vol, err)
	}
	defer p.ReleaseShadowCopy(session) //nolint:errcheck

	shadow, ok := session.ShadowPaths[vol]
	if !ok {
		t.Fatalf("no shadow path for %q", vol)
	}

	// Same rewrite backup.go performs: volume prefix -> shadow device.
	shadowTarget := shadow + target[len(vol):]
	data, err := os.ReadFile(shadowTarget)
	if err != nil {
		t.Fatalf("reading the locked file through the shadow copy failed: %v", err)
	}
	if string(data) != payload {
		t.Errorf("shadow copy content = %q, want %q", string(data), payload)
	}
	t.Logf("locked file unreadable directly, read OK through %s", shadowTarget)
}

// TestLive_CreateShadowCopy_NoVolumes checks the guard without touching VSS.
func TestLive_CreateShadowCopy_NoVolumes(t *testing.T) {
	p := NewProvider(DefaultConfig())
	if _, err := p.CreateShadowCopy(context.Background(), nil); err != ErrVSSNoVolumes {
		t.Fatalf("expected ErrVSSNoVolumes, got %v", err)
	}
}

func keysOf(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
