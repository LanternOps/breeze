package tools

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type zipEntry struct {
	name string
	body string
	mode os.FileMode // zero → 0644 regular file
}

func buildZip(t *testing.T, entries []zipEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for _, e := range entries {
		h := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
		mode := e.mode
		if mode == 0 {
			mode = 0o644
		}
		h.SetMode(mode)
		f, err := w.CreateHeader(h)
		if err != nil {
			t.Fatalf("zip header %q: %v", e.name, err)
		}
		if _, err := f.Write([]byte(e.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func writeZip(t *testing.T, entries []zipEntry) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "pkg.zip")
	if err := os.WriteFile(p, buildZip(t, entries), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestExtractArchive_NestedEntryLandsUnderDest(t *testing.T) {
	zipPath := writeZip(t, []zipEntry{
		{name: "dist/"},
		{name: "dist/x/ctrld.exe", body: "binary"},
		{name: "README.md", body: "readme"},
	})
	dest := t.TempDir()
	if err := extractArchive(zipPath, dest); err != nil {
		t.Fatalf("extractArchive: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(dest, "dist", "x", "ctrld.exe"))
	if err != nil || string(got) != "binary" {
		t.Fatalf("nested entry = (%q, %v), want binary", got, err)
	}
	if got, _ := os.ReadFile(filepath.Join(dest, "README.md")); string(got) != "readme" {
		t.Fatalf("root entry = %q", got)
	}
}

// Every refusal leaves nothing outside destDir, and is an error rather than a
// silently skipped entry: a partially extracted package must not reach the
// post-install script.
func TestExtractArchive_RefusesUnsafeEntries(t *testing.T) {
	tests := []struct {
		name    string
		entries []zipEntry
	}{
		{"parent traversal", []zipEntry{{name: "../evil", body: "x"}}},
		{"nested traversal", []zipEntry{{name: "a/../../evil", body: "x"}}},
		{"backslash traversal", []zipEntry{{name: `..\evil`, body: "x"}}},
		{"backslash separator", []zipEntry{{name: `dir\file`, body: "x"}}},
		{"absolute unix", []zipEntry{{name: "/abs", body: "x"}}},
		{"absolute windows", []zipEntry{{name: `C:\x`, body: "x"}}},
		{"drive relative", []zipEntry{{name: "C:x", body: "x"}}},
		{"alternate data stream", []zipEntry{{name: "a:b", body: "x"}}},
		{"reserved CON", []zipEntry{{name: "CON", body: "x"}}},
		{"reserved NUL.txt", []zipEntry{{name: "NUL.txt", body: "x"}}},
		{"reserved nested com1", []zipEntry{{name: "dir/com1.log", body: "x"}}},
		{"reserved lpt9 lowercase", []zipEntry{{name: "lpt9", body: "x"}}},
		{"trailing dot aliases", []zipEntry{{name: "evil.", body: "x"}}},
		{"trailing space aliases", []zipEntry{{name: "evil ", body: "x"}}},
		{"dot component", []zipEntry{{name: "./a", body: "x"}}},
		{"empty component", []zipEntry{{name: "a//b", body: "x"}}},
		{"control character", []zipEntry{{name: "a\x01b", body: "x"}}},
		{"symlink", []zipEntry{{name: "link", body: "/etc/passwd", mode: os.ModeSymlink | 0o777}}},
		{"named pipe", []zipEntry{{name: "fifo", mode: os.ModeNamedPipe | 0o644}}},
		{"duplicate path", []zipEntry{{name: "a.txt", body: "first"}, {name: "a.txt", body: "second"}}},
		{"case-folded duplicate", []zipEntry{{name: "dist/A.txt", body: "first"}, {name: "dist/a.txt", body: "second"}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			dest := filepath.Join(root, "dest")
			if err := os.Mkdir(dest, 0o700); err != nil {
				t.Fatal(err)
			}
			zipPath := writeZip(t, tt.entries)
			if err := extractArchive(zipPath, dest); err == nil {
				t.Fatal("extractArchive accepted an unsafe archive")
			}
			for _, outside := range []string{"evil", "evil.", "abs", "x"} {
				if _, err := os.Lstat(filepath.Join(root, outside)); err == nil {
					t.Fatalf("%s was written outside destDir", outside)
				}
			}
		})
	}
}

func TestExtractArchive_DuplicateDoesNotOverwrite(t *testing.T) {
	zipPath := writeZip(t, []zipEntry{{name: "a.txt", body: "first"}, {name: "a.txt", body: "second"}})
	dest := t.TempDir()
	if err := extractArchive(zipPath, dest); err == nil {
		t.Fatal("duplicate entry accepted")
	}
	if got, err := os.ReadFile(filepath.Join(dest, "a.txt")); err == nil && string(got) != "first" {
		t.Fatalf("a.txt = %q: the duplicate overwrote the first entry", got)
	}
}

func TestExtractArchive_EntryCountCap(t *testing.T) {
	entries := make([]zipEntry, maxArchiveEntries+1)
	for i := range entries {
		entries[i] = zipEntry{name: fmt.Sprintf("f%04d", i), body: "x"}
	}
	if err := extractArchive(writeZip(t, entries), t.TempDir()); err == nil {
		t.Fatalf("%d entries accepted", len(entries))
	}

	entries = entries[:maxArchiveEntries]
	if err := extractArchive(writeZip(t, entries), t.TempDir()); err != nil {
		t.Fatalf("exactly %d entries refused: %v", maxArchiveEntries, err)
	}
}

// The cap counts bytes actually written across the whole archive, so a bomb
// spread over entries that are each under the cap still trips it.
func TestExtractArchive_UncompressedByteCap(t *testing.T) {
	orig := maxArchiveUncompressedBytes
	maxArchiveUncompressedBytes = 1000
	t.Cleanup(func() { maxArchiveUncompressedBytes = orig })

	bomb := writeZip(t, []zipEntry{
		{name: "a", body: strings.Repeat("0", 600)},
		{name: "b", body: strings.Repeat("0", 600)},
	})
	err := extractArchive(bomb, t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "uncompressed") {
		t.Fatalf("err = %v, want the uncompressed-size cap", err)
	}

	ok := writeZip(t, []zipEntry{{name: "a", body: strings.Repeat("0", 1000)}})
	if err := extractArchive(ok, t.TempDir()); err != nil {
		t.Fatalf("archive exactly at the cap refused: %v", err)
	}
}

func TestExtractArchive_MasksModes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permission bits")
	}
	zipPath := writeZip(t, []zipEntry{
		{name: "setuid-exec", body: "x", mode: os.ModeSetuid | os.ModeSetgid | 0o4777},
		{name: "sticky-exec", body: "x", mode: os.ModeSticky | 0o711},
		{name: "plain", body: "x", mode: 0o666},
		{name: "readonly", body: "x", mode: 0o400},
	})
	dest := t.TempDir()
	if err := extractArchive(zipPath, dest); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]os.FileMode{
		"setuid-exec": 0o755,
		"sticky-exec": 0o755,
		"plain":       0o644,
		"readonly":    0o644,
	} {
		info, err := os.Stat(filepath.Join(dest, name))
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode(); got != want {
			t.Errorf("%s mode = %v, want %v", name, got, want)
		}
	}
}

func TestExtractArchive_RefusesNonZip(t *testing.T) {
	p := filepath.Join(t.TempDir(), "pkg.zip")
	if err := os.WriteFile(p, []byte("not a zip"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := extractArchive(p, t.TempDir()); err == nil {
		t.Fatal("garbage accepted as a zip")
	}
}

func TestInstallerPlatforms_ZipRunsEverywhere(t *testing.T) {
	for _, goos := range []string{"windows", "darwin", "linux"} {
		if !installerSupportedOnPlatform("zip", goos) {
			t.Errorf("zip not supported on %s", goos)
		}
	}
	if installerSupportedOnPlatform("zip", "freebsd") || installerSupportedOnPlatform("ZIP", "linux") {
		t.Error("zip must match exactly and only on windows/darwin/linux")
	}
	if !isSupportedInstallFileType("zip") {
		t.Error("validateInstallInputs must accept zip")
	}
}

func zipInstallPayload() map[string]any {
	return map[string]any{
		"downloadUrl":  "https://downloads.example.com/pkg.zip",
		"fileName":     "pkg.zip",
		"fileType":     "zip",
		"softwareName": "Acme",
		"version":      "1.0.0",
	}
}

// An archive is only ever extracted for a post-install script to act on; with
// no post script it would "install" nothing, so it is refused before any
// download.
func TestInstallSoftwareZipRequiresPostInstallScript(t *testing.T) {
	for name, mutate := range map[string]func(map[string]any){
		"no scripts": func(map[string]any) {},
		"pre only": func(p map[string]any) {
			p["preInstallScript"] = map[string]any{"language": hostScriptLanguage(), "content": "echo hi", "timeoutSeconds": float64(600)}
		},
	} {
		t.Run(name, func(t *testing.T) {
			stubInstallPipeline(t,
				func(*http.Client, string, string) error {
					t.Fatal("download must not start for a zip without a post-install script")
					return errors.New("unreachable")
				},
				func(string, string, string, []uint32) (int, string, bool, error) {
					t.Fatal("installer must not run")
					return 0, "", false, nil
				},
			)
			p := zipInstallPayload()
			mutate(p)
			res := InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-1", RunScript: func(InstallScriptRequest) (*InstallScriptResult, error) {
				t.Fatal("no script may run")
				return nil, nil
			}})
			if res.Status != "failed" || !strings.Contains(res.Error, "archive_requires_post_install_script") {
				t.Fatalf("result = %+v, want archive_requires_post_install_script", res)
			}
		})
	}
}
