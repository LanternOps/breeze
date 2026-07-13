package workspaceindex

import (
	"context"
	"errors"
	"io/fs"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"golang.org/x/time/rate"
)

var walkerTestTime = time.Date(2026, time.July, 12, 14, 0, 0, 0, time.UTC)

type fakeWalkNode struct {
	dir     bool
	size    int64
	mode    fs.FileMode
	modTime time.Time
}

type fakeWalkFS struct {
	mu         sync.Mutex
	nodes      map[string]fakeWalkNode
	readDirOps int
	statOps    int
	onStat     func()
}

func newFakeWalkFS(root string, nodes map[string]fakeWalkNode) *fakeWalkFS {
	all := map[string]fakeWalkNode{
		filepath.Clean(root): {dir: true, mode: fs.ModeDir | 0o755, modTime: walkerTestTime},
	}
	for relPath, node := range nodes {
		if node.modTime.IsZero() {
			node.modTime = walkerTestTime
		}
		if node.dir {
			node.mode |= fs.ModeDir
		}
		all[filepath.Join(root, filepath.FromSlash(relPath))] = node
	}
	return &fakeWalkFS{nodes: all}
}

func (f *fakeWalkFS) ReadDir(name string) ([]fs.DirEntry, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.readDirOps++

	name = filepath.Clean(name)
	node, ok := f.nodes[name]
	if !ok {
		return nil, fs.ErrNotExist
	}
	if !node.dir {
		return nil, errors.New("not a directory")
	}

	var entries []fs.DirEntry
	for childPath, child := range f.nodes {
		if childPath == name || filepath.Dir(childPath) != name {
			continue
		}
		entries = append(entries, fakeWalkDirEntry{name: filepath.Base(childPath), node: child})
	}
	// Intentionally reverse the map-derived order. Walk must sort its own copy.
	for left, right := 0, len(entries)-1; left < right; left, right = left+1, right-1 {
		entries[left], entries[right] = entries[right], entries[left]
	}
	return entries, nil
}

func (f *fakeWalkFS) Stat(name string) (fs.FileInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.statOps++

	node, ok := f.nodes[filepath.Clean(name)]
	if !ok {
		return nil, fs.ErrNotExist
	}
	if f.onStat != nil {
		f.onStat()
	}
	return fakeWalkFileInfo{name: filepath.Base(name), node: node}, nil
}

func (f *fakeWalkFS) opCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.readDirOps + f.statOps
}

type fakeWalkDirEntry struct {
	name string
	node fakeWalkNode
}

func (e fakeWalkDirEntry) Name() string               { return e.name }
func (e fakeWalkDirEntry) IsDir() bool                { return e.node.dir }
func (e fakeWalkDirEntry) Type() fs.FileMode          { return e.node.mode.Type() }
func (e fakeWalkDirEntry) Info() (fs.FileInfo, error) { return fakeWalkFileInfo(e), nil }

type fakeWalkFileInfo struct {
	name string
	node fakeWalkNode
}

func (i fakeWalkFileInfo) Name() string       { return i.name }
func (i fakeWalkFileInfo) Size() int64        { return i.node.size }
func (i fakeWalkFileInfo) Mode() fs.FileMode  { return i.node.mode }
func (i fakeWalkFileInfo) ModTime() time.Time { return i.node.modTime }
func (i fakeWalkFileInfo) IsDir() bool        { return i.node.dir }
func (i fakeWalkFileInfo) Sys() any           { return nil }

func collectWalk(t *testing.T, fsys SourceFS, root string, opts WalkOptions) ([]Entry, string, error) {
	t.Helper()
	var entries []Entry
	lastCursor, err := Walk(context.Background(), fsys, root, opts, func(entry Entry) error {
		entries = append(entries, entry)
		return nil
	})
	return entries, lastCursor, err
}

func entryPaths(entries []Entry) []string {
	paths := make([]string, len(entries))
	for i, entry := range entries {
		paths[i] = entry.RelPath
	}
	return paths
}

