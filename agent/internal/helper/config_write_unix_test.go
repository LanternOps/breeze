//go:build !windows

package helper

import (
	"context"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

const (
	oldTempName    = "helper_config.yaml.tmp"
	configFileName = "helper_config.yaml"
	outsideContent = "outside file, unchanged\n"
	writeDeadline  = time.Second
)

// configWriter drives one write path. plant runs once the session directory
// exists and before the write, on the writer's goroutine for the migrate path,
// so it reports failures with t.Error. run returns the session directory.
type configWriter struct {
	name string
	want string
	run  func(t *testing.T, plant func(sessionDir string)) string
}

func configWriters() []configWriter {
	return []configWriter{
		{
			name: "session",
			want: helperConfigFixture,
			run: func(t *testing.T, plant func(string)) string {
				baseDir := t.TempDir()
				mgr := New(context.Background(), nil, nil, "", WithMachineInstallOwner(true))
				state := newSessionState("501", baseDir)
				dir := filepath.Dir(state.configPath)
				if err := os.MkdirAll(dir, 0o755); err != nil {
					t.Fatal(err)
				}
				plant(dir)
				runWithinDeadline(t, dir, func() {
					if err := mgr.writeSessionConfig(state, helperConfigFixtureValue(), SessionInfo{Key: "501", UID: uint32(os.Getuid())}); err != nil {
						t.Errorf("writeSessionConfig: %v", err)
					}
				})
				return dir
			},
		},
		{
			name: "migrate",
			want: legacyConfigFixture,
			run: func(t *testing.T, plant func(string)) string {
				mgr, baseDir := newMigrationManager(t)
				dir := filepath.Join(baseDir, "sessions", "501")
				stubMigrationSeams(t, []string{"501"}, func(sessionDir, _ string) error {
					plant(sessionDir)
					return nil
				})
				runWithinDeadline(t, dir, mgr.migrateToSessions)
				return dir
			},
		},
	}
}

// runWithinDeadline fails the test if fn is still running after writeDeadline.
// On a miss it opens any pipes in dir so fn can unwind before TempDir cleanup.
func runWithinDeadline(t *testing.T, dir string, fn func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		fn()
	}()
	select {
	case <-done:
		return
	case <-time.After(writeDeadline):
	}
	for _, name := range []string{oldTempName, configFileName} {
		if f, err := os.OpenFile(filepath.Join(dir, name), os.O_RDONLY|syscall.O_NONBLOCK, 0); err == nil {
			defer func() { _ = f.Close() }()
		}
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}
	t.Fatalf("write still blocked after %s", writeDeadline)
}

func outsideFile(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "outside.yaml")
	if err := os.WriteFile(path, []byte(outsideContent), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func assertRegularConfig(t *testing.T, dir, want string) {
	t.Helper()
	path := filepath.Join(dir, configFileName)
	fi, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !fi.Mode().IsRegular() {
		t.Fatalf("%s is %s, want a regular file", path, fi.Mode())
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("%s mode = %o, want 600", path, fi.Mode().Perm())
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		t.Fatalf("no stat data for %s", path)
	}
	if int(st.Uid) != os.Geteuid() {
		t.Fatalf("%s uid = %d, want %d", path, st.Uid, os.Geteuid())
	}
	assertFileBytes(t, path, want)
	assertNoTempLeftovers(t, dir)
}

// The write succeeds and goes to the real config; the entry at the old fixed
// temp name is ignored.
func TestConfigWriteIgnoresLinkAtOldTempName(t *testing.T) {
	for _, w := range configWriters() {
		t.Run(w.name, func(t *testing.T) {
			outside := outsideFile(t)
			dir := w.run(t, func(sessionDir string) {
				if err := os.Symlink(outside, filepath.Join(sessionDir, oldTempName)); err != nil {
					t.Error(err)
				}
			})
			assertFileBytes(t, outside, outsideContent)
			assertRegularConfig(t, dir, w.want)
		})
	}
}

func TestConfigWriteDoesNotBlockOnPipeAtOldTempName(t *testing.T) {
	for _, w := range configWriters() {
		t.Run(w.name, func(t *testing.T) {
			dir := w.run(t, func(sessionDir string) {
				if err := syscall.Mkfifo(filepath.Join(sessionDir, oldTempName), 0o666); err != nil {
					t.Error(err)
				}
			})
			assertRegularConfig(t, dir, w.want)
		})
	}
}

func TestConfigWriteReplacesLinkAtConfigPath(t *testing.T) {
	for _, w := range configWriters() {
		t.Run(w.name, func(t *testing.T) {
			outside := outsideFile(t)
			dir := w.run(t, func(sessionDir string) {
				if err := os.Symlink(outside, filepath.Join(sessionDir, configFileName)); err != nil {
					t.Error(err)
				}
			})
			assertFileBytes(t, outside, outsideContent)
			assertRegularConfig(t, dir, w.want)
		})
	}
}

func TestConfigWriteReplacesPipeAtConfigPath(t *testing.T) {
	for _, w := range configWriters() {
		t.Run(w.name, func(t *testing.T) {
			dir := w.run(t, func(sessionDir string) {
				if err := syscall.Mkfifo(filepath.Join(sessionDir, configFileName), 0o666); err != nil {
					t.Error(err)
				}
			})
			assertRegularConfig(t, dir, w.want)
		})
	}
}

func TestConfigWriteHappyPathModeAndOwner(t *testing.T) {
	for _, w := range configWriters() {
		t.Run(w.name, func(t *testing.T) {
			dir := w.run(t, func(string) {})
			assertRegularConfig(t, dir, w.want)
		})
	}
}

func TestConfigWriteModeIgnoresExistingFile(t *testing.T) {
	for _, w := range configWriters() {
		t.Run(w.name, func(t *testing.T) {
			dir := w.run(t, func(sessionDir string) {
				if err := os.WriteFile(filepath.Join(sessionDir, configFileName), []byte("stale: true\n"), 0o644); err != nil {
					t.Error(err)
				}
			})
			assertRegularConfig(t, dir, w.want)
		})
	}
}

// The mode is set on the descriptor, so it does not depend on the process
// umask. The umask is process-wide, so this test must not call t.Parallel: as a
// serial test it never overlaps the parallel ones.
func TestConfigWriteModeIgnoresUmask(t *testing.T) {
	for _, w := range configWriters() {
		t.Run(w.name, func(t *testing.T) {
			var old int
			dir := w.run(t, func(string) { old = syscall.Umask(0o277) })
			syscall.Umask(old)
			assertRegularConfig(t, dir, w.want)
		})
	}
}
