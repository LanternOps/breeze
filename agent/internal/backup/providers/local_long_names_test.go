package providers

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
	"unicode/utf8"
)

// #12799: the local store wrote each object through a temporary file named
// "." + leaf + ".upload-" + 26 random characters, 35 bytes longer than the
// object's own name. A key leaf the store accepts (up to 255 bytes, see
// maxObjectKeySegmentBytes in internal/backup/objectkey_length.go) but longer
// than 220 bytes therefore failed on every run, on any filesystem that caps a
// name at 255 bytes or 255 UTF-16 units.
//
// These tests are named TestLocalStore* so the Windows CI job, which runs
// `go test ./internal/backup/providers -run '^TestLocalStore'`, runs them on
// NTFS too.

// longKeyLeaves are object key leaves at the boundaries: the last length the
// old temporary name fitted (220), the first it did not (221), one in between,
// the longest a store accepts (255), and multi-byte UTF-8 leaves whose byte
// length is 255 while their character count is far lower.
func longKeyLeaves() map[string]string {
	ascii := func(n int) string { return strings.Repeat("m", n-len(".gz")) + ".gz" }
	return map[string]string{
		"ascii-220":  ascii(220),
		"ascii-221":  ascii(221),
		"ascii-240":  ascii(240),
		"ascii-255":  ascii(255),
		"latin-255B": strings.Repeat("é", 126) + ".gz", // 129 characters, 255 bytes
		"cjk-255B":   strings.Repeat("日", 84) + ".gz",  // 87 characters, 255 bytes
		"emoji-255B": strings.Repeat("😀", 63) + ".gz",  // 66 characters, 255 bytes
		"raw-255":    strings.Repeat("r", 255),         // an uncompressed key
	}
}

func TestLocalStoreLongKeyLeavesFixture(t *testing.T) {
	want := map[string]int{"ascii-220": 220, "ascii-221": 221, "ascii-240": 240}
	for label, leaf := range longKeyLeaves() {
		n, ok := want[label]
		if !ok {
			n = 255
		}
		if len(leaf) != n {
			t.Errorf("%s: %d bytes, want %d", label, len(leaf), n)
		}
		if !strings.HasPrefix(label, "ascii") && !strings.HasPrefix(label, "raw") && utf8.RuneCountInString(leaf) >= len(leaf) {
			t.Errorf("%s: want a leaf whose bytes exceed its characters", label)
		}
	}
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// A leaf of any length the store accepts writes, lists, sizes and reads back
// byte-identical, and the digest the upload reports is the source's.
func TestLocalStoreLongKeyLeavesRoundTrip(t *testing.T) {
	base := privateStoreTempDir(t)
	p := NewLocalProvider(base)
	srcDir := t.TempDir()
	for label, leaf := range longKeyLeaves() {
		t.Run(label, func(t *testing.T) {
			content := []byte("content of " + label + "\n" + strings.Repeat("x", 4096))
			src := filepath.Join(srcDir, label)
			if err := os.WriteFile(src, content, 0o600); err != nil {
				t.Fatal(err)
			}
			key := "snapshots/s1/files/" + label + "/" + leaf
			digest, err := p.UploadWithDigest(context.Background(), src, key)
			if err != nil {
				t.Fatalf("upload of a %d-byte leaf: %v", len(leaf), err)
			}
			if digest.SHA256 != sha256Hex(content) || digest.Size != int64(len(content)) {
				t.Fatalf("digest = %+v, want sha256 %s size %d", digest, sha256Hex(content), len(content))
			}
			listed, err := p.List("snapshots/s1/files/" + label)
			if err != nil {
				t.Fatalf("List: %v", err)
			}
			if !slices.Equal(listed, []string{key}) {
				t.Fatalf("List = %q, want exactly the object (no temporary file)", listed)
			}
			sizes, err := p.ObjectSizes("snapshots/s1/files/" + label)
			if err != nil {
				t.Fatalf("ObjectSizes: %v", err)
			}
			if _, ok := sizes[key]; !ok || len(sizes) != 1 {
				t.Fatalf("ObjectSizes = %v, want exactly the object", sizes)
			}
			dst := filepath.Join(t.TempDir(), "restored")
			if err := p.Download(key, dst); err != nil {
				t.Fatalf("Download: %v", err)
			}
			got, err := os.ReadFile(dst)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, content) {
				t.Fatalf("restored %d bytes, want the %d source bytes", len(got), len(content))
			}
		})
	}
}

