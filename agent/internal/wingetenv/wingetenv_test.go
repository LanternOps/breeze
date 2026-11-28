package wingetenv

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

const (
	winAppsRoot  = `C:\Program Files\WindowsApps`
	wingetX64    = winAppsRoot + `\Microsoft.DesktopAppInstaller_1.29.380.0_x64__8wekyb3d8bbwe\winget.exe`
	wingetArm64  = winAppsRoot + `\Microsoft.DesktopAppInstaller_1.29.380.0_arm64__8wekyb3d8bbwe\winget.exe`
	vclibsPrefix = winAppsRoot + `\Microsoft.VCLibs.140.00.UWPDesktop_`
)

// fakeGlob returns dirs for the VCLibs pattern and records the patterns asked.
func fakeGlob(dirs []string, patterns *[]string) func(string) ([]string, error) {
	return func(p string) ([]string, error) {
		if patterns != nil {
			*patterns = append(*patterns, p)
		}
		return dirs, nil
	}
}

func TestParseAppInstallerDir(t *testing.T) {
	cases := []struct {
		dir, ver, arch string
		ok             bool
	}{
		{`Microsoft.DesktopAppInstaller_1.22.10661.0_x64__8wekyb3d8bbwe`, "1.22.10661.0", "x64", true},
		{`Microsoft.DesktopAppInstaller_1.22.10661.0_arm64__8wekyb3d8bbwe`, "1.22.10661.0", "arm64", true},
		{`Microsoft.DesktopAppInstaller_1.22.10661.0_neutral_split.language-en__8wekyb3d8bbwe`, "", "", false},
		{`Microsoft.DesktopAppInstaller_1.22.10661.0_x86__8wekyb3d8bbwe`, "", "", false},
		{`garbage`, "", "", false},
	}
	for _, c := range cases {
		ver, arch, ok := ParseAppInstallerDir(c.dir)
		if ver != c.ver || arch != c.arch || ok != c.ok {
			t.Errorf("ParseAppInstallerDir(%q) = %q,%q,%v want %q,%q,%v", c.dir, ver, arch, ok, c.ver, c.arch, c.ok)
		}
	}
}

func TestCompareVersionsIsNumeric(t *testing.T) {
	if CompareVersions("14.0.33728.0", "14.0.9999.0") != 1 {
		t.Fatal("14.0.33728.0 must be greater than 14.0.9999.0 (numeric, not lexical)")
	}
	if CompareVersions("1.5.0.0", "1.16.0.0") != -1 {
		t.Fatal("1.5 < 1.16 numerically")
	}
	if CompareVersions("1.16.0.0", "1.16.0.0") != 0 {
		t.Fatal("equal versions")
	}
}

func TestVCLibsDirPicksHighestNumericVersionOfMatchingArch(t *testing.T) {
	var patterns []string
	dirs := []string{
		vclibsPrefix + `14.0.9999.0_x64__8wekyb3d8bbwe`,
		vclibsPrefix + `14.0.33728.0_x64__8wekyb3d8bbwe`,
		vclibsPrefix + `14.0.40000.0_x86__8wekyb3d8bbwe`,   // wrong arch
		vclibsPrefix + `14.0.50000.0_arm64__8wekyb3d8bbwe`, // wrong arch
		vclibsPrefix + `14.0.60000.0_neutral_split.scale-100__8wekyb3d8bbwe`,
		vclibsPrefix + `14.0.60000.0_neutral__8wekyb3d8bbwe`,
		winAppsRoot + `\Microsoft.VCLibs.140.00_14.0.70000.0_x64__8wekyb3d8bbwe`, // non-UWPDesktop VCLibs
	}
	got, ok := VCLibsDir(wingetX64, fakeGlob(dirs, &patterns))
	want := vclibsPrefix + `14.0.33728.0_x64__8wekyb3d8bbwe`
	if !ok || got != want {
		t.Fatalf("VCLibsDir = %q,%v want %q,true", got, ok, want)
	}
	wantPattern := winAppsRoot + `\Microsoft.VCLibs.140.00.UWPDesktop_*__8wekyb3d8bbwe`
	if len(patterns) != 1 || patterns[0] != wantPattern {
		t.Fatalf("glob patterns = %q, want [%q]", patterns, wantPattern)
	}
}

