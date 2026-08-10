//go:build darwin

package tools

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

// writeAliasFile creates a macOS Finder alias file at aliasPath pointing at
// target: the bookmark blob in the data fork plus the com.apple.FinderInfo
// xattr with kIsAlias set, exactly as Finder and -[NSURL writeBookmarkData:toURL:]
// produce them. Written by hand rather than through CoreServices because the
// agent must build and test with CGO_ENABLED=0.
func writeAliasFile(t *testing.T, aliasPath, target string) {
	t.Helper()

	if !filepath.IsAbs(target) {
		t.Fatalf("alias target %q must be absolute", target)
	}
	components := strings.Split(strings.Trim(target, "/"), "/")
	blob := buildBookmark(t, "/", components)

	if err := os.WriteFile(aliasPath, blob, 0o644); err != nil {
		t.Fatalf("write alias file: %v", err)
	}
	setFinderAliasFlag(t, aliasPath)
}

func setFinderAliasFlag(t *testing.T, path string) {
	t.Helper()
	var finderInfo [32]byte
	copy(finderInfo[0:4], "alis")
	copy(finderInfo[4:8], "MACS")
	binary.BigEndian.PutUint16(finderInfo[8:10], finderFlagIsAlias)
	if err := unix.Setxattr(path, finderInfoAttr, finderInfo[:], 0); err != nil {
		t.Fatalf("set FinderInfo xattr: %v", err)
	}
}

// entryByName finds a listing entry by name.
func entryByName(t *testing.T, entries []FileEntry, name string) FileEntry {
	t.Helper()
	for _, e := range entries {
		if e.Name == name {
			return e
		}
	}
	t.Fatalf("entry %q not found in listing of %d entries", name, len(entries))
	return FileEntry{}
}

func listDir(t *testing.T, dir string) FileListResponse {
	t.Helper()
	var payload FileListResponse
	decodeSuccessPayload(t, ListFiles(map[string]any{"path": dir}), &payload)
	return payload
}

// The reported bug (#3344): an alias to a folder listed as a plain file, so the
// UI offered to download the bookmark blob instead of navigating into it.
func TestListFilesResolvesFolderAlias(t *testing.T) {
	root := t.TempDir()
	targetDir := filepath.Join(root, "iCloud Folder")
	if err := os.Mkdir(targetDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(targetDir, "inside.txt"), []byte("data"), 0o644); err != nil {
		t.Fatal(err)
	}

	desktop := filepath.Join(root, "Desktop")
	if err := os.Mkdir(desktop, 0o755); err != nil {
		t.Fatal(err)
	}
	aliasPath := filepath.Join(desktop, "iCloud Folder alias")
	writeAliasFile(t, aliasPath, targetDir)

	entry := entryByName(t, listDir(t, desktop).Entries, "iCloud Folder alias")

	if entry.Type != "directory" {
		t.Errorf("Type = %q, want %q so the client navigates instead of downloading", entry.Type, "directory")
	}
	if !entry.IsAlias {
		t.Error("IsAlias = false, want true")
	}
	if entry.AliasTarget != targetDir {
		t.Errorf("AliasTarget = %q, want %q", entry.AliasTarget, targetDir)
	}
	// Path must stay on the alias so rename/delete/move act on the alias and
	// not on the folder it points at.
	if entry.Path != aliasPath {
		t.Errorf("Path = %q, want the alias itself %q", entry.Path, aliasPath)
	}
	// Likewise the size describes the ~1KB alias file, which is what a delete
	// confirmation would be quoting.
	if entry.Size == 0 || entry.Size > maxAliasFileSize {
		t.Errorf("Size = %d, want the alias file's own size", entry.Size)
	}
}

