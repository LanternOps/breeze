package tools

import (
	"errors"

	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// stubTrashHomeResolvers swaps the three home/data-dir resolvers getTrashDir
// walks, restoring them when the test ends.
func stubTrashHomeResolvers(t *testing.T, envHome func() (string, error), passwdHome func() (string, error), dataDir func() string) {
	t.Helper()
	origEnv, origPasswd, origData := userHomeDirFunc, passwdHomeDirFunc, agentDataDirFunc
	userHomeDirFunc, passwdHomeDirFunc, agentDataDirFunc = envHome, passwdHome, dataDir
	t.Cleanup(func() {
		userHomeDirFunc, passwdHomeDirFunc, agentDataDirFunc = origEnv, origPasswd, origData
	})
}

func errHome(msg string) func() (string, error) {
	return func() (string, error) { return "", errors.New(msg) }
}

func okHome(dir string) func() (string, error) {
	return func() (string, error) { return dir, nil }
}

// TestGetTrashDirFallbacks is the #6413 regression: an agent running without
// $HOME (systemd/cron/non-login service context) must still resolve a trash
// directory instead of failing the whole delete.
func TestGetTrashDirFallbacks(t *testing.T) {
	tests := []struct {
		name     string
		envHome  func(root string) func() (string, error)
		passwd   func(root string) func() (string, error)
		dataDir  func(root string) func() string
		wantRel  string
		wantErr  bool
		errParts []string
	}{
		{
			name:    "env home preferred when available",
			envHome: func(root string) func() (string, error) { return okHome(filepath.Join(root, "envhome")) },
			passwd:  func(root string) func() (string, error) { return okHome(filepath.Join(root, "passwdhome")) },
			dataDir: func(root string) func() string { return func() string { return filepath.Join(root, "data") } },
			wantRel: filepath.Join("envhome", ".breeze-trash"),
		},
		{
			name:    "falls back to passwd home when $HOME is not defined",
			envHome: func(string) func() (string, error) { return errHome("$HOME is not defined") },
			passwd:  func(root string) func() (string, error) { return okHome(filepath.Join(root, "passwdhome")) },
			dataDir: func(root string) func() string { return func() string { return filepath.Join(root, "data") } },
			wantRel: filepath.Join("passwdhome", ".breeze-trash"),
		},
		{
			name:    "falls back to agent data dir when no home resolves",
			envHome: func(string) func() (string, error) { return errHome("$HOME is not defined") },
			passwd:  func(string) func() (string, error) { return errHome("user: lookup failed") },
			dataDir: func(root string) func() string { return func() string { return filepath.Join(root, "data") } },
			wantRel: filepath.Join("data", "trash"),
		},
		{
			name:    "skips a home whose directory cannot be created",
			envHome: func(root string) func() (string, error) { return okHome(filepath.Join(root, "file", "nope")) },
			passwd:  func(root string) func() (string, error) { return okHome(filepath.Join(root, "passwdhome")) },
			dataDir: func(root string) func() string { return func() string { return filepath.Join(root, "data") } },
			wantRel: filepath.Join("passwdhome", ".breeze-trash"),
		},
		{
			// Some container/service managers export HOME="" rather than
			// leaving it unset, which os.UserHomeDir reports as success.
			name:    "treats an empty home as unusable and falls through",
			envHome: func(string) func() (string, error) { return okHome("") },
			passwd:  func(root string) func() (string, error) { return okHome(filepath.Join(root, "passwdhome")) },
			dataDir: func(root string) func() string { return func() string { return filepath.Join(root, "data") } },
			wantRel: filepath.Join("passwdhome", ".breeze-trash"),
		},
		{
			name:     "reports every attempt when nothing resolves",
			envHome:  func(string) func() (string, error) { return errHome("$HOME is not defined") },
			passwd:   func(string) func() (string, error) { return errHome("user: lookup failed") },
			dataDir:  func(string) func() string { return func() string { return "" } },
			wantErr:  true,
			errParts: []string{"$HOME is not defined", "user: lookup failed", "permanent"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			// A regular file at <root>/file makes <root>/file/nope uncreatable.
			if err := os.WriteFile(filepath.Join(root, "file"), []byte("x"), 0600); err != nil {
				t.Fatalf("seed file: %v", err)
			}
			stubTrashHomeResolvers(t, tt.envHome(root), tt.passwd(root), tt.dataDir(root))

			got, err := getTrashDir()
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error, got dir %q", got)
				}
				for _, part := range tt.errParts {
					if !strings.Contains(err.Error(), part) {
						t.Errorf("error %q missing %q", err.Error(), part)
					}
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			want := filepath.Join(root, tt.wantRel)
			if got != want {
				t.Fatalf("trash dir = %q, want %q", got, want)
			}
			info, statErr := os.Stat(got)
			if statErr != nil || !info.IsDir() {
				t.Fatalf("trash dir not created: %v", statErr)
			}
		})
	}
}

// TestDeleteFileSucceedsWithoutHomeEnv proves the end-to-end #6413 symptom is
// gone: a delete with $HOME unresolvable now trashes via the fallback instead
// of returning "failed to get trash directory".
func TestDeleteFileSucceedsWithoutHomeEnv(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "big.log")
	if err := os.WriteFile(target, []byte("log contents"), 0600); err != nil {
		t.Fatalf("seed target: %v", err)
	}
	stubTrashHomeResolvers(t,
		errHome("$HOME is not defined"),
		errHome("user: Current not implemented"),
		func() string { return filepath.Join(root, "data") },
	)

	res := DeleteFile(map[string]any{"path": target})
	if res.Status != "completed" {
		t.Fatalf("delete failed: %v", res.Error)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("target still present: %v", err)
	}
	trashRoot := filepath.Join(root, "data", "trash")
	entries, err := os.ReadDir(trashRoot)
	if err != nil {
		t.Fatalf("read trash: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 trash item, got %d", len(entries))
	}
	content := filepath.Join(trashRoot, entries[0].Name(), "content")
	if _, err := os.Stat(content); err != nil {
		t.Fatalf("trashed content missing: %v", err)
	}
}

