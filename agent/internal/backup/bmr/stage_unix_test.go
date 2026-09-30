//go:build !windows

package bmr

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/integrity"
	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// observingProvider records the staging file's permission bits just before
// and just after the wrapped provider writes it.
type observingProvider struct {
	providers.BackupProvider
	mu       sync.Mutex
	before   []os.FileMode
	after    []os.FileMode
	missing  int
	failWith error
}

func (o *observingProvider) Download(key, dest string) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if strings.HasPrefix(filepath.Base(dest), integrity.StagingPrefix) {
		if fi, err := os.Lstat(dest); err == nil {
			o.before = append(o.before, fi.Mode())
		} else {
			o.missing++
		}
	}
	if o.failWith != nil && strings.HasPrefix(filepath.Base(dest), integrity.StagingPrefix) {
		return o.failWith
	}
	if err := o.BackupProvider.Download(key, dest); err != nil {
		return err
	}
	if fi, err := os.Lstat(dest); err == nil && strings.HasPrefix(filepath.Base(dest), integrity.StagingPrefix) {
		o.after = append(o.after, fi.Mode())
	}
	return nil
}

func TestAttestedRestore_StagingFileIsPrivateDuringDownload(t *testing.T) {
	fx := newRecoveryFixture(t, "snap-stage-private", []fixtureFile{
		{source: "/d/secret.txt", content: []byte("restricted content")},
	})
	obs := &observingProvider{BackupProvider: fx.provider}
	e := attestedExpectation(t, fx.snapshotID, fx.manifestBytes)

	res, err := RunRecoveryContext(context.Background(), fx.config(e), obs)
	if err != nil {
		t.Fatalf("RunRecoveryContext: %v", err)
	}
	if res.FilesRestored != 1 || res.FailedFiles != 0 {
		t.Fatalf("filesRestored=%d failedFiles=%d warnings=%v, want 1/0", res.FilesRestored, res.FailedFiles, res.Warnings)
	}
	if obs.missing != 0 || len(obs.before) != 1 || len(obs.after) != 1 {
		t.Fatalf("staging file not created before the download: missing=%d before=%v after=%v", obs.missing, obs.before, obs.after)
	}
	for _, m := range append(append([]os.FileMode{}, obs.before...), obs.after...) {
		if !m.IsRegular() || m.Perm() != 0o600 {
			t.Fatalf("staging file mode = %v during download, want a regular 0600 file (before=%v after=%v)", m, obs.before, obs.after)
		}
	}
	assertNoStagingLeftovers(t, fx.targetRoot)
}

func TestAttestedRestore_ReplacedTargetKeepsOwnerAndMode(t *testing.T) {
	fx := newRecoveryFixture(t, "snap-stage-owner", []fixtureFile{
		{source: "/d/keep.conf", content: []byte("restored bytes")},
	})
	target := fx.targets["/d/keep.conf"]
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("older bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(target, 0o640); err != nil {
		t.Fatal(err)
	}
	wantUID, wantGID := os.Getuid(), os.Getgid()
	if os.Geteuid() == 0 {
		wantUID, wantGID = 4321, 4322
		if err := os.Chown(target, wantUID, wantGID); err != nil {
			t.Fatal(err)
		}
	}
	e := attestedExpectation(t, fx.snapshotID, fx.manifestBytes)

	res, err := RunRecoveryContext(context.Background(), fx.config(e), fx.provider)
	if err != nil {
		t.Fatalf("RunRecoveryContext: %v", err)
	}
	if res.FilesRestored != 1 || res.FailedFiles != 0 {
		t.Fatalf("filesRestored=%d failedFiles=%d warnings=%v, want 1/0", res.FilesRestored, res.FailedFiles, res.Warnings)
	}
	got, _ := os.ReadFile(target)
	if string(got) != "restored bytes" {
		t.Fatalf("target = %q, want the restored bytes", got)
	}
	fi, err := os.Lstat(target)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o640 {
		t.Fatalf("restored target mode = %o, want the existing target's 0640", fi.Mode().Perm())
	}
	st := fi.Sys().(*syscall.Stat_t)
	if int(st.Uid) != wantUID || int(st.Gid) != wantGID {
		t.Fatalf("restored target owner = %d:%d, want %d:%d", st.Uid, st.Gid, wantUID, wantGID)
	}
}

