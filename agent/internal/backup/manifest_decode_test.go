package backup

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"runtime"
	"runtime/metrics"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// fullManifestFixture returns a manifest with every serialized Snapshot field
// populated, so the parity test covers each of them.
func fullManifestFixture() Snapshot {
	ts := time.Date(2026, 3, 4, 5, 6, 7, 8000, time.UTC)
	return Snapshot{
		ID:        "snap-full",
		Timestamp: ts,
		Files: []SnapshotFile{
			{SourcePath: "/data/a.txt", BackupPath: "snapshots/snap-full/files/a.gz", Size: 3, ModTime: ts, Checksum: strings.Repeat("ab", 32), Mode: 0o644},
			{SourcePath: `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1\data\b.txt`, OriginalPath: `C:\data\b.txt`, BackupPath: "snapshots/snap-full/files/b.gz", Size: 9, ModTime: ts, Volatile: true, WinAttrs: 0x20, SDIndex: 1},
			{SourcePath: "/data/link", Kind: KindSymlink, LinkTarget: "a.txt", ModTime: ts, Owner: &FileOwner{UID: 1000, GID: 1000}},
			{SourcePath: "/data", Kind: KindDir, ModeBits: 0o1755, ModTime: ts, Placeholder: true},
		},
		Junctions:           []SnapshotJunction{{SourcePath: `C:\Users\a\My Music`, Target: `C:\Users\a\Music`, ModTime: ts}},
		SecurityDescriptors: []string{"AQAEgBQAAAAkAAAAAAAAADQAAAA="},
		Size:                12,
		FormatVersion:       2,
		BaseSnapshotID:      "snap-prev",
		BackupIdentity:      "agent-1|dest-1|files",
		IncompleteFiles:     2,
		IncompleteFilePaths: []string{"/data/locked.db", "/data/gone.txt"},
	}
}

// TestDecodeSnapshotManifestMatchesUnmarshal pins "no behaviour change": for
// each input in the table the streaming decoder must succeed exactly when
// json.Unmarshal into a Snapshot does, and produce the same value. The one
// documented divergence (a repeated "files" key) has its own test below.
func TestDecodeSnapshotManifestMatchesUnmarshal(t *testing.T) {
	full, err := json.Marshal(fullManifestFixture())
	if err != nil {
		t.Fatal(err)
	}
	indented, err := json.MarshalIndent(fullManifestFixture(), "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]string{
		"full manifest":                string(full),
		"indented manifest":            string(indented),
		"empty object":                 `{}`,
		"top-level null":               `null`,
		"files null":                   `{"id":"x","files":null}`,
		"files empty":                  `{"files":[]}`,
		"files key missing":            `{"id":"x","size":4}`,
		"files before other keys":      `{"files":[{"sourcePath":"/a"}],"id":"x","junctions":[{"sourcePath":"j"}]}`,
		"files after other keys":       `{"id":"x","securityDescriptors":["AA=="],"files":[{"sourcePath":"/a"},{"sourcePath":"/b"}]}`,
		"null file entry":              `{"files":[null,{"sourcePath":"/a"}]}`,
		"case-folded files key":        `{"Files":[{"sourcePath":"/a"}]}`,
		"escaped files key":            `{"fi\u006ces":[{"sourcePath":"/a"}]}`,
		"duplicate scalar keys":        `{"id":"a","id":"b"}`,
		"case-folded scalar key":       `{"ID":"x","FormatVersion":2}`,
		"unknown keys ignored":         `{"future":{"nested":[1,{"x":null}]},"files":[{"sourcePath":"/a","futureField":[1,2]}],"other":"y"}`,
		"surrounding whitespace":       " \n\t{\"files\":[ {\"sourcePath\":\"/a\"} ]}\n ",
		"empty input":                  ``,
		"whitespace only":              "  \n",
		"truncated in files":           `{"files":[{"sourcePath":"/a"}`,
		"truncated after key":          `{"files"`,
		"trailing garbage":             `{"files":[]} x`,
		"trailing second value":        `{}{}`,
		"files is an object":           `{"files":{}}`,
		"files is a string":            `{"files":"nope"}`,
		"file entry wrong field type":  `{"files":[{"size":"big"}]}`,
		"file entry not an object":     `{"files":[1]}`,
		"scalar field wrong type":      `{"files":[{"sourcePath":"/a"}],"formatVersion":"two"}`,
		"top-level array":              `[]`,
		"top-level string":             `"manifest"`,
		"timestamp malformed":          `{"timestamp":"yesterday"}`,
		"missing comma between fields": `{"id":"x" "files":[]}`,
	}
	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			var want Snapshot
			wantErr := json.Unmarshal([]byte(input), &want)

			got, gotErr := decodeSnapshotManifest(strings.NewReader(input), nil)
			if (gotErr != nil) != (wantErr != nil) {
				t.Fatalf("error mismatch: streaming=%v, json.Unmarshal=%v", gotErr, wantErr)
			}
			if wantErr != nil {
				return
			}
			if !reflect.DeepEqual(*got, want) {
				t.Fatalf("decoded snapshot differs from json.Unmarshal:\n got  %+v\n want %+v", *got, want)
			}
		})
	}
}