// The temporary name is fixed-length, independent of the key, and sits in
// the object's own directory, so the rename into place stays on one volume.
func TestLocalStoreUploadTempNameIsFixedLengthBesideTheObject(t *testing.T) {
	base := privateStoreTempDir(t)
	p := NewLocalProvider(base)
	src := filepath.Join(t.TempDir(), "src")
	if err := os.WriteFile(src, []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var froms []string
	defer setLocalRenameForTest(func(tree *os.Root, from, to string) error {
		mu.Lock()
		froms = append(froms, from)
		mu.Unlock()
		if filepath.Dir(from) != filepath.Dir(to) {
			return fmt.Errorf("temporary file %q is not in the object's directory %q", from, filepath.Dir(to))
		}
		return tree.Rename(from, to)
	})()

	for _, leaf := range []string{"a.gz", strings.Repeat("n", 252) + ".gz"} {
		key := "snapshots/s1/files/d/" + leaf
		if _, err := p.UploadWithDigest(context.Background(), src, key); err != nil {
			t.Fatalf("upload %d-byte leaf: %v", len(leaf), err)
		}
	}
	if len(froms) != 2 {
		t.Fatalf("saw %d renames, want 2", len(froms))
	}
	for _, from := range froms {
		name := filepath.Base(from)
		if len(name) != localUploadTempNameLen {
			t.Errorf("temporary name %q is %d bytes, want the fixed %d", name, len(name), localUploadTempNameLen)
		}
		if !isLocalUploadTempName(name) {
			t.Errorf("temporary name %q is not recognised as one by the sweep", name)
		}
	}
	if froms[0] == froms[1] {
		t.Error("two uploads used the same temporary name")
	}
}

// Writers of different objects in one directory never collide, and none
// leaves a temporary file behind.
func TestLocalStoreConcurrentUploadsInOneDirectory(t *testing.T) {
	base := privateStoreTempDir(t)
	p := NewLocalProvider(base)
	srcDir := t.TempDir()
	const writers = 24
	keys := make([]string, writers)
	contents := make([][]byte, writers)
	for i := range writers {
		// Long leaves that differ only near the end, the shape that made the
		// old temporary names longest.
		leaf := strings.Repeat("c", 240) + fmt.Sprintf("%04d", i) + ".gz"
		if i%2 == 0 {
			leaf = fmt.Sprintf("short-%d.gz", i)
		}
		keys[i] = "snapshots/s1/files/shared/" + leaf
		contents[i] = []byte(strings.Repeat(fmt.Sprintf("writer %d ", i), 2000))
		if err := os.WriteFile(filepath.Join(srcDir, fmt.Sprint(i)), contents[i], 0o600); err != nil {
			t.Fatal(err)
		}
	}
	var wg sync.WaitGroup
	errs := make([]error, writers)
	for i := range writers {
		wg.Go(func() {
			_, errs[i] = p.UploadWithDigest(context.Background(), filepath.Join(srcDir, fmt.Sprint(i)), keys[i])
		})
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("writer %d (%d-byte leaf): %v", i, len(path.Base(keys[i])), err)
		}
	}
	listed, err := p.List("snapshots/s1/files/shared")
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(listed)
	want := slices.Clone(keys)
	slices.Sort(want)
	if !slices.Equal(listed, want) {
		t.Fatalf("List has %d entries, want exactly the %d objects: %q", len(listed), len(want), listed)
	}
	for i, key := range keys {
		dst := filepath.Join(t.TempDir(), "out")
		if err := p.Download(key, dst); err != nil {
			t.Fatalf("Download %d: %v", i, err)
		}
		got, _ := os.ReadFile(dst)
		if !bytes.Equal(got, contents[i]) {
			t.Fatalf("object %d holds another writer's bytes", i)
		}
	}
}