func TestListFilesResolvesFileAlias(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "report.pdf")
	if err := os.WriteFile(target, []byte("pdf bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	aliasPath := filepath.Join(root, "report alias")
	writeAliasFile(t, aliasPath, target)

	entry := entryByName(t, listDir(t, root).Entries, "report alias")

	if entry.Type != "file" {
		t.Errorf("Type = %q, want %q", entry.Type, "file")
	}
	if !entry.IsAlias || entry.AliasTarget != target {
		t.Errorf("IsAlias = %v, AliasTarget = %q, want true / %q", entry.IsAlias, entry.AliasTarget, target)
	}
}

// Navigating into a folder alias: the client sends the alias's own path, and
// the agent must list the target and report the path it actually listed so the
// client's breadcrumb and upload destination follow it there.
func TestListFilesNavigatesIntoFolderAlias(t *testing.T) {
	root := t.TempDir()
	targetDir := filepath.Join(root, "Target")
	if err := os.Mkdir(targetDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(targetDir, "inside.txt"), []byte("data"), 0o644); err != nil {
		t.Fatal(err)
	}
	aliasPath := filepath.Join(root, "Target alias")
	writeAliasFile(t, aliasPath, targetDir)

	payload := listDir(t, aliasPath)

	if payload.Path != targetDir {
		t.Errorf("listed Path = %q, want the resolved target %q", payload.Path, targetDir)
	}
	entryByName(t, payload.Entries, "inside.txt")
}

// Downloading a file alias must deliver the target's bytes, not the bookmark
// blob, and must report the target's path so the download gets the target's
// filename.
func TestReadFileResolvesFileAlias(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "notes.txt")
	content := "the real contents"
	if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	aliasPath := filepath.Join(root, "notes alias")
	writeAliasFile(t, aliasPath, target)

	var payload struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	decodeSuccessPayload(t, ReadFile(map[string]any{"path": aliasPath}), &payload)

	if payload.Content != content {
		t.Errorf("Content = %q, want the target's contents %q", payload.Content, content)
	}
	if payload.Path != target {
		t.Errorf("Path = %q, want the resolved target %q", payload.Path, target)
	}
}

// An alias chain (alias -> alias -> folder) resolves all the way through.
func TestResolvesAliasChain(t *testing.T) {
	root := t.TempDir()
	targetDir := filepath.Join(root, "Final")
	if err := os.Mkdir(targetDir, 0o755); err != nil {
		t.Fatal(err)
	}
	first := filepath.Join(root, "hop1")
	second := filepath.Join(root, "hop2")
	writeAliasFile(t, second, targetDir)
	writeAliasFile(t, first, second)

	entry := entryByName(t, listDir(t, root).Entries, "hop1")
	if entry.Type != "directory" || entry.AliasTarget != targetDir {
		t.Errorf("Type = %q, AliasTarget = %q, want directory / %q", entry.Type, entry.AliasTarget, targetDir)
	}
}

// A chain that points back at itself must terminate rather than spin.
func TestAliasChainCycleTerminates(t *testing.T) {
	root := t.TempDir()
	a := filepath.Join(root, "a")
	b := filepath.Join(root, "b")
	writeAliasFile(t, a, b)
	writeAliasFile(t, b, a)

	entry := entryByName(t, listDir(t, root).Entries, "a")
	// Whatever it settles on, it must be a terminating, non-panicking listing.
	if entry.Path != a {
		t.Errorf("Path = %q, want %q", entry.Path, a)
	}
}