func TestWalkDeterministicDepthFirstOrderingAndMetadata(t *testing.T) {
	const root = "root"
	nodes := map[string]fakeWalkNode{
		"zeta.txt":           {size: 9},
		"alpha":              {dir: true, size: 999},
		"alpha/report.TXT":   {size: 42},
		"alpha/beta":         {dir: true, size: 999},
		"alpha/beta/noext":   {size: 7},
		"alpha/beta/.config": {size: 3},
		"skip-link":          {mode: fs.ModeSymlink},
	}
	// alpha/beta/.config is a hidden FILE: the dot-prefix exclusion applies to
	// files as well as directories (#2425), so it must not be emitted.
	wantPaths := []string{
		"alpha",
		"alpha/beta",
		"alpha/beta/noext",
		"alpha/report.TXT",
		"zeta.txt",
	}

	var first []Entry
	for run := 0; run < 2; run++ {
		entries, lastCursor, err := collectWalk(t, newFakeWalkFS(root, nodes), root, WalkOptions{})
		if err != nil {
			t.Fatalf("Walk run %d: %v", run, err)
		}
		if got := entryPaths(entries); !reflect.DeepEqual(got, wantPaths) {
			t.Fatalf("Walk run %d paths = %#v, want %#v", run, got, wantPaths)
		}
		if lastCursor != "zeta.txt" {
			t.Fatalf("Walk run %d cursor = %q, want zeta.txt", run, lastCursor)
		}
		if run == 0 {
			first = entries
		} else if !reflect.DeepEqual(entries, first) {
			t.Fatalf("second Walk differs from first:\nfirst:  %#v\nsecond: %#v", first, entries)
		}
	}

	for _, entry := range first {
		if entry.Attrs == nil {
			t.Fatalf("Attrs is nil for %q", entry.RelPath)
		}
	}
	if got := first[0]; !got.IsDir || got.ParentPath != "" || got.Name != "alpha" || got.Size != 0 || got.Ext != nil {
		t.Fatalf("root directory entry = %+v", got)
	}
	if got := first[1]; !got.IsDir || got.ParentPath != "alpha" || got.Name != "beta" || got.Size != 0 || got.Ext != nil {
		t.Fatalf("nested directory entry = %+v", got)
	}
	if got := first[2]; got.Ext != nil {
		t.Fatalf("extensionless file extension = %q, want nil", *got.Ext)
	}
	if got := first[3]; got.Ext == nil || *got.Ext != "txt" || got.Size != 42 || !got.Mtime.Equal(walkerTestTime) {
		t.Fatalf("file metadata = %+v", got)
	}
}

func TestWalkExcludesBuiltInsAndCustomGlobs(t *testing.T) {
	const root = "root"
	nodes := map[string]fakeWalkNode{
		"$RECYCLE.BIN":                        {dir: true},
		"$RECYCLE.BIN/deleted.txt":            {size: 1},
		"System Volume Information":           {dir: true},
		"System Volume Information/state.bin": {size: 1},
		"Users":                               {dir: true},
		"Users/me":                            {dir: true},
		"Users/me/AppData":                    {dir: true},
		"Users/me/AppData/cache.db":           {size: 1},
		"Users/me/keep.txt":                   {size: 1},
		".hidden":                             {dir: true},
		".hidden/secret.txt":                  {size: 1},
		".env":                                {size: 1},
		"Users/me/.npmrc":                     {size: 1},
		"scratch.tmp":                         {size: 1},
		"logs":                                {dir: true},
		"logs/2026":                           {dir: true},
		"logs/2026/private.log":               {size: 1},
		"logs/2026/public.log":                {size: 1},
		"keep.md":                             {size: 1},
	}

	tests := []struct {
		name         string
		excludeGlobs []string
		want         []string
	}{
		{
			name: "built-in defaults",
			want: []string{
				"Users", "Users/me", "Users/me/keep.txt", "keep.md", "logs", "logs/2026",
				"logs/2026/private.log", "logs/2026/public.log", "scratch.tmp",
			},
		},
		{
			name:         "root and nested custom globs layered over defaults",
			excludeGlobs: []string{"*.tmp", "logs/**/private.*"},
			want: []string{
				"Users", "Users/me", "Users/me/keep.txt", "keep.md", "logs", "logs/2026", "logs/2026/public.log",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			entries, _, err := collectWalk(t, newFakeWalkFS(root, nodes), root, WalkOptions{ExcludeGlobs: tt.excludeGlobs})
			if err != nil {
				t.Fatalf("Walk: %v", err)
			}
			if got := entryPaths(entries); !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("paths = %#v, want %#v", got, tt.want)
			}
		})
	}
}

