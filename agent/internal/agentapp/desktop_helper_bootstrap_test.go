package agentapp

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Issue #3457: `install-service` used to fall back to copying the AGENT binary
// to /usr/local/bin/breeze-desktop-helper when no real helper was staged
// alongside it. argv[0] dispatch made that run, but the installed helper then
// carried the agent's code-signing identifier and designated requirement, so
// macOS TCC grants made against it stopped matching the moment a real helper
// arrived. The staging path must resolve a genuine helper or fail — never
// substitute.

// agentBinaryBody is the stand-in for the running agent binary. Every failure
// case asserts these bytes never reach the helper's install path.
var agentBinaryBody = []byte("AGENT BINARY - must never be installed as the desktop helper")

func writeLargeBody(seed byte) []byte {
	body := make([]byte, 2*1024*1024) // above releaseAssetMinSize
	for i := range body {
		body[i] = byte(int(seed)+i) % 255
	}
	return body
}

type helperFixture struct {
	agentPath string
	destPath  string
	dir       string
}

func newHelperFixture(t *testing.T) helperFixture {
	t.Helper()
	dir := t.TempDir()
	stageDir := filepath.Join(dir, "stage")
	if err := os.MkdirAll(stageDir, 0o755); err != nil {
		t.Fatal(err)
	}
	agentPath := filepath.Join(stageDir, "breeze-agent")
	if err := os.WriteFile(agentPath, agentBinaryBody, 0o755); err != nil {
		t.Fatal(err)
	}
	return helperFixture{
		agentPath: agentPath,
		destPath:  filepath.Join(dir, "breeze-desktop-helper"),
		dir:       dir,
	}
}

// assertAgentBinaryNotInstalled is the regression assertion for #3457.
func (f helperFixture) assertAgentBinaryNotInstalled(t *testing.T) {
	t.Helper()
	got, err := os.ReadFile(f.destPath)
	if os.IsNotExist(err) {
		return
	}
	if err != nil {
		t.Fatalf("read %s: %v", f.destPath, err)
	}
	if string(got) == string(agentBinaryBody) {
		t.Fatalf("the agent binary was installed as the desktop helper at %s — that is exactly the #3457 code-identity bug", f.destPath)
	}
}

func TestStageDesktopHelper_PrefersSiblingBinary(t *testing.T) {
	f := newHelperFixture(t)
	helperBody := []byte("REAL DESKTOP HELPER BINARY")
	if err := os.WriteFile(filepath.Join(filepath.Dir(f.agentPath), desktopHelperBinaryName), helperBody, 0o755); err != nil {
		t.Fatal(err)
	}

	// urlOverride points at a dead address: a sibling hit must not touch the network.
	err := stageDesktopHelper(desktopHelperStageOptions{
		agentPath:        f.agentPath,
		destPath:         f.destPath,
		version:          "0.109.0",
		goos:             "darwin",
		goarch:           "arm64",
		urlOverride:      "http://127.0.0.1:1/never-called",
		checksumOverride: strings.Repeat("0", 64),
	})
	if err != nil {
		t.Fatalf("stageDesktopHelper: %v", err)
	}

	got, err := os.ReadFile(f.destPath)
	if err != nil {
		t.Fatalf("read installed helper: %v", err)
	}
	if string(got) != string(helperBody) {
		t.Fatalf("installed helper = %q, want the sibling helper binary", string(got))
	}
	f.assertAgentBinaryNotInstalled(t)

	info, err := os.Stat(f.destPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o111 == 0 {
		t.Fatalf("installed helper mode = %v, want it executable", info.Mode().Perm())
	}
}

func TestStageDesktopHelper_DownloadsWhenNoSibling(t *testing.T) {
	f := newHelperFixture(t)
	helperBody := writeLargeBody(7)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(helperBody)
	}))
	defer srv.Close()

	err := stageDesktopHelper(desktopHelperStageOptions{
		agentPath:        f.agentPath,
		destPath:         f.destPath,
		version:          "0.109.0",
		goos:             "darwin",
		goarch:           "arm64",
		urlOverride:      srv.URL,
		checksumOverride: testSHA256Hex(helperBody),
	})
	if err != nil {
		t.Fatalf("stageDesktopHelper: %v", err)
	}

	got, err := os.ReadFile(f.destPath)
	if err != nil {
		t.Fatalf("read installed helper: %v", err)
	}
	if len(got) != len(helperBody) {
		t.Fatalf("installed helper size = %d, want %d", len(got), len(helperBody))
	}
	f.assertAgentBinaryNotInstalled(t)
}