// Leftovers of both temporary-name schemes are swept: the new fixed-length
// name and the old "." + leaf + ".upload-" + suffix name that earlier agents
// wrote (a decimal suffix from os.CreateTemp, later a 26-character
// rand.Text()). A recent temporary file (an upload still in progress) and
// any real object, including ones whose names resemble either scheme, are
// kept.
func TestLocalStoreSweepRemovesOldAndNewTempLeftovers(t *testing.T) {
	base := privateStoreTempDir(t)
	p := NewLocalProvider(base)
	src := filepath.Join(t.TempDir(), "src")
	if err := os.WriteFile(src, []byte("object"), 0o600); err != nil {
		t.Fatal(err)
	}
	dirKey := "snapshots/s1/files/d"
	upload := func(leaf string) string {
		key := dirKey + "/" + leaf
		if _, err := p.UploadWithDigest(context.Background(), src, key); err != nil {
			t.Fatalf("upload %q: %v", leaf, err)
		}
		return key
	}
	age := func(key string, d time.Duration) {
		old := time.Now().Add(-d)
		if err := os.Chtimes(filepath.Join(base, filepath.FromSlash(key)), old, old); err != nil {
			t.Fatal(err)
		}
	}
	leftover := func(name string, d time.Duration) string {
		key := dirKey + "/" + name
		if err := os.WriteFile(filepath.Join(base, filepath.FromSlash(key)), []byte("partial"), 0o600); err != nil {
			t.Fatal(err)
		}
		age(key, d)
		return key
	}

	// Real objects, all older than the cutoff. Names a user could give a
	// file: a file's key adds ".gz", which neither temporary scheme ends in.
	objects := []string{
		upload("a.txt.gz"),
		upload(".x.upload-notes.txt.gz"),
		upload(".y.upload-ABCDEFGHIJKLMNOPQRSTUVWXYZ.gz"),
		upload(".breeze-upload-ABCDEFGHIJKLMNOPQRSTUVWXYZ.gz"),
		upload(".breeze-upload-short"),
		upload("breeze-upload-ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
		upload(".z.upload-"),
	}
	for _, key := range objects {
		age(key, 48*time.Hour)
	}

	stale := []string{
		leftover(".breeze-upload-ABCDEFGHIJKLMNOPQRSTUVW234", 48*time.Hour),          // new scheme
		leftover(".a.txt.gz.upload-QRSTUVWXYZ234567ABCDEFGHIJ", 48*time.Hour),        // old, rand.Text()
		leftover("."+strings.Repeat("m", 200)+".gz.upload-2907451123", 48*time.Hour), // old, os.CreateTemp
	}
	fresh := []string{
		leftover(".breeze-upload-ZZZZZZZZZZZZZZZZZZZZZZZZZZ", time.Minute),
		leftover(".b.txt.gz.upload-ZZZZZZZZZZZZZZZZZZZZZZZZZZ", time.Minute),
	}

	// A directory whose name has a temporary form is not a leftover.
	tempNamedDir := dirKey + "/.breeze-upload-DDDDDDDDDDDDDDDDDDDDDDDDDD"
	upload(".breeze-upload-DDDDDDDDDDDDDDDDDDDDDDDDDD/inside.gz")
	age(tempNamedDir, 48*time.Hour)

	n, err := p.SweepStaleUploads("snapshots/s1", 24*time.Hour)
	if err != nil {
		t.Fatalf("SweepStaleUploads: %v", err)
	}
	if n != len(stale) {
		t.Errorf("removed %d files, want %d", n, len(stale))
	}
	listed, err := p.List(dirKey)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range stale {
		if slices.Contains(listed, key) {
			t.Errorf("stale leftover %q was not removed", path.Base(key))
		}
	}
	if !slices.Contains(listed, tempNamedDir+"/inside.gz") {
		t.Error("an object under a directory with a temporary-form name must be kept")
	}
	for _, key := range append(slices.Clone(objects), fresh...) {
		if !slices.Contains(listed, key) {
			t.Errorf("%q must be kept", path.Base(key))
		}
	}
}

// A failed write says which object it was writing and the operating
// system's reason, not just that it failed.
func TestLocalStoreUploadFailureNamesTheObjectAndTheReason(t *testing.T) {
	base := privateStoreTempDir(t)
	p := NewLocalProvider(base)
	src := filepath.Join(t.TempDir(), "src")
	if err := os.WriteFile(src, []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Run("leaf the filesystem refuses", func(t *testing.T) {
		// 256 bytes: over every filesystem's name limit, so the OS refuses it.
		key := "snapshots/s1/files/d/" + strings.Repeat("o", 253) + ".gz"
		_, err := p.UploadWithDigest(context.Background(), src, key)
		if err == nil {
			t.Fatal("a 256-byte name must be refused by the filesystem")
		}
		msg := err.Error()
		if !strings.Contains(msg, key) {
			t.Errorf("error does not name the object %q: %s", key, msg)
		}
		var pathErr *fs.PathError
		var linkErr *os.LinkError
		var osReason error
		switch {
		case errors.As(err, &linkErr):
			osReason = linkErr.Err
		case errors.As(err, &pathErr):
			osReason = pathErr.Err
		default:
			t.Fatalf("error carries no operating-system error: %v", err)
		}
		if !strings.HasSuffix(msg, ": "+osReason.Error()) {
			t.Errorf("error does not end with the OS reason %q: %s", osReason, msg)
		}
		assertNoTempLeftover(t, p, "snapshots/s1/files/d")
	})

	t.Run("rename into place fails", func(t *testing.T) {
		defer setLocalRenameForTest(func(*os.Root, string, string) error {
			return &os.LinkError{Op: "rename", Old: "from", New: "to", Err: syscall.EACCES}
		})()
		key := "snapshots/s1/files/e/" + strings.Repeat("p", 240) + ".gz"
		_, err := p.UploadWithDigest(context.Background(), src, key)
		if err == nil {
			t.Fatal("injected rename failure was not reported")
		}
		if !strings.Contains(err.Error(), key) || !errors.Is(err, syscall.EACCES) ||
			!strings.HasSuffix(err.Error(), syscall.EACCES.Error()) {
			t.Errorf("error must name %q and carry the OS reason: %v", key, err)
		}
		assertNoTempLeftover(t, p, "snapshots/s1/files/e")
	})
}

func assertNoTempLeftover(t *testing.T, p *LocalProvider, prefix string) {
	t.Helper()
	listed, err := p.List(prefix)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 0 {
		t.Errorf("a failed upload left %q behind", listed)
	}
}

// The gzip header can only carry a Latin-1 name, and the local store used to
// put the source file's name there unconditionally: a file named in any
// other script (CJK, Cyrillic, Greek, emoji), however short, failed with
// "gzip.Write: non-Latin-1 header string" on every run. The header name is
// informational only; restore takes the name from the manifest.
func TestLocalStoreUploadsNonLatin1FileNames(t *testing.T) {
	base := privateStoreTempDir(t)
	p := NewLocalProvider(base)
	srcDir := t.TempDir()
	for _, name := range []string{"日本語.txt", "Привет.docx", "Ωmega.txt", "😀.png", "café.txt"} {
		t.Run(name, func(t *testing.T) {
			content := []byte("bytes of " + name)
			src := filepath.Join(srcDir, name)
			if err := os.WriteFile(src, content, 0o600); err != nil {
				t.Fatal(err)
			}
			key := "snapshots/s1/files/u/" + name + ".gz"
			if _, err := p.UploadWithDigest(context.Background(), src, key); err != nil {
				t.Fatalf("upload: %v", err)
			}
			dst := filepath.Join(t.TempDir(), "out")
			if err := p.Download(key, dst); err != nil {
				t.Fatalf("Download: %v", err)
			}
			got, _ := os.ReadFile(dst)
			if !bytes.Equal(got, content) {
				t.Fatalf("restored %q, want %q", got, content)
			}
		})
	}
}

// The temporary-name match is exact: every shape UploadWithDigest of this or
// an earlier agent wrote, and nothing else.
func TestLocalStoreTempNameMatchIsExact(t *testing.T) {
	b26 := "ABCDEFGHIJKLMNOPQRSTUVWX27"
	cases := map[string]bool{
		".breeze-upload-" + b26:                     true,
		".a.txt.gz.upload-" + b26:                   true, // rand.Text() era
		".a.txt.gz.upload-1":                        true, // os.CreateTemp era
		".a.txt.gz.upload-4294967295":               true, // largest uint32
		".a.upload-b.gz.upload-" + b26:              true, // last marker counts
		".breeze-upload-" + b26[:25]:                false,
		".breeze-upload-" + b26 + "A":               false,
		".breeze-upload-" + strings.ToLower(b26):    false,
		".breeze-upload-ABCDEFGHIJKLMNOPQRSTUVWX01": false, // 0, 1 are not base32
		".breeze-upload-ABCDEFGHIJKLMNOPQRSTUVWX89": false,
		".breeze-upload-":                           false,
		".breeze-upload-" + b26 + ".gz":             false,
		"breeze-upload-" + b26:                      false,
		".a.txt.gz.upload-12345678901":              false, // 11 digits
		".a.txt.gz.upload-":                         false,
		".a.txt.gz.upload-12a":                      false,
		".a.txt.gz.upload-" + b26[:25]:              false,
		".a.txt.gz.upload-" + b26 + ".gz":           false,
		".upload-123":                               false, // no leaf
		"a.txt.gz.upload-123":                       false, // no leading dot
		".x.upload-notes.txt.gz":                    false,
		"manifest.json":                             false,
	}
	for name, want := range cases {
		if got := isLocalUploadTempName(name); got != want {
			t.Errorf("isLocalUploadTempName(%q) = %v, want %v", name, got, want)
		}
	}
	for range 100 {
		name, err := newLocalUploadTempName()
		if err != nil {
			t.Fatal(err)
		}
		if len(name) != localUploadTempNameLen || !isLocalUploadTempName(name) {
			t.Fatalf("generated temporary name %q (%d bytes) does not have the fixed form", name, len(name))
		}
	}
}

// The gzip header keeps a Latin-1 name and drops any other, and the stored
// object carries it.
func TestLocalStoreGzipHeaderName(t *testing.T) {
	cases := map[string]string{
		"café.txt":    "café.txt",
		"plain.txt":   "plain.txt",
		"日本語.txt":     "",
		"😀.png":       "",
		"bad\xff.txt": "", // invalid UTF-8 (a raw byte some filesystems allow)
	}
	for in, want := range cases {
		if got := gzipHeaderName(in); got != want {
			t.Errorf("gzipHeaderName(%q) = %q, want %q", in, got, want)
		}
	}

	base := privateStoreTempDir(t)
	p := NewLocalProvider(base)
	src := filepath.Join(t.TempDir(), "café.txt")
	if err := os.WriteFile(src, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	key := "snapshots/s1/files/g/café.txt.gz"
	if _, err := p.UploadWithDigest(context.Background(), src, key); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(filepath.Join(base, filepath.FromSlash(key)))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	zr, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	if zr.Name != "café.txt" {
		t.Errorf("stored gzip header name = %q, want %q", zr.Name, "café.txt")
	}
}