func TestAttestedRestore_NewTargetTakesRecordedModeOwnerAndTime(t *testing.T) {
	modTime := time.Date(2024, 3, 4, 5, 6, 7, 0, time.UTC)
	owner := &backup.FileOwner{UID: os.Getuid(), GID: os.Getgid()}
	if os.Geteuid() == 0 {
		owner = &backup.FileOwner{UID: 2345, GID: 2346}
	}
	fx := newRecoveryFixture(t, "snap-stage-new", []fixtureFile{
		{source: "/d/new.bin", content: []byte("fresh"), mode: 0o640, modTime: modTime, owner: owner},
	})
	e := attestedExpectation(t, fx.snapshotID, fx.manifestBytes)

	res, err := RunRecoveryContext(context.Background(), fx.config(e), fx.provider)
	if err != nil {
		t.Fatalf("RunRecoveryContext: %v", err)
	}
	if res.FilesRestored != 1 || res.FailedFiles != 0 {
		t.Fatalf("filesRestored=%d failedFiles=%d warnings=%v, want 1/0", res.FilesRestored, res.FailedFiles, res.Warnings)
	}
	fi, err := os.Lstat(fx.targets["/d/new.bin"])
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o640 {
		t.Fatalf("mode = %o, want the recorded 0640", fi.Mode().Perm())
	}
	if !fi.ModTime().Equal(modTime) {
		t.Fatalf("mtime = %v, want the recorded %v", fi.ModTime(), modTime)
	}
	st := fi.Sys().(*syscall.Stat_t)
	if int(st.Uid) != owner.UID || int(st.Gid) != owner.GID {
		t.Fatalf("owner = %d:%d, want the recorded %d:%d", st.Uid, st.Gid, owner.UID, owner.GID)
	}
}

func TestAttestedRestore_FailureLeavesTargetAndNoStaging(t *testing.T) {
	cases := []struct {
		name    string
		stored  []byte
		dlError error
	}{
		{name: "stored bytes differ from the entry", stored: []byte("other bytes!!!")},
		{name: "download error", dlError: errors.New("storage unavailable")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fx := newRecoveryFixture(t, "snap-stage-fail", []fixtureFile{
				{source: "/d/app.conf", content: []byte("restored bytes")},
			})
			if tc.stored != nil {
				fx.putObject(t, fx.backupPaths["/d/app.conf"], tc.stored)
			}
			target := fx.targets["/d/app.conf"]
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(target, []byte("pre-existing"), 0o600); err != nil {
				t.Fatal(err)
			}
			obs := &observingProvider{BackupProvider: fx.provider, failWith: tc.dlError}
			e := attestedExpectation(t, fx.snapshotID, fx.manifestBytes)

			res, _ := RunRecoveryContext(context.Background(), fx.config(e), obs)
			if res == nil || res.FailedFiles != 1 || res.FilesRestored != 0 {
				t.Fatalf("result = %+v, want one failed file", res)
			}
			got, _ := os.ReadFile(target)
			if string(got) != "pre-existing" {
				t.Fatalf("target now %q, want it untouched", got)
			}
			if fi, _ := os.Lstat(target); fi.Mode().Perm() != 0o600 {
				t.Fatalf("target mode now %o, want it untouched", fi.Mode().Perm())
			}
			assertNoStagingLeftovers(t, fx.targetRoot)
		})
	}
}

func TestAttestedRestore_SweepsLeftoverStagingFiles(t *testing.T) {
	fx := newRecoveryFixture(t, "snap-stage-sweep", []fixtureFile{
		{source: "/d/a.txt", content: []byte("alpha")},
	})
	dir := filepath.Dir(fx.targets["/d/a.txt"])
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	leftover := filepath.Join(dir, integrity.StagingPrefix+"0123456789abcdef01234567")
	if err := os.WriteFile(leftover, []byte("interrupted"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Links and directories carrying the prefix, and files without it, are
	// never touched — nor is anything a link points at.
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("elsewhere"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, integrity.StagingPrefix+"link")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	subdir := filepath.Join(dir, integrity.StagingPrefix+"dir")
	if err := os.Mkdir(subdir, 0o700); err != nil {
		t.Fatal(err)
	}
	unrelated := filepath.Join(dir, "breeze-staging-not-a-prefix")
	if err := os.WriteFile(unrelated, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	e := attestedExpectation(t, fx.snapshotID, fx.manifestBytes)

	res, err := RunRecoveryContext(context.Background(), fx.config(e), fx.provider)
	if err != nil {
		t.Fatalf("RunRecoveryContext: %v", err)
	}
	if res.FilesRestored != 1 {
		t.Fatalf("filesRestored = %d, want 1 (warnings %v)", res.FilesRestored, res.Warnings)
	}
	if _, err := os.Lstat(leftover); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("leftover staging file still present (err=%v)", err)
	}
	for _, p := range []string{link, subdir, unrelated} {
		if _, err := os.Lstat(p); err != nil {
			t.Fatalf("%s removed by the sweep: %v", p, err)
		}
	}
	if got, _ := os.ReadFile(outside); string(got) != "elsewhere" {
		t.Fatalf("link target changed: %q", got)
	}
}