// TestResolveHomeDirFallsBackToPasswd covers the shared helper used by
// ListFiles' default path, which hit the same $HOME dependency.
func TestResolveHomeDirFallsBackToPasswd(t *testing.T) {
	root := t.TempDir()
	stubTrashHomeResolvers(t, errHome("$HOME is not defined"), okHome(root), func() string { return "" })

	got, err := resolveHomeDir()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != root {
		t.Fatalf("home = %q, want %q", got, root)
	}

	stubTrashHomeResolvers(t, errHome("$HOME is not defined"), errHome("no passwd entry"), func() string { return "" })
	if _, err := resolveHomeDir(); err == nil {
		t.Fatal("expected error when neither resolver works")
	} else if !strings.Contains(err.Error(), "no passwd entry") {
		t.Fatalf("error should name both attempts, got %v", err)
	}
}

// TestGetTrashDirTightensExistingDirPermissions covers the review finding that
// os.MkdirAll leaves an already-existing directory's mode alone, which would
// leave trashed content readable by other local users under a 0755
// installer-created data directory.
func TestGetTrashDirTightensExistingDirPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permission bits are not meaningful on Windows")
	}
	root := t.TempDir()
	dataDir := filepath.Join(root, "data")
	loose := filepath.Join(dataDir, "trash")
	if err := os.MkdirAll(loose, 0755); err != nil {
		t.Fatalf("seed loose trash dir: %v", err)
	}
	if err := os.Chmod(loose, 0755); err != nil {
		t.Fatalf("seed mode: %v", err)
	}
	stubTrashHomeResolvers(t, errHome("$HOME is not defined"), errHome("no passwd entry"), func() string { return dataDir })

	got, err := getTrashDir()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	info, err := os.Stat(got)
	if err != nil {
		t.Fatalf("stat trash dir: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0700 {
		t.Fatalf("trash dir mode = %04o, want 0700", perm)
	}
}

// TestListFilesDefaultsToPasswdHomeWithoutEnvHome proves the second fixed call
// site resolves its default path through the fallback, not $HOME alone.
func TestListFilesDefaultsToPasswdHomeWithoutEnvHome(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "marker.txt"), []byte("hi"), 0600); err != nil {
		t.Fatalf("seed marker: %v", err)
	}
	stubTrashHomeResolvers(t, errHome("$HOME is not defined"), okHome(root), func() string { return "" })

	res := ListFiles(map[string]any{})
	if res.Status != "completed" {
		t.Fatalf("list failed: %v", res.Error)
	}
	if !strings.Contains(res.Stdout, "marker.txt") {
		t.Fatalf("expected listing of %s, got %q", root, res.Stdout)
	}
}

// TestPasswdHomeDirRealImplementation sanity-checks the un-stubbed resolver so
// a regression in the os/user path cannot hide behind the test stubs.
func TestPasswdHomeDirRealImplementation(t *testing.T) {
	home, err := passwdHomeDir()
	if err != nil {
		t.Skipf("user database unavailable in this environment: %v", err)
	}
	if home == "" {
		t.Fatal("passwdHomeDir returned an empty home with no error")
	}
}
