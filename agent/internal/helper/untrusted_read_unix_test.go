//go:build !windows

package helper

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// fifoBlockTimeout is how long a call may take before it counts as blocked. A
// correct read returns in microseconds, so the margin is for a loaded CI host.
const fifoBlockTimeout = 5 * time.Second

// makeFIFO creates a FIFO at path with no writer. The cleanup opens and closes
// its write side so a read stuck on it (the regression under test) is released
// instead of outliving the test.
func makeFIFO(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(path, 0o600); err != nil {
		t.Fatalf("mkfifo: %v", err)
	}
	t.Cleanup(func() {
		if f, err := os.OpenFile(path, os.O_RDWR|syscall.O_NONBLOCK, 0); err == nil {
			_ = f.Close()
		}
	})
}

// promptly runs fn and fails the test if fn is still blocked at the timeout.
func promptly[T any](t *testing.T, name string, fn func() T) T {
	t.Helper()
	done := make(chan T, 1)
	go func() { done <- fn() }()
	select {
	case v := <-done:
		return v
	case <-time.After(fifoBlockTimeout):
		t.Fatalf("%s still blocked after %s", name, fifoBlockTimeout)
		panic("unreachable")
	}
}

func TestUntrustedReadsRefuseFIFOPromptly(t *testing.T) {
	tests := []struct {
		name string
		file string
		call func(config string) error
	}{
		{"ReadStatus", "helper_status.yaml", func(config string) error { _, err := ReadStatus(config); return err }},
		{"readBranding", "helper_config.yaml", func(config string) error { _, err := readBranding(config); return err }},
		{"stripBranding", "helper_config.yaml", stripBranding},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			fifo := filepath.Join(dir, tc.file)
			makeFIFO(t, fifo)
			err := promptly(t, tc.name, func() error { return tc.call(filepath.Join(dir, "helper_config.yaml")) })
			if !errors.Is(err, errNotRegularFile) {
				t.Fatalf("got %v", err)
			}
			fi, lerr := os.Lstat(fifo)
			if lerr != nil || fi.Mode()&os.ModeNamedPipe == 0 {
				t.Fatalf("FIFO was replaced: %v, %v", fi, lerr)
			}
		})
	}
}

func TestIsIdleTreatsFIFOStatusAsIdle(t *testing.T) {
	dir := t.TempDir()
	makeFIFO(t, filepath.Join(dir, "helper_status.yaml"))
	if !promptly(t, "IsIdle", func() bool { return IsIdle(filepath.Join(dir, "helper_config.yaml")) }) {
		t.Fatal("unreadable status must read as idle")
	}
}

// The reads run with Manager.mu held, so one session's FIFO must neither stall
// the walk nor hide another session's active chat.
func TestAllSessionsIdleSurvivesFIFOSession(t *testing.T) {
	base := t.TempDir()
	planted := newSessionState("1", base)
	active := newSessionState("2", base)
	makeFIFO(t, filepath.Join(filepath.Dir(planted.configPath), "helper_status.yaml"))

	m := &Manager{sessions: map[string]*sessionState{"1": planted}}
	if !promptly(t, "allSessionsIdle", m.allSessionsIdle) {
		t.Fatal("a FIFO session alone must read as idle")
	}

	if err := os.MkdirAll(filepath.Dir(active.configPath), 0o700); err != nil {
		t.Fatal(err)
	}
	status := "chat_active: true\nlast_activity: " + time.Now().UTC().Format(time.RFC3339) + "\n"
	if err := os.WriteFile(active.statusPath, []byte(status), 0o600); err != nil {
		t.Fatal(err)
	}
	m.sessions["2"] = active
	if promptly(t, "allSessionsIdle", m.allSessionsIdle) {
		t.Fatal("a FIFO session must not hide another session's active chat")
	}
}

// A FIFO is a failed read, not "no branding": the last known branding stays.
func TestSessionConfigKeepsBrandingOnFIFO(t *testing.T) {
	state := newSessionState("1", t.TempDir())
	makeFIFO(t, state.configPath)
	last := &Branding{ScopeID: "s", BrandingValues: BrandingValues{DisplayName: "X"}}
	state.lastConfig = &Config{Branding: last}

	m := &Manager{}
	cfg := promptly(t, "sessionConfig", func() *Config { return m.sessionConfig(state, &Config{}, nil) })
	if !brandingEqual(cfg.Branding, last) {
		t.Fatalf("branding not kept: %+v", cfg.Branding)
	}
	if !state.brandingReadLogged {
		t.Fatal("refused read was not logged")
	}
}

// One session's FIFO must not stop the others from being cleared, and must
// still surface as an error.
func TestClearBrandingContinuesPastFIFOSession(t *testing.T) {
	base := t.TempDir()
	planted := newSessionState("1", base)
	clean := newSessionState("2", base)
	makeFIFO(t, planted.configPath)
	if err := os.MkdirAll(filepath.Dir(clean.configPath), 0o700); err != nil {
		t.Fatal(err)
	}
	config := "show_open_portal: true\nbranding:\n  scope_id: s\n  display_name: X\n"
	if err := os.WriteFile(clean.configPath, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}

	err := promptly(t, "ClearBranding", func() error { return ClearBranding(base) })
	if !errors.Is(err, errNotRegularFile) {
		t.Fatalf("got %v", err)
	}
	data, rerr := os.ReadFile(clean.configPath)
	if rerr != nil {
		t.Fatal(rerr)
	}
	if strings.Contains(string(data), "branding") {
		t.Fatalf("clean session keeps branding: %s", data)
	}
}

// The target is valid YAML for every reader, so only the refused open can
// produce the error, not a parse failure after following the link.
func TestUntrustedReadsRefuseSymlink(t *testing.T) {
	const content = "pid: 7\nbranding:\n  scope_id: s\n  display_name: X\n"
	tests := []struct {
		name string
		file string
		call func(config string) error
	}{
		{"ReadStatus", "helper_status.yaml", func(config string) error { _, err := ReadStatus(config); return err }},
		{"readBranding", "helper_config.yaml", func(config string) error { _, err := readBranding(config); return err }},
		{"stripBranding", "helper_config.yaml", stripBranding},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			target := filepath.Join(t.TempDir(), "elsewhere.yaml")
			if err := os.WriteFile(target, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, filepath.Join(dir, tc.file)); err != nil {
				t.Fatal(err)
			}
			err := tc.call(filepath.Join(dir, "helper_config.yaml"))
			if !errors.Is(err, syscall.ELOOP) {
				t.Fatalf("followed or wrong error: %v", err)
			}
			data, rerr := os.ReadFile(target)
			if rerr != nil {
				t.Fatal(rerr)
			}
			if string(data) != content {
				t.Fatalf("target changed: %s", data)
			}
		})
	}
}
