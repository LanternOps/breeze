package tools

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestIsSensitiveReadPath exercises the OS-agnostic deny-list matching for
// credential/secret stores (SR5-01 defense-in-depth). Windows-style paths are
// checked on any host because matching normalizes separators and case.
func TestIsSensitiveReadPath(t *testing.T) {
	cases := []struct {
		name      string
		path      string
		sensitive bool
	}{
		// Unix secrets
		{"etc shadow", "/etc/shadow", true},
		{"etc shadow backup exact", "/etc/gshadow", true},
		{"etc sudoers", "/etc/sudoers", true},
		{"etc sudoers.d entry", "/etc/sudoers.d/90-breeze", true},
		{"etc ssl private key", "/etc/ssl/private/server.key", true},
		{"macos master.passwd", "/private/etc/master.passwd", true},
		// SSH private keys
		{"user ssh id_rsa", "/home/alice/.ssh/id_rsa", true},
		{"user ssh id_ed25519", "/home/alice/.ssh/id_ed25519", true},
		{"root ssh identity", "/root/.ssh/identity", true},
		{"ssh authorized_keys", "/home/alice/.ssh/authorized_keys", true},
		// Windows registry hives (checked on any OS)
		{"windows SAM hive", `C:\Windows\System32\config\SAM`, true},
		{"windows SECURITY hive", `C:\Windows\System32\config\SECURITY`, true},
		{"windows SYSTEM hive", `C:\Windows\System32\config\SYSTEM`, true},
		{"windows NTDS", `C:\Windows\NTDS\ntds.dit`, true},
		// Browser credential stores (basename match)
		{"chrome login data", `C:\Users\bob\AppData\Local\Google\Chrome\User Data\Default\Login Data`, true},
		{"firefox logins", "/home/alice/.mozilla/firefox/abc.default/logins.json", true},
		{"firefox key4", "/home/alice/.mozilla/firefox/abc.default/key4.db", true},
		// macOS keychain
		{"login keychain", "/Users/alice/Library/Keychains/login.keychain-db", true},

		// Benign paths that MUST still be readable
		{"public ssh key", "/home/alice/.ssh/id_rsa.pub", false},
		{"config systemprofile not hive", `C:\Windows\System32\config\systemprofile\NTUSER.DAT`, false},
		{"regular home file", "/home/alice/notes.txt", false},
		{"regular etc file", "/etc/hosts", false},
		{"tmp log", "/tmp/breeze.log", false},
		{"program files exe", `C:\Program Files\App\app.exe`, false},
		{"user document", `C:\Users\bob\Documents\report.docx`, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isSensitiveReadPath(tc.path); got != tc.sensitive {
				t.Fatalf("isSensitiveReadPath(%q) = %v, want %v", tc.path, got, tc.sensitive)
			}
		})
	}
}

// TestEnforceReadContainmentSymlinkEscape proves that a symlink whose own name
// is innocuous cannot be used to read a sensitive target: EvalSymlinks resolves
// the link before the deny-list check.
func TestEnforceReadContainmentSymlinkEscape(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation is unreliable without privilege on Windows CI")
	}

	dir := t.TempDir()

	// Build a fake sensitive target: <tmp>/etc/shadow (matches the deny-list at
	// a component boundary via HasSuffix "/etc/shadow").
	etcDir := filepath.Join(dir, "etc")
	if err := os.MkdirAll(etcDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	shadow := filepath.Join(etcDir, "shadow")
	if err := os.WriteFile(shadow, []byte("root:$6$secret"), 0o600); err != nil {
		t.Fatalf("write shadow: %v", err)
	}

	// Innocuous-looking symlink pointing at the sensitive target.
	link := filepath.Join(dir, "innocent.txt")
	if err := os.Symlink(shadow, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	if err := enforceReadContainment(filepath.Clean(link)); err == nil {
		t.Fatal("expected symlink to sensitive target to be denied, got nil")
	} else if !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("expected symlink-specific denial, got: %v", err)
	}

	// A symlink to a benign file must still be readable.
	benign := filepath.Join(dir, "data.txt")
	if err := os.WriteFile(benign, []byte("hello"), 0o644); err != nil {
		t.Fatalf("write benign: %v", err)
	}
	benignLink := filepath.Join(dir, "shortcut.txt")
	if err := os.Symlink(benign, benignLink); err != nil {
		t.Fatalf("symlink benign: %v", err)
	}
	if err := enforceReadContainment(filepath.Clean(benignLink)); err != nil {
		t.Fatalf("benign symlink should be allowed, got: %v", err)
	}
}

// TestReadFileDeniesSensitivePath verifies the containment is wired into the
// ReadFile entry point (not just the helper), including the symlink path.
func TestReadFileDeniesSensitivePath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation is unreliable without privilege on Windows CI")
	}

	dir := t.TempDir()
	etcDir := filepath.Join(dir, "etc")
	if err := os.MkdirAll(etcDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	shadow := filepath.Join(etcDir, "shadow")
	if err := os.WriteFile(shadow, []byte("secret"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	// Direct read of the sensitive target is denied.
	res := ReadFile(map[string]any{"path": shadow})
	if res.Status == "completed" {
		t.Fatal("expected direct read of sensitive path to fail")
	}
	if !strings.Contains(res.Error, "sensitive path") {
		t.Fatalf("expected sensitive-path error, got: %q", res.Error)
	}

	// Symlink-laundered read is denied too.
	link := filepath.Join(dir, "notes.txt")
	if err := os.Symlink(shadow, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	res = ReadFile(map[string]any{"path": link})
	if res.Status == "completed" {
		t.Fatal("expected symlinked read of sensitive path to fail")
	}
	if !strings.Contains(res.Error, "sensitive path") {
		t.Fatalf("expected sensitive-path error for symlink, got: %q", res.Error)
	}

	// A normal file still reads fine.
	normal := filepath.Join(dir, "readme.txt")
	if err := os.WriteFile(normal, []byte("hello world"), 0o644); err != nil {
		t.Fatalf("write normal: %v", err)
	}
	res = ReadFile(map[string]any{"path": normal})
	if res.Status != "completed" {
		t.Fatalf("expected normal read to succeed, got error: %q", res.Error)
	}
}

// TestListFilesDeniesSensitiveDir ensures directory enumeration of a credential
// store is blocked.
func TestListFilesDeniesSensitiveDir(t *testing.T) {
	dir := t.TempDir()
	sslPriv := filepath.Join(dir, "etc", "ssl", "private")
	if err := os.MkdirAll(sslPriv, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sslPriv, "server.key"), []byte("key"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	res := ListFiles(map[string]any{"path": sslPriv})
	if res.Status == "completed" {
		t.Fatal("expected listing of /etc/ssl/private to be denied")
	}
	if !strings.Contains(res.Error, "sensitive path") {
		t.Fatalf("expected sensitive-path error, got: %q", res.Error)
	}

	// A normal directory lists fine.
	normalDir := filepath.Join(dir, "docs")
	if err := os.MkdirAll(normalDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	res = ListFiles(map[string]any{"path": normalDir})
	if res.Status != "completed" {
		t.Fatalf("expected normal dir listing to succeed, got: %q", res.Error)
	}
}