func TestVCLibsDirMatchesArm64Winget(t *testing.T) {
	dirs := []string{
		vclibsPrefix + `14.0.33728.0_x64__8wekyb3d8bbwe`,
		vclibsPrefix + `14.0.33519.0_arm64__8wekyb3d8bbwe`,
	}
	got, ok := VCLibsDir(wingetArm64, fakeGlob(dirs, nil))
	want := vclibsPrefix + `14.0.33519.0_arm64__8wekyb3d8bbwe`
	if !ok || got != want {
		t.Fatalf("VCLibsDir = %q,%v want %q,true", got, ok, want)
	}
}

func TestVCLibsDirNoneOfMatchingArch(t *testing.T) {
	dirs := []string{vclibsPrefix + `14.0.33728.0_x86__8wekyb3d8bbwe`}
	if got, ok := VCLibsDir(wingetX64, fakeGlob(dirs, nil)); ok || got != "" {
		t.Fatalf("VCLibsDir = %q,%v want no match", got, ok)
	}
	if got, ok := VCLibsDir(wingetX64, fakeGlob(nil, nil)); ok || got != "" {
		t.Fatalf("VCLibsDir with nothing installed = %q,%v want no match", got, ok)
	}
	errGlob := func(string) ([]string, error) { return nil, filepath.ErrBadPattern }
	if got, ok := VCLibsDir(wingetX64, errGlob); ok || got != "" {
		t.Fatalf("VCLibsDir on glob error = %q,%v want no match", got, ok)
	}
}

// Only the full-path SYSTEM invocation needs the framework on PATH: the
// per-user execution alias (and a bare "winget") runs with package identity.
// Those must not trigger a WindowsApps listing at all.
func TestVCLibsDirIgnoresNonAppInstallerWinget(t *testing.T) {
	for _, p := range []string{
		"winget",
		`C:\Users\bob\AppData\Local\Microsoft\WindowsApps\winget.exe`,
		winAppsRoot + `\Microsoft.DesktopAppInstaller_1.29.380.0_x64__8wekyb3d8bbwe\AppInstallerCLI.exe`,
		winAppsRoot + `\Microsoft.DesktopAppInstaller_1.29.380.0_neutral_split.language-en__8wekyb3d8bbwe\winget.exe`,
		`C:\Windows\System32\cmd.exe`,
	} {
		var patterns []string
		if got, ok := VCLibsDir(p, fakeGlob([]string{vclibsPrefix + `14.0.33728.0_x64__8wekyb3d8bbwe`}, &patterns)); ok || got != "" {
			t.Errorf("VCLibsDir(%q) = %q,%v want no match", p, got, ok)
		}
		if len(patterns) != 0 {
			t.Errorf("VCLibsDir(%q) globbed %q; must not touch the filesystem", p, patterns)
		}
	}
}

func TestVCLibsDirWingetExeCaseInsensitive(t *testing.T) {
	p := winAppsRoot + `\Microsoft.DesktopAppInstaller_1.29.380.0_x64__8wekyb3d8bbwe\WinGet.EXE`
	if _, ok := VCLibsDir(p, fakeGlob([]string{vclibsPrefix + `14.0.33728.0_x64__8wekyb3d8bbwe`}, nil)); !ok {
		t.Fatal("winget.exe file name must match case-insensitively (Windows paths)")
	}
}

func TestChildEnvPrependsAndKeepsExistingPath(t *testing.T) {
	dir := vclibsPrefix + `14.0.33728.0_x64__8wekyb3d8bbwe`
	in := []string{`SystemRoot=C:\Windows`, `PATH=C:\Windows\system32;C:\Windows`, `TEMP=C:\Windows\Temp`}
	orig := append([]string(nil), in...)
	got := ChildEnv(in, dir, true, ";")
	want := []string{`SystemRoot=C:\Windows`, `PATH=` + dir + `;C:\Windows\system32;C:\Windows`, `TEMP=C:\Windows\Temp`}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ChildEnv = %q\nwant %q", got, want)
	}
	if !reflect.DeepEqual(in, orig) {
		t.Fatalf("ChildEnv mutated its input: %q", in)
	}
}

func TestChildEnvPathKeyCaseInsensitiveOnWindows(t *testing.T) {
	dir := `D:\vclibs`
	got := ChildEnv([]string{`Path=C:\Windows\system32`}, dir, true, ";")
	want := []string{`Path=D:\vclibs;C:\Windows\system32`}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ChildEnv = %q want %q", got, want)
	}
	// Case-sensitive hosts treat "Path" as a different variable.
	got = ChildEnv([]string{`Path=/x`}, "/v", false, ":")
	want = []string{`Path=/x`, `PATH=/v`}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("case-sensitive ChildEnv = %q want %q", got, want)
	}
}