// TestDecodeSnapshotManifestRepeatedFilesKeyRestartsList pins the one
// divergence from json.Unmarshal: a repeated "files" key (which the agent
// never writes) yields only the repeat's entries, each decoded fresh, where
// json.Unmarshal decodes the repeat into the earlier entries in place and
// keeps their fields.
func TestDecodeSnapshotManifestRepeatedFilesKeyRestartsList(t *testing.T) {
	for _, input := range []string{
		`{"files":[{"sourcePath":"/a","size":1,"mode":3}],"files":[{"sourcePath":"/b"}]}`,
		`{"files":[{"sourcePath":"/a","size":1},{"sourcePath":"/c","size":5}],"FILES":[{"sourcePath":"/b"}]}`,
	} {
		got, err := decodeSnapshotManifest(strings.NewReader(input), nil)
		if err != nil {
			t.Fatalf("%s: %v", input, err)
		}
		want := []SnapshotFile{{SourcePath: "/b"}}
		if !reflect.DeepEqual(got.Files, want) {
			t.Fatalf("%s: files %+v, want %+v", input, got.Files, want)
		}
	}
}

// TestDecodeSnapshotManifestKeepRetainsOnlyMatchingEntries checks that the
// keep predicate applied while decoding retains exactly what filterFiles
// would have kept from the fully decoded list, in manifest order, and leaves
// every other manifest field intact.
func TestDecodeSnapshotManifestKeepRetainsOnlyMatchingEntries(t *testing.T) {
	fixture := fullManifestFixture()
	data, err := json.Marshal(fixture)
	if err != nil {
		t.Fatal(err)
	}
	for _, selected := range [][]string{
		{"/data/a.txt"},
		{`C:\data`},
		{"/data/link", `C:\data\b.txt`},
		{"/nothing/here"},
	} {
		got, err := decodeSnapshotManifest(strings.NewReader(string(data)), restoreSelection(selected))
		if err != nil {
			t.Fatalf("%v: %v", selected, err)
		}
		want := fixture
		want.Files = filterFiles(fixture.Files, selected)
		if len(got.Files) != len(want.Files) || (len(want.Files) > 0 && !reflect.DeepEqual(got.Files, want.Files)) {
			t.Fatalf("%v: kept %+v, want %+v", selected, got.Files, want.Files)
		}
		got.Files, want.Files = nil, nil
		if !reflect.DeepEqual(*got, want) {
			t.Fatalf("%v: non-file fields changed:\n got  %+v\n want %+v", selected, *got, want)
		}
	}
	if restoreSelection(nil) != nil {
		t.Fatal("an empty selection must keep every entry (nil predicate)")
	}
}