func TestWalkResumeCursorAtEveryEmittedEntry(t *testing.T) {
	const root = "root"
	nodes := map[string]fakeWalkNode{
		"a":            {dir: true},
		"a/one.txt":    {size: 1},
		"a/sub":        {dir: true},
		"a/sub/two.md": {size: 2},
		"b":            {dir: true},
		"b/three.log":  {size: 3},
		"docs":         {dir: true},
		"docs/child":   {size: 4},
		"docs.md":      {size: 5},
		"z.txt":        {size: 4},
	}

	fullEntries, _, err := collectWalk(t, newFakeWalkFS(root, nodes), root, WalkOptions{})
	if err != nil {
		t.Fatalf("full Walk: %v", err)
	}
	full := entryPaths(fullEntries)

	for cut := range full {
		cursor := full[cut]
		resumedEntries, lastCursor, resumeErr := collectWalk(t, newFakeWalkFS(root, nodes), root, WalkOptions{ResumeCursor: cursor})
		if resumeErr != nil {
			t.Fatalf("resume after %q: %v", cursor, resumeErr)
		}
		combined := append(append([]string(nil), full[:cut+1]...), entryPaths(resumedEntries)...)
		if !reflect.DeepEqual(combined, full) {
			t.Fatalf("resume after %q produced %#v, want %#v", cursor, combined, full)
		}
		if cut == len(full)-1 {
			if lastCursor != "" {
				t.Fatalf("resume after final cursor returned %q, want empty", lastCursor)
			}
		} else if lastCursor != full[len(full)-1] {
			t.Fatalf("resume after %q returned cursor %q, want %q", cursor, lastCursor, full[len(full)-1])
		}
	}
}

func TestWalkCancellationBetweenEntries(t *testing.T) {
	const root = "root"
	fsys := newFakeWalkFS(root, map[string]fakeWalkNode{
		"a.txt": {size: 1},
		"b.txt": {size: 1},
	})
	ctx, cancel := context.WithCancel(context.Background())
	var emitted []string

	lastCursor, err := Walk(ctx, fsys, root, WalkOptions{}, func(entry Entry) error {
		emitted = append(emitted, entry.RelPath)
		cancel()
		return nil
	})

	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Walk error = %v, want context.Canceled", err)
	}
	if !reflect.DeepEqual(emitted, []string{"a.txt"}) {
		t.Fatalf("emitted = %#v, want only first entry", emitted)
	}
	if lastCursor != "a.txt" {
		t.Fatalf("last cursor = %q, want a.txt", lastCursor)
	}
}

func TestWalkCancellationDuringStatDoesNotEmit(t *testing.T) {
	const root = "root"
	fsys := newFakeWalkFS(root, map[string]fakeWalkNode{"a.txt": {size: 1}})
	ctx, cancel := context.WithCancel(context.Background())
	fsys.onStat = cancel
	var emitted []string

	lastCursor, err := Walk(ctx, fsys, root, WalkOptions{}, func(entry Entry) error {
		emitted = append(emitted, entry.RelPath)
		return nil
	})

	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Walk error = %v, want context.Canceled", err)
	}
	if len(emitted) != 0 {
		t.Fatalf("emitted after cancellation during Stat: %#v", emitted)
	}
	if lastCursor != "" {
		t.Fatalf("last cursor = %q, want empty", lastCursor)
	}
}

func TestWalkLimiterWaitsOncePerFilesystemOperation(t *testing.T) {
	const (
		root  = "root"
		burst = 100
	)
	fsys := newFakeWalkFS(root, map[string]fakeWalkNode{
		"dir":          {dir: true},
		"dir/file.txt": {size: 1},
		"root.txt":     {size: 2},
	})
	limiter := rate.NewLimiter(0, burst)

	entries, _, err := collectWalk(t, fsys, root, WalkOptions{Limiter: limiter})
	if err != nil {
		t.Fatalf("Walk: %v", err)
	}
	if got, want := entryPaths(entries), []string{"dir", "dir/file.txt", "root.txt"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("paths = %#v, want %#v", got, want)
	}
	ops := fsys.opCount()
	if got, want := int(limiter.Tokens()), burst-ops; got != want {
		t.Fatalf("limiter tokens = %d after %d filesystem operations, want %d", got, ops, want)
	}
}
