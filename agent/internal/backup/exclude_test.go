package backup

import (
	"os"
	pathpkg "path/filepath"
	"testing"
)

func TestExcludeMatcher(t *testing.T) {
	tests := []struct {
		name            string
		patterns        []string
		relPath         string
		caseInsensitive bool
		want            bool
	}{
		// Base-name globs (no slash)
		{name: "tmp glob matches file", patterns: []string{"*.tmp"}, relPath: "docs/report.tmp", want: true},
		{name: "tmp glob spares other files", patterns: []string{"*.tmp"}, relPath: "docs/report.txt", want: false},
		{name: "bare name matches directory base", patterns: []string{"node_modules"}, relPath: "app/node_modules", want: true},
		{name: "exact file name at root", patterns: []string{"Thumbs.db"}, relPath: "Thumbs.db", want: true},
		{name: "exact file name nested", patterns: []string{".DS_Store"}, relPath: "a/b/.DS_Store", want: true},
		{name: "base-name glob does not match path segments mid-path", patterns: []string{"*.tmp"}, relPath: "cache.tmp/data.txt", want: false},

		// Path-relative doublestar globs
		{name: "dir doublestar matches dir itself", patterns: []string{"node_modules/**"}, relPath: "node_modules", want: true},
		{name: "dir doublestar matches nested dir", patterns: []string{"node_modules/**"}, relPath: "app/node_modules", want: true},
		{name: "dir doublestar matches contents", patterns: []string{"node_modules/**"}, relPath: "app/node_modules/react/index.js", want: true},
		{name: "leading doublestar nested glob matches deep", patterns: []string{"**/AppData/Local/Temp/**"}, relPath: "alice/AppData/Local/Temp/x.dat", want: true},
		{name: "leading doublestar matches the dir itself", patterns: []string{"**/AppData/Local/Temp/**"}, relPath: "alice/AppData/Local/Temp", want: true},
		{name: "nested glob requires all middle segments", patterns: []string{"**/AppData/Local/Temp/**"}, relPath: "alice/AppData/Local", want: false},
		{name: "dollar sign is literal", patterns: []string{"$RECYCLE.BIN/**"}, relPath: "$RECYCLE.BIN/S-1-5/file", want: true},
		{name: "star in path pattern", patterns: []string{"**/OneDrive*/**"}, relPath: "bob/OneDrive - Contoso/doc.docx", want: true},
		{name: "path pattern spares unrelated path", patterns: []string{"node_modules/**"}, relPath: "src/index.ts", want: false},

		// Normalization
		{name: "backslash pattern normalized", patterns: []string{"AppData\\Local\\Temp/**"}, relPath: "AppData/Local/Temp/x", want: true},
		{name: "backslash relPath normalized", patterns: []string{"node_modules/**"}, relPath: "app\\node_modules\\x.js", want: true},
		{name: "case-insensitive on windows", patterns: []string{"thumbs.db"}, relPath: "pics/Thumbs.DB", caseInsensitive: true, want: true},
		{name: "case-sensitive elsewhere", patterns: []string{"thumbs.db"}, relPath: "pics/Thumbs.DB", want: false},

		// No excludes / invalid patterns
		{name: "no patterns passes everything through", patterns: nil, relPath: "anything.tmp", want: false},
		{name: "invalid pattern is dropped not fatal", patterns: []string{"[unclosed"}, relPath: "file.txt", want: false},
		{name: "invalid pattern does not disable valid ones", patterns: []string{"[unclosed", "*.tmp"}, relPath: "file.tmp", want: true},
		{name: "bracket class containing slash is dropped at compile", patterns: []string{"a[x/y]b"}, relPath: "a[x/y]b/file.txt", want: false},
		{name: "bracket-slash pattern does not disable valid ones", patterns: []string{"a[x/y]b", "*.tmp"}, relPath: "file.tmp", want: true},
		{name: "empty interior segment is invalid", patterns: []string{"a//b"}, relPath: "a/b", want: false},
		{name: "empty and whitespace patterns ignored", patterns: []string{"", "  "}, relPath: "file.txt", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := newExcludeMatcherForOS(tt.patterns, tt.caseInsensitive)
			if got := m.matches(tt.relPath); got != tt.want {
				t.Errorf("matches(%q) with patterns %v = %v, want %v", tt.relPath, tt.patterns, got, tt.want)
			}
		})
	}
}

func TestExcludeMatcher_NilSafe(t *testing.T) {
	var m *excludeMatcher
	if m.matches("anything") {
		t.Error("nil matcher must match nothing")
	}
	if newExcludeMatcherForOS(nil, false) != nil {
		t.Error("no patterns should compile to a nil matcher")
	}
	if newExcludeMatcherForOS([]string{"", "[bad"}, false) != nil {
		t.Error("only-unusable patterns should compile to a nil matcher")
	}
	if newExcludeMatcherForOS([]string{"a[x/y]b", "a//b"}, false) != nil {
		t.Error("per-segment-invalid slash patterns should compile to a nil matcher")
	}
}