// writeLargeManifest streams a manifest of n entries into dir under the
// snapshot's manifest key, without holding it in memory, and returns its size.
// Entry i lives under /data/dir-<i % dirs>/.
func writeLargeManifest(t *testing.T, baseDir, snapshotID string, n, dirs int) int64 {
	t.Helper()
	manifestPath := filepath.Join(baseDir, filepath.FromSlash(path.Join(snapshotRootDir, snapshotID, snapshotManifestKey)))
	if err := os.MkdirAll(filepath.Dir(manifestPath), 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	w := bufio.NewWriterSize(f, 1<<16)
	put := func(format string, args ...any) {
		if _, err := fmt.Fprintf(w, format, args...); err != nil {
			t.Fatal(err)
		}
	}
	checksum := strings.Repeat("0f", 32)
	put(`{"id":%q,"timestamp":"2026-01-02T03:04:05Z","formatVersion":2,"files":[`, snapshotID)
	for i := 0; i < n; i++ {
		if i > 0 {
			put(",")
		}
		put(`{"sourcePath":"/data/dir-%04d/file-%07d.bin","backupPath":"snapshots/%s/files/%07d.gz","size":%d,"modTime":"2026-01-02T03:04:05Z","checksum":%q,"mode":420}`,
			i%dirs, i, snapshotID, i, 1000+i, checksum)
	}
	put(`],"size":%d}`, n)
	if err := w.Flush(); err != nil {
		t.Fatal(err)
	}
	info, err := f.Stat()
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	return info.Size()
}

// liveHeapBytes forces a GC and returns the bytes it marked live
// (/gc/heap/live:bytes). Unlike MemStats.HeapAlloc read after runtime.GC, it
// excludes what other goroutines allocated after marking finished, which on
// a single P is several MB of the decoder's short-lived garbage.
func liveHeapBytes() uint64 {
	runtime.GC()
	sample := []metrics.Sample{{Name: "/gc/heap/live:bytes"}}
	metrics.Read(sample)
	if sample[0].Value.Kind() != metrics.KindUint64 {
		panic("runtime metric /gc/heap/live:bytes is not available")
	}
	return sample[0].Value.Uint64()
}

// peakLiveHeapGrowth runs fn while a sampler repeatedly forces a GC and reads
// the live heap, and returns the largest growth over the live heap measured
// just before fn started, plus how many samples were taken while fn ran.
func peakLiveHeapGrowth(fn func()) (peak uint64, samples int) {
	base := liveHeapBytes()

	done := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		ticker := time.NewTicker(500 * time.Microsecond)
		defer ticker.Stop()
		for {
			live := liveHeapBytes()
			samples++
			if live > base && live-base > peak {
				peak = live - base
			}
			select {
			case <-done:
				return
			case <-ticker.C:
			}
		}
	}()
	fn()
	close(done)
	wg.Wait()
	return peak, samples
}

// TestDownloadVerifiedManifestLargeManifestBoundedMemory is the #11234
// regression: restoring a selected folder from a large snapshot must not hold
// the encoded manifest, nor every decoded entry, in memory. The manifest is
// generated at run time (tens of MiB, never committed). The bound is half
// the manifest's size: reading the file whole keeps at least the whole file
// live, while streaming with the selection applied per entry keeps one entry
// plus the few that match.
func TestDownloadVerifiedManifestLargeManifestBoundedMemory(t *testing.T) {
	if testing.Short() {
		t.Skip("generates a large manifest")
	}
	const (
		entries = 100_000
		dirs    = 1_000
	)
	baseDir := t.TempDir()
	snapshotID := "big-manifest"
	size := writeLargeManifest(t, baseDir, snapshotID, entries, dirs)
	provider := providers.NewLocalProvider(baseDir)
	selected := []string{"/data/dir-0007"}
	// The sampler must run while the decode does. With one P (go test
	// -cpu 1, a single-vCPU runner) the decoding goroutine holds it and only
	// a couple of samples land, so give the sampler a P of its own.
	if runtime.GOMAXPROCS(0) < 2 {
		defer runtime.GOMAXPROCS(runtime.GOMAXPROCS(2))
	}

	var (
		snapshot *Snapshot
		dlErr    error
	)
	peak, samples := peakLiveHeapGrowth(func() {
		snapshot, _, dlErr = downloadVerifiedManifest(context.Background(), provider, snapshotID, t.TempDir(), nil, selected)
	})
	if dlErr != nil {
		t.Fatalf("downloadVerifiedManifest: %v", dlErr)
	}
	if samples < 3 {
		t.Fatalf("only %d heap samples were taken while the manifest decoded; the measurement proves nothing", samples)
	}
	if got, want := len(snapshot.Files), entries/dirs; got != want {
		t.Fatalf("kept %d entries for %v, want %d", got, selected, want)
	}
	for _, f := range snapshot.Files {
		if !strings.HasPrefix(f.SourcePath, "/data/dir-0007/") {
			t.Fatalf("kept unselected entry %q", f.SourcePath)
		}
	}
	if snapshot.ID != snapshotID || snapshot.FormatVersion != 2 || snapshot.Size != entries {
		t.Fatalf("manifest header fields lost: id=%q formatVersion=%d size=%d", snapshot.ID, snapshot.FormatVersion, snapshot.Size)
	}
	bound := uint64(size / 2)
	t.Logf("manifest %d bytes, %d entries; peak live heap growth %d bytes over %d samples (bound %d)", size, entries, peak, samples, bound)
	if peak >= bound {
		t.Fatalf("peak live heap grew by %d bytes decoding a %d-byte manifest for a %d-entry selection; want < %d (the manifest is being held in memory)",
			peak, size, len(snapshot.Files), bound)
	}
	runtime.KeepAlive(snapshot)
}