// The table of failure modes. Every one of them must (a) return an error and
// (b) leave the agent binary uninstalled at the helper path.
func TestStageDesktopHelper_NeverSubstitutesTheAgentBinary(t *testing.T) {
	tests := []struct {
		name        string
		version     string
		wantErrPart string
		// handler is the release-asset server; nil means "no server, use a
		// dead address".
		handler http.HandlerFunc
		// checksum overrides the checksum handed to the downloader.
		checksum func(body []byte) string
		// prepare optionally seeds the staging dir before the call.
		prepare func(t *testing.T, f helperFixture)
	}{
		{
			name:        "dev build with no sibling helper",
			version:     "dev",
			wantErrPart: "dev build",
		},
		{
			name:        "empty version is treated as a dev build",
			version:     "",
			wantErrPart: "dev build",
		},
		{
			name:        "release asset returns 404",
			version:     "0.109.0",
			wantErrPart: "download desktop helper",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusNotFound)
			},
		},
		{
			name:        "release asset is an error page, not a binary",
			version:     "0.109.0",
			wantErrPart: "download desktop helper",
			handler: func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte("<html>404 Not Found</html>"))
			},
		},
		{
			name:        "downloaded asset fails its checksum",
			version:     "0.109.0",
			wantErrPart: "download desktop helper",
			handler: func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write(writeLargeBody(3))
			},
			checksum: func([]byte) string { return testSHA256Hex([]byte("something else")) },
		},
		{
			name:        "sibling path exists but is a directory",
			version:     "0.109.0",
			wantErrPart: "read desktop helper",
			prepare: func(t *testing.T, f helperFixture) {
				t.Helper()
				if err := os.MkdirAll(filepath.Join(filepath.Dir(f.agentPath), desktopHelperBinaryName), 0o755); err != nil {
					t.Fatal(err)
				}
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := newHelperFixture(t)
			if tc.prepare != nil {
				tc.prepare(t, f)
			}

			url := "http://127.0.0.1:1/unreachable"
			if tc.handler != nil {
				srv := httptest.NewServer(tc.handler)
				defer srv.Close()
				url = srv.URL
			}
			checksum := testSHA256Hex([]byte("placeholder"))
			if tc.checksum != nil {
				checksum = tc.checksum(nil)
			}

			err := stageDesktopHelper(desktopHelperStageOptions{
				agentPath:        f.agentPath,
				destPath:         f.destPath,
				version:          tc.version,
				goos:             "darwin",
				goarch:           "arm64",
				urlOverride:      url,
				checksumOverride: checksum,
			})
			if err == nil {
				t.Fatal("stageDesktopHelper: expected an error, got nil")
			}
			if !strings.Contains(err.Error(), tc.wantErrPart) {
				t.Fatalf("error %q does not mention %q", err.Error(), tc.wantErrPart)
			}
			f.assertAgentBinaryNotInstalled(t)
		})
	}
}

// service_cmd_darwin.go is darwin-tagged, so the behavioural table above cannot
// reach it from a linux CI runner. Pin structurally that the install command
// delegates helper staging to stageDesktopHelper and never writes the helper's
// install path itself — writing it directly is how the agent-binary
// substitution got there in the first place.
func TestServiceInstallDarwin_DelegatesHelperStaging(t *testing.T) {
	source, err := os.ReadFile("service_cmd_darwin.go")
	if err != nil {
		t.Fatalf("read service_cmd_darwin.go: %v", err)
	}
	text := string(source)
	if !strings.Contains(text, "stageDesktopHelper(desktopHelperStageOptions{") {
		t.Fatal("service_cmd_darwin.go no longer stages the desktop helper via stageDesktopHelper")
	}
	if strings.Contains(text, "os.WriteFile(darwinDesktopHelperBinaryPath") {
		t.Fatal("service_cmd_darwin.go writes the desktop helper path directly — helper bytes must only ever come from stageDesktopHelper (#3457)")
	}
}

func TestDesktopHelperDownloadURL(t *testing.T) {
	tests := []struct {
		version, goos, goarch, want string
	}{
		{
			"0.109.0", "darwin", "arm64",
			"https://github.com/LanternOps/breeze/releases/download/v0.109.0/breeze-desktop-helper-darwin-arm64",
		},
		{
			"0.109.0", "darwin", "amd64",
			"https://github.com/LanternOps/breeze/releases/download/v0.109.0/breeze-desktop-helper-darwin-amd64",
		},
		{
			"0.109.0", "windows", "amd64",
			"https://github.com/LanternOps/breeze/releases/download/v0.109.0/breeze-desktop-helper-windows-amd64.exe",
		},
	}
	for _, tc := range tests {
		if got := desktopHelperDownloadURL(tc.version, tc.goos, tc.goarch); got != tc.want {
			t.Errorf("desktopHelperDownloadURL(%q,%q,%q) = %q, want %q",
				tc.version, tc.goos, tc.goarch, got, tc.want)
		}
	}
}

func TestIsDevBuildVersion(t *testing.T) {
	tests := []struct {
		version string
		want    bool
	}{
		{"", true},
		{"dev", true},
		{"dev-abc123", true},
		{"0.109.0", false},
		{"0.109.0-rc.1", false},
	}
	for _, tc := range tests {
		if got := isDevBuildVersion(tc.version); got != tc.want {
			t.Errorf("isDevBuildVersion(%q) = %v, want %v", tc.version, got, tc.want)
		}
	}
}

func TestDesktopHelperUnavailableWarning_IsActionable(t *testing.T) {
	msg := desktopHelperUnavailableWarning(os.ErrNotExist, "0.109.0", "darwin", "arm64")
	for _, want := range []string{
		"desktop helper not installed",
		"agent service is installed",
		"does NOT substitute the agent binary",
		"breeze-desktop-helper-darwin-arm64",
		"service install",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("warning does not mention %q:\n%s", want, msg)
		}
	}
}