// TestCollectBackupFiles_Excludes drives the real walker over a temp tree and
// checks glob exclusions end-to-end (#2418).
func TestCollectBackupFiles_Excludes(t *testing.T) {
	newTree := func(t *testing.T) string {
		t.Helper()
		root := t.TempDir()
		mkdir := func(parts ...string) string {
			p := pathpkg.Join(append([]string{root}, parts...)...)
			if err := os.MkdirAll(p, 0755); err != nil {
				t.Fatalf("mkdir %s: %v", p, err)
			}
			return p
		}
		mkdir("src")
		mkdir("src", "node_modules", "react")
		mkdir("cache")
		createTempFile(t, root, "keep.txt", "keep")
		createTempFile(t, root, "junk.tmp", "junk")
		createTempFile(t, pathpkg.Join(root, "src"), "app.ts", "code")
		createTempFile(t, pathpkg.Join(root, "src", "node_modules"), "pkg.json", "{}")
		createTempFile(t, pathpkg.Join(root, "src", "node_modules", "react"), "index.js", "js")
		createTempFile(t, pathpkg.Join(root, "cache"), "blob.bin", "bin")
		return root
	}

	tests := []struct {
		name     string
		excludes []string
		want     []string // expected snapshot paths (path_0-relative, sorted)
	}{
		{
			name:     "no excludes passthrough",
			excludes: nil,
			want: []string{
				"path_0/cache/blob.bin",
				"path_0/junk.tmp",
				"path_0/keep.txt",
				"path_0/src/app.ts",
				"path_0/src/node_modules/pkg.json",
				"path_0/src/node_modules/react/index.js",
			},
		},
		{
			name:     "tmp glob excludes matching files only",
			excludes: []string{"*.tmp"},
			want: []string{
				"path_0/cache/blob.bin",
				"path_0/keep.txt",
				"path_0/src/app.ts",
				"path_0/src/node_modules/pkg.json",
				"path_0/src/node_modules/react/index.js",
			},
		},
		{
			name:     "directory name exclusion skips whole subtree",
			excludes: []string{"node_modules"},
			want: []string{
				"path_0/cache/blob.bin",
				"path_0/junk.tmp",
				"path_0/keep.txt",
				"path_0/src/app.ts",
			},
		},
		{
			name:     "nested doublestar glob skips subtree at any depth",
			excludes: []string{"**/node_modules/**"},
			want: []string{
				"path_0/cache/blob.bin",
				"path_0/junk.tmp",
				"path_0/keep.txt",
				"path_0/src/app.ts",
			},
		},
		{
			name:     "combined patterns",
			excludes: []string{"*.tmp", "node_modules/**", "cache/**"},
			want: []string{
				"path_0/keep.txt",
				"path_0/src/app.ts",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := newTree(t)
			mgr := NewBackupManager(BackupConfig{
				Paths:    []string{root},
				Excludes: tt.excludes,
			})

			files, err := mgr.collectBackupFiles()
			if err != nil {
				t.Fatalf("collectBackupFiles failed: %v", err)
			}
			var got []string
			for _, f := range files {
				got = append(got, f.snapshotPath)
			}
			if len(got) != len(tt.want) {
				t.Fatalf("got %d files %v, want %d files %v", len(got), got, len(tt.want), tt.want)
			}
			for i := range tt.want {
				if got[i] != tt.want[i] {
					t.Errorf("file[%d] = %q, want %q", i, got[i], tt.want[i])
				}
			}
		})
	}
}

// A base-name glob matches directories too: a dir whose NAME matches the
// pattern is pruned as a whole subtree, even though the files inside it would
// not match the glob themselves. Pins the documented "files AND directories"
// base-name semantics end-to-end so a future file-only "fix" fails loudly.
func TestCollectBackupFiles_BaseNameGlobExcludesDirectorySubtree(t *testing.T) {
	root := t.TempDir()
	tmpDir := pathpkg.Join(root, "cache.tmp")
	if err := os.MkdirAll(tmpDir, 0755); err != nil {
		t.Fatalf("mkdir %s: %v", tmpDir, err)
	}
	createTempFile(t, root, "keep.txt", "keep")
	createTempFile(t, tmpDir, "data.txt", "inside excluded dir")

	mgr := NewBackupManager(BackupConfig{
		Paths:    []string{root},
		Excludes: []string{"*.tmp"},
	})

	files, err := mgr.collectBackupFiles()
	if err != nil {
		t.Fatalf("collectBackupFiles failed: %v", err)
	}
	if len(files) != 1 || files[0].snapshotPath != "path_0/keep.txt" {
		t.Fatalf("expected only path_0/keep.txt (cache.tmp/ subtree pruned), got %+v", files)
	}
}

// Per-run excludes passed by the backup_run command override config excludes.
func TestCollectBackupFilesFromPaths_PerRunExcludesOverrideConfig(t *testing.T) {
	root := t.TempDir()
	createTempFile(t, root, "a.tmp", "a")
	createTempFile(t, root, "b.log", "b")

	mgr := NewBackupManager(BackupConfig{
		Paths:    []string{root},
		Excludes: []string{"*.log"}, // config says exclude logs
	})

	// Per-run override: exclude *.tmp instead (as backup_run payload would).
	files, err := mgr.collectBackupFilesFromPaths(
		t.Context(), []string{root}, newExcludeMatcher([]string{"*.tmp"}),
	)
	if err != nil {
		t.Fatalf("collectBackupFilesFromPaths failed: %v", err)
	}
	if len(files) != 1 || files[0].snapshotPath != "path_0/b.log" {
		t.Fatalf("expected only path_0/b.log, got %+v", files)
	}
}

// A single-file backup root is also subject to base-name exclusion.
func TestCollectBackupFiles_SingleFileRootExcluded(t *testing.T) {
	root := t.TempDir()
	file := createTempFile(t, root, "solo.tmp", "solo")

	mgr := NewBackupManager(BackupConfig{
		Paths:    []string{file},
		Excludes: []string{"*.tmp"},
	})

	files, err := mgr.collectBackupFiles()
	if err != nil {
		t.Fatalf("collectBackupFiles failed: %v", err)
	}
	if len(files) != 0 {
		t.Fatalf("expected excluded single-file root to yield 0 files, got %+v", files)
	}
}