func TestChildEnvAddsPathWhenMissingOrEmpty(t *testing.T) {
	if got := ChildEnv([]string{`A=1`}, `D:\v`, true, ";"); !reflect.DeepEqual(got, []string{`A=1`, `PATH=D:\v`}) {
		t.Fatalf("missing PATH: %q", got)
	}
	if got := ChildEnv([]string{`PATH=`}, `D:\v`, true, ";"); !reflect.DeepEqual(got, []string{`PATH=D:\v`}) {
		t.Fatalf("empty PATH: %q", got)
	}
}

func TestChildEnvIsIdempotent(t *testing.T) {
	in := []string{`PATH=D:\v;C:\Windows`}
	if got := ChildEnv(in, `d:\V`, true, ";"); !reflect.DeepEqual(got, in) {
		t.Fatalf("already-first dir re-prepended: %q", got)
	}
}

// os/exec on Windows keeps the LAST of duplicate (case-insensitive) keys, so
// that is the entry that must carry the framework dir.
func TestChildEnvEditsLastDuplicateKey(t *testing.T) {
	got := ChildEnv([]string{`PATH=C:\a`, `Path=C:\b`}, `D:\v`, true, ";")
	want := []string{`PATH=C:\a`, `Path=D:\v;C:\b`}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ChildEnv = %q want %q", got, want)
	}
}

// makeWindowsApps lays out a real WindowsApps-shaped tree so Apply can be
// exercised end to end (real glob, real os.Environ) on any host.
func makeWindowsApps(t *testing.T, vclibs ...string) (wingetPath string, dirs []string) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "WindowsApps")
	appDir := filepath.Join(root, "Microsoft.DesktopAppInstaller_1.29.380.0_x64__8wekyb3d8bbwe")
	if err := os.MkdirAll(appDir, 0o755); err != nil {
		t.Fatal(err)
	}
	wingetPath = filepath.Join(appDir, "winget.exe")
	if err := os.WriteFile(wingetPath, nil, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, v := range vclibs {
		d := filepath.Join(root, "Microsoft.VCLibs.140.00.UWPDesktop_"+v+"__8wekyb3d8bbwe")
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
		dirs = append(dirs, d)
	}
	return wingetPath, dirs
}

func envPath(env []string) string {
	for _, kv := range slices.Backward(env) {
		if k, v, ok := strings.Cut(kv, "="); ok && strings.EqualFold(k, "PATH") {
			return v
		}
	}
	return ""
}

func TestApplySetsChildPathOnly(t *testing.T) {
	wingetPath, dirs := makeWindowsApps(t, "14.0.9999.0_x64", "14.0.33728.0_x64", "14.0.40000.0_x86")
	t.Setenv("PATH", "/usr/bin")
	before := os.Getenv("PATH")

	cmd := Apply(exec.Command(wingetPath, "--version"))
	sep := string(os.PathListSeparator)
	if got, want := envPath(cmd.Env), dirs[1]+sep+"/usr/bin"; got != want {
		t.Fatalf("child PATH = %q want %q", got, want)
	}
	if os.Getenv("PATH") != before {
		t.Fatal("Apply must never mutate the agent's own environment")
	}
	// Idempotent: a second Apply (procspawn.Prepare may run twice) adds nothing.
	again := envPath(Apply(cmd).Env)
	if again != dirs[1]+sep+"/usr/bin" {
		t.Fatalf("second Apply changed PATH to %q", again)
	}
}

func TestApplyNoOpWhenFrameworkAbsent(t *testing.T) {
	wingetPath, _ := makeWindowsApps(t)
	if cmd := Apply(exec.Command(wingetPath)); cmd.Env != nil {
		t.Fatalf("Env set with no VCLibs installed: %q", cmd.Env)
	}
}

func TestApplyIgnoresOtherCommands(t *testing.T) {
	if cmd := Apply(exec.Command("echo", "hi")); cmd.Env != nil {
		t.Fatalf("non-winget command got Env %q", cmd.Env)
	}
	if Apply(nil) != nil {
		t.Fatal("Apply(nil) must be nil")
	}
}

func TestApplyKeepsCallerEnv(t *testing.T) {
	wingetPath, dirs := makeWindowsApps(t, "14.0.33728.0_x64")
	cmd := exec.Command(wingetPath)
	cmd.Env = []string{"FOO=bar", "PATH=/opt/bin"}
	Apply(cmd)
	sep := string(os.PathListSeparator)
	if !reflect.DeepEqual(cmd.Env, []string{"FOO=bar", "PATH=" + dirs[0] + sep + "/opt/bin"}) {
		t.Fatalf("Env = %q", cmd.Env)
	}
}
