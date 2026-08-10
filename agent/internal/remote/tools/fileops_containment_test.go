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

// TestIsSensitiveReadPathDirectoryNode pins the component-boundary contract for
// deny-list entries that name a *directory*: the directory node itself must be
// denied, not just its contents (#3385). Sibling directories that merely share a
// name prefix must stay readable.
func TestIsSensitiveReadPathDirectoryNode(t *testing.T) {
	cases := []struct {
		name      string
		path      string
		sensitive bool
	}{
		// macOS keychains — the directory node itself (#3385).
		{"user keychains dir node", "/Users/alice/Library/Keychains", true},
		{"system keychains dir node", "/Library/Keychains", true},
		{"keychains dir node trailing slash", "/Users/alice/Library/Keychains/", true},
		{"keychains dir node backslashes", `C:\Users\bob\Library\Keychains`, true},
		{"keychains dir node lowercase", "/users/alice/library/keychains", true},
		// macOS keychains — contents (already denied before #3385, kept as regression).
		{"keychains direct child", "/Users/alice/Library/Keychains/login.keychain-db", true},
		{"keychains nested child", "/Users/alice/Library/Keychains/ABCD-1234/keychain-2.db", true},
		// macOS keychains — prefix siblings must NOT be denied.
		{"keychains sibling dir", "/Users/alice/Library/Keychainsfoo", false},
		{"keychains sibling dir child", "/Users/alice/Library/Keychainsfoo/notes.txt", false},
		{"keychains singular sibling", "/Users/alice/Library/Keychain", false},
		{"keychain access doc", "/Users/alice/Library/KeychainAccess.txt", false},
		{"keychains without library parent", "/Users/alice/Keychains", false},

		// Other directory-shaped deny-list entries: node + contents + siblings.
		{"sudoers.d dir node", "/etc/sudoers.d", true},
		{"sudoers.d child", "/etc/sudoers.d/90-breeze", true},
		{"sudoers.d sibling", "/etc/sudoers.dx", false},
		{"ssl private dir node", "/etc/ssl/private", true},
		{"ssl private child", "/etc/ssl/private/server.key", true},
		{"ssl private sibling", "/etc/ssl/privatestuff", false},
		{"ssl private sibling child", "/etc/ssl/privatestuff/readme.txt", false},
		{"windows config hive sibling dir", `C:\Windows\System32\config\systemprofile`, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isSensitiveReadPath(tc.path); got != tc.sensitive {
				t.Fatalf("isSensitiveReadPath(%q) = %v, want %v", tc.path, got, tc.sensitive)
			}
		})
	}
}

// TestIsSensitiveReadPathRelativeInput proves the deny-list is evaluated against
// the absolute path the OS would actually open. Every entry is anchored with a
// leading "/", so a relative path handed to the agent would otherwise slip past
// the check and still resolve to the sensitive target via the process CWD
// (found auditing #3385; agent services commonly run with CWD "/").
func TestIsSensitiveReadPathRelativeInput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX-rooted deny-list entries are not reachable from a Windows CWD")
	}

	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "etc", "ssl", "private"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	t.Chdir(root)

	cases := []struct {
		name      string
		path      string
		sensitive bool
	}{
		{"relative shadow", "etc/shadow", true},
		{"relative dot-slash shadow", "./etc/shadow", true},
		{"relative ssl private dir", "etc/ssl/private", true},
		{"relative benign", "etc/hosts", false},
		{"relative benign nested", "docs/readme.md", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isSensitiveReadPath(filepath.Clean(tc.path)); got != tc.sensitive {
				t.Fatalf("isSensitiveReadPath(%q) with cwd %q = %v, want %v", tc.path, root, got, tc.sensitive)
			}
		})
	}
}

// TestListFilesDeniesKeychainsDirNode is the end-to-end proof for #3385: the
// Keychains directory listing itself (not just reads of files inside it) is
// refused at the ListFiles entry point.
func TestListFilesDeniesKeychainsDirNode(t *testing.T) {
	dir := t.TempDir()
	keychains := filepath.Join(dir, "Library", "Keychains")
	if err := os.MkdirAll(keychains, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(keychains, "login.keychain-db"), []byte("kc"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	res := ListFiles(map[string]any{"path": keychains})
	if res.Status == "completed" {
		t.Fatal("expected listing of the Keychains directory itself to be denied")
	}
	if !strings.Contains(res.Error, "sensitive path") {
		t.Fatalf("expected sensitive-path error, got: %q", res.Error)
	}

	// A prefix-sibling directory must still list.
	sibling := filepath.Join(dir, "Library", "Keychainsfoo")
	if err := os.MkdirAll(sibling, 0o755); err != nil {
		t.Fatalf("mkdir sibling: %v", err)
	}
	if res = ListFiles(map[string]any{"path": sibling}); res.Status != "completed" {
		t.Fatalf("expected sibling dir listing to succeed, got: %q", res.Error)
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