// SR5-01: alias resolution deliberately escapes the listed directory, so the
// credential-store deny-list has to be re-applied against the target. An alias
// pointing at a secret must not be resolved, must not disclose its target, and
// must not be readable through the alias.
func TestAliasToSensitivePathIsNotResolved(t *testing.T) {
	root := t.TempDir()
	sshDir := filepath.Join(root, ".ssh")
	if err := os.Mkdir(sshDir, 0o700); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(sshDir, "id_rsa")
	if err := os.WriteFile(secret, []byte("PRIVATE KEY"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !isSensitiveReadPath(secret) {
		t.Fatalf("test setup: %q is not on the deny-list", secret)
	}

	aliasPath := filepath.Join(root, "harmless alias")
	writeAliasFile(t, aliasPath, secret)

	entry := entryByName(t, listDir(t, root).Entries, "harmless alias")
	if entry.IsAlias {
		t.Error("IsAlias = true, want false: an alias into a credential store must stay unresolved")
	}
	if entry.AliasTarget != "" {
		t.Errorf("AliasTarget = %q, want empty: the target path must not be disclosed", entry.AliasTarget)
	}
	if entry.Type != "file" {
		t.Errorf("Type = %q, want %q", entry.Type, "file")
	}

	// Reading through the alias must be denied outright, not silently served.
	result := ReadFile(map[string]any{"path": aliasPath})
	if result.Status == "completed" {
		t.Fatalf("ReadFile through an alias into a credential store succeeded: %s", result.Stdout)
	}
	if !strings.Contains(result.Error, "sensitive path") {
		t.Errorf("Error = %q, want a sensitive-path denial", result.Error)
	}
	if strings.Contains(result.Stdout, "PRIVATE KEY") {
		t.Error("secret contents leaked through the alias")
	}
}

// Listing an alias that points at a credential-store directory must be denied
// rather than falling back to listing the alias file itself.
func TestListFilesThroughAliasToSensitiveDirIsDenied(t *testing.T) {
	root := t.TempDir()
	// /etc/sudoers.d is deny-listed as a directory in its own right, unlike
	// e.g. Library/Keychains which is only matched with a trailing separator.
	sensitiveDir := filepath.Join(root, "etc", "sudoers.d")
	if err := os.MkdirAll(sensitiveDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if !isSensitiveReadPath(sensitiveDir) {
		t.Fatalf("test setup: %q is not on the deny-list", sensitiveDir)
	}

	aliasPath := filepath.Join(root, "keys alias")
	writeAliasFile(t, aliasPath, sensitiveDir)

	result := ListFiles(map[string]any{"path": aliasPath})
	if result.Status == "completed" {
		t.Fatalf("listing through an alias into a keychain directory succeeded: %s", result.Stdout)
	}
	if !strings.Contains(result.Error, "sensitive path") {
		t.Errorf("Error = %q, want a sensitive-path denial", result.Error)
	}
}

// Things that must NOT be treated as aliases.
func TestNonAliasesAreLeftAlone(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target.txt")
	if err := os.WriteFile(target, []byte("data"), 0o644); err != nil {
		t.Fatal(err)
	}

	// A bookmark blob with no kIsAlias flag: some apps store bookmark data in
	// ordinary files, and those are still just files.
	unflagged := filepath.Join(root, "bookmark.data")
	if err := os.WriteFile(unflagged, buildBookmark(t, "/", strings.Split(strings.Trim(target, "/"), "/")), 0o644); err != nil {
		t.Fatal(err)
	}

	// Flagged, but the payload is not a bookmark.
	junk := filepath.Join(root, "junk.bin")
	if err := os.WriteFile(junk, []byte(strings.Repeat("not a bookmark", 8)), 0o644); err != nil {
		t.Fatal(err)
	}
	setFinderAliasFlag(t, junk)

	// A well-formed alias whose target has been deleted.
	dangling := filepath.Join(root, "dangling alias")
	writeAliasFile(t, dangling, filepath.Join(root, "gone.txt"))

	// A plain file and a POSIX symlink, which the existing code already handles.
	plain := filepath.Join(root, "plain.txt")
	if err := os.WriteFile(plain, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link.txt")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}

	entries := listDir(t, root).Entries
	for _, name := range []string{"bookmark.data", "junk.bin", "dangling alias", "plain.txt", "link.txt"} {
		e := entryByName(t, entries, name)
		if e.IsAlias {
			t.Errorf("%s: IsAlias = true, want false", name)
		}
		if e.AliasTarget != "" {
			t.Errorf("%s: AliasTarget = %q, want empty", name, e.AliasTarget)
		}
		if e.Type != "file" {
			t.Errorf("%s: Type = %q, want %q", name, e.Type, "file")
		}
	}
}

// A file large enough to be implausible as an alias is never opened for
// parsing, even if it carries the flag.
func TestOversizedFlaggedFileIsNotProbed(t *testing.T) {
	root := t.TempDir()
	big := filepath.Join(root, "big.bin")
	if err := os.WriteFile(big, make([]byte, maxAliasFileSize+1), 0o644); err != nil {
		t.Fatal(err)
	}
	setFinderAliasFlag(t, big)

	entry := entryByName(t, listDir(t, root).Entries, "big.bin")
	if entry.IsAlias {
		t.Error("IsAlias = true for an oversized file, want false")
	}
}

func TestHasFinderAliasFlag(t *testing.T) {
	root := t.TempDir()
	plain := filepath.Join(root, "plain.txt")
	if err := os.WriteFile(plain, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if hasFinderAliasFlag(plain) {
		t.Error("hasFinderAliasFlag() = true for a file with no FinderInfo xattr")
	}

	// FinderInfo present but kIsAlias clear (e.g. a custom-icon flag).
	tagged := filepath.Join(root, "tagged.txt")
	if err := os.WriteFile(tagged, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	var fi [32]byte
	copy(fi[0:4], "TEXT")
	copy(fi[4:8], "MACS")
	binary.BigEndian.PutUint16(fi[8:10], 0x0400) // kHasCustomIcon
	if err := unix.Setxattr(tagged, finderInfoAttr, fi[:], 0); err != nil {
		t.Fatal(err)
	}
	if hasFinderAliasFlag(tagged) {
		t.Error("hasFinderAliasFlag() = true for FinderInfo without kIsAlias")
	}

	setFinderAliasFlag(t, tagged)
	if !hasFinderAliasFlag(tagged) {
		t.Error("hasFinderAliasFlag() = false for FinderInfo with kIsAlias")
	}
}
