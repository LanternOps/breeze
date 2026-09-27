package tools

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// splitUninstallCommandLine — the registered string is untrusted input.
// ---------------------------------------------------------------------------

func TestSplitUninstallCommandLine(t *testing.T) {
	tests := []struct {
		name     string
		in       string
		wantExe  string
		wantRest string
		wantErr  string
	}{
		{
			name:     "quoted exe with args (Inno Setup)",
			in:       `"C:\Program Files (x86)\Freemake\Freemake Video Downloader\unins000.exe" /SILENT`,
			wantExe:  `C:\Program Files (x86)\Freemake\Freemake Video Downloader\unins000.exe`,
			wantRest: `/SILENT`,
		},
		{
			name:    "quoted exe no args",
			in:      `"C:\Program Files\Foo\uninst.exe"`,
			wantExe: `C:\Program Files\Foo\uninst.exe`,
		},
		{
			name:     "unquoted exe with spaces in path",
			in:       `C:\Program Files\Foo Bar\uninstall.exe /S /quiet`,
			wantExe:  `C:\Program Files\Foo Bar\uninstall.exe`,
			wantRest: `/S /quiet`,
		},
		{
			name:     "unquoted uppercase extension",
			in:       `C:\PROGRA~1\Foo\UNINST.EXE /S`,
			wantExe:  `C:\PROGRA~1\Foo\UNINST.EXE`,
			wantRest: `/S`,
		},
		{
			name:     "args are passed through verbatim, quotes and all",
			in:       `"C:\Program Files\Foo\helper.exe" --uninstall "C:\Program Files\Foo" --force`,
			wantExe:  `C:\Program Files\Foo\helper.exe`,
			wantRest: `--uninstall "C:\Program Files\Foo" --force`,
		},
		{name: "empty", in: `   `, wantErr: "empty"},
		{name: "unterminated quote", in: `"C:\Program Files\Foo\u.exe /S`, wantErr: "unterminated"},
		{name: "quote glued to args", in: `"C:\Foo\u.exe"/S`, wantErr: "separated"},
		{name: "relative path", in: `uninstall.exe /S`, wantErr: "absolute"},
		{name: "bare msiexec", in: `MsiExec.exe /X{11111111-2222-3333-4444-555555555555}`, wantErr: "absolute"},
		{name: "UNC path", in: `"\\fileserver\share\u.exe" /S`, wantErr: "absolute"},
		{name: "not an exe", in: `"C:\Program Files\Foo\uninstall.bat" /S`, wantErr: ".exe"},
		{name: "no exe anywhere", in: `C:\Program Files\Foo\uninstall /S`, wantErr: ".exe"},
		{name: "embedded newline", in: "\"C:\\Foo\\u.exe\" /S\r\ncalc.exe", wantErr: "control"},
		{name: "embedded NUL", in: "\"C:\\Foo\\u.exe\" /S\x00x", wantErr: "control"},
		{name: "alternate data stream", in: `"C:\Program Files\Foo\u.exe:payload.exe" /S`, wantErr: "invalid characters"},
		{name: "wildcard", in: `"C:\Program Files\Foo\*.exe" /S`, wantErr: "invalid characters"},
		{name: "trailing dot component", in: `"C:\Users.\bob\u.exe" /S`, wantErr: "dot or space"},
		{name: "trailing space component", in: `"C:\Program Files\AppData \u.exe" /S`, wantErr: "dot or space"},
		{name: "parent traversal", in: `"C:\Program Files\..\Users\Public\u.exe" /S`, wantErr: "traversal"},
		{name: "user profile location", in: `"C:\Users\bob\AppData\Local\Foo\u.exe" /S`, wantErr: "user-writable"},
		{name: "appdata on another drive", in: `"D:\Profiles\bob\AppData\Roaming\Foo\u.exe" /S`, wantErr: "user-writable"},
		{name: "temp dir", in: `"C:\Windows\Temp\u.exe" /S`, wantErr: "user-writable"},
		{name: "shell host cmd", in: `C:\Windows\System32\cmd.exe /c del /q C:\x`, wantErr: "script host"},
		{name: "shell host powershell", in: `"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -c x`, wantErr: "script host"},
		{name: "rundll32", in: `C:\Windows\System32\rundll32.exe x.dll,Uninstall`, wantErr: "script host"},
		{name: "mshta", in: `C:\Windows\System32\mshta.exe x`, wantErr: "script host"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			exe, rest, err := splitUninstallCommandLine(tt.in)
			if tt.wantErr != "" {
				if err == nil {
					t.Fatalf("expected error containing %q, got exe=%q rest=%q", tt.wantErr, exe, rest)
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("error %q does not contain %q", err.Error(), tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if exe != tt.wantExe || rest != tt.wantRest {
				t.Fatalf("got exe=%q rest=%q, want exe=%q rest=%q", exe, rest, tt.wantExe, tt.wantRest)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// planRegistryUninstall — MSI by product code first, else QuietUninstallString,
// never a guessed silent switch.
// ---------------------------------------------------------------------------

const testProductCode = "{11111111-2222-3333-4444-555555555555}"

func TestPlanRegistryUninstall(t *testing.T) {
	tests := []struct {
		name        string
		entry       windowsUninstallEntry
		wantKind    string
		wantCode    string
		wantExe     string
		wantArgs    string
		wantErrPart string
	}{
		{
			name: "MSI entry keyed by product code",
			entry: windowsUninstallEntry{
				KeyName: testProductCode, WindowsInstaller: true,
				UninstallString: "MsiExec.exe /I" + testProductCode,
			},
			wantKind: registryUninstallKindMSI, wantCode: testProductCode,
		},
		{
			name: "MSI product code is normalised to upper case",
			entry: windowsUninstallEntry{
				KeyName: strings.ToLower(testProductCode), WindowsInstaller: true,
			},
			wantKind: registryUninstallKindMSI, wantCode: testProductCode,
		},
		{
			name: "MSI takes precedence over a QuietUninstallString",
			entry: windowsUninstallEntry{
				KeyName: testProductCode, WindowsInstaller: true,
				QuietUninstallString: `"C:\Program Files\Foo\u.exe" /S`,
			},
			wantKind: registryUninstallKindMSI, wantCode: testProductCode,
		},
		{
			name: "product code from an msiexec UninstallString when the key is not a GUID",
			entry: windowsUninstallEntry{
				KeyName: "FooApp", WindowsInstaller: true,
				UninstallString: "MsiExec.exe /X" + testProductCode,
			},
			wantKind: registryUninstallKindMSI, wantCode: testProductCode,
		},
		{
			name: "product code from a fully-qualified msiexec string without the WindowsInstaller flag",
			entry: windowsUninstallEntry{
				KeyName:         "FooApp",
				UninstallString: `"C:\Windows\System32\msiexec.exe" /x ` + testProductCode,
			},
			wantKind: registryUninstallKindMSI, wantCode: testProductCode,
		},
		{
			name: "only the GUID survives from an msiexec string; trailing switches are dropped",
			entry: windowsUninstallEntry{
				KeyName:         "FooApp",
				UninstallString: "MsiExec.exe /X" + testProductCode + " TRANSFORMS=evil.mst & calc",
			},
			wantKind: registryUninstallKindMSI, wantCode: testProductCode,
		},
		{
			name: "Inno Setup entry uses QuietUninstallString verbatim",
			entry: windowsUninstallEntry{
				KeyName:              "Freemake Video Downloader_is1",
				UninstallString:      `"C:\Program Files (x86)\Freemake\unins000.exe"`,
				QuietUninstallString: `"C:\Program Files (x86)\Freemake\unins000.exe" /SILENT`,
			},
			wantKind: registryUninstallKindQuiet,
			wantExe:  `C:\Program Files (x86)\Freemake\unins000.exe`, wantArgs: `/SILENT`,
		},
		{
			name: "no QuietUninstallString and not MSI: refuse rather than guess switches",
			entry: windowsUninstallEntry{
				KeyName:         "BraveSoftwareBrave-Browser",
				UninstallString: `"C:\Program Files\BraveSoftware\Brave-Browser\Application\1.70.0\Installer\setup.exe" --uninstall --system-level`,
			},
			wantErrPart: "QuietUninstallString",
		},
		{
			name: "WindowsInstaller flag with no usable product code falls through to refusal",
			entry: windowsUninstallEntry{
				KeyName: "FooApp", WindowsInstaller: true,
				UninstallString: "MsiExec.exe /X{not-a-guid}",
			},
			wantErrPart: "QuietUninstallString",
		},
		{
			name: "unsafe QuietUninstallString is refused",
			entry: windowsUninstallEntry{
				KeyName:              "Foo",
				QuietUninstallString: `C:\Windows\System32\cmd.exe /c "C:\Foo\u.exe /S"`,
			},
			wantErrPart: "script host",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			plan, err := planRegistryUninstall(tt.entry)
			if tt.wantErrPart != "" {
				if err == nil {
					t.Fatalf("expected error containing %q, got plan %+v", tt.wantErrPart, plan)
				}
				if !strings.Contains(err.Error(), tt.wantErrPart) {
					t.Fatalf("error %q does not contain %q", err.Error(), tt.wantErrPart)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if plan.Kind != tt.wantKind || plan.ProductCode != tt.wantCode || plan.Exe != tt.wantExe || plan.Args != tt.wantArgs {
				t.Fatalf("got %+v, want kind=%q code=%q exe=%q args=%q", plan, tt.wantKind, tt.wantCode, tt.wantExe, tt.wantArgs)
			}
		})
	}
}

func TestRegistryUninstallCmdLine(t *testing.T) {
	msiexec := `C:\Windows\System32\msiexec.exe`

	exe, line := registryUninstallCmdLine(registryUninstallPlan{Kind: registryUninstallKindMSI, ProductCode: testProductCode}, msiexec)
	if exe != msiexec {
		t.Fatalf("msi exe = %q, want absolute msiexec %q", exe, msiexec)
	}
	if want := `"C:\Windows\System32\msiexec.exe" /x ` + testProductCode + ` /qn /norestart`; line != want {
		t.Fatalf("msi cmdline = %q, want %q", line, want)
	}

	exe, line = registryUninstallCmdLine(registryUninstallPlan{
		Kind: registryUninstallKindQuiet, Exe: `C:\Program Files\Foo\u.exe`, Args: `/S /D="C:\x"`,
	}, msiexec)
	if exe != `C:\Program Files\Foo\u.exe` {
		t.Fatalf("quiet exe = %q", exe)
	}
	if want := `"C:\Program Files\Foo\u.exe" /S /D="C:\x"`; line != want {
		t.Fatalf("quiet cmdline = %q, want %q", line, want)
	}

	_, line = registryUninstallCmdLine(registryUninstallPlan{Kind: registryUninstallKindQuiet, Exe: `C:\Foo\u.exe`}, msiexec)
	if line != `"C:\Foo\u.exe"` {
		t.Fatalf("quiet cmdline without args = %q", line)
	}
}

// ---------------------------------------------------------------------------
// matchWindowsUninstallEntries
// ---------------------------------------------------------------------------

func TestMatchWindowsUninstallEntries(t *testing.T) {
	entries := []windowsUninstallEntry{
		{KeyName: "a", DisplayName: "Brave", DisplayVersion: "1.70.0"},
		{KeyName: "b", DisplayName: "brave ", DisplayVersion: "1.71.0"},
		{KeyName: "c", DisplayName: "Brave Update Helper", DisplayVersion: "1.0"},
		{KeyName: "d", DisplayName: "Brave", DisplayVersion: "1.70.0", SystemComponent: true},
		{KeyName: "e", DisplayName: "", DisplayVersion: ""},
	}

	keys := func(es []windowsUninstallEntry) string {
		out := make([]string, 0, len(es))
		for _, e := range es {
			out = append(out, e.KeyName)
		}
		return strings.Join(out, ",")
	}

	if got := keys(matchWindowsUninstallEntries(entries, "Brave", "")); got != "a,b" {
		t.Fatalf("name-only match = %q, want a,b (exact, case-insensitive, no substring, no SystemComponent)", got)
	}
	if got := keys(matchWindowsUninstallEntries(entries, "Brave", "1.71.0")); got != "b" {
		t.Fatalf("version-filtered match = %q, want b", got)
	}
	if got := keys(matchWindowsUninstallEntries(entries, "Brave", "9.9.9")); got != "a,b" {
		t.Fatalf("stale version should fall back to name-only, got %q", got)
	}
	if got := keys(matchWindowsUninstallEntries(entries, "Nope", "")); got != "" {
		t.Fatalf("no match expected, got %q", got)
	}
}

// ---------------------------------------------------------------------------
// waitForRegistryUninstall — completion is judged by the Uninstall key
// disappearing, not by the launched process.
// ---------------------------------------------------------------------------

type fakeUninstallerProcess struct {
	waitCh chan error
	mu     sync.Mutex
	killed bool
}

func newFakeProcess() *fakeUninstallerProcess {
	return &fakeUninstallerProcess{waitCh: make(chan error, 1)}
}

func (p *fakeUninstallerProcess) Wait() error { return <-p.waitCh }
func (p *fakeUninstallerProcess) Kill() error {
	p.mu.Lock()
	p.killed = true
	p.mu.Unlock()
	select {
	case p.waitCh <- errors.New("killed"):
	default:
	}
	return nil
}
func (p *fakeUninstallerProcess) wasKilled() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.killed
}

type fakeExitError struct{ code int }

func (e fakeExitError) Error() string { return fmt.Sprintf("exit status %d", e.code) }
func (e fakeExitError) ExitCode() int { return e.code }

// presenceSequence reports the key present for the first `presentFor` checks,
// then absent.
type presenceSequence struct {
	mu         sync.Mutex
	calls      int
	presentFor int
	err        error
}

func (s *presenceSequence) check(windowsUninstallEntry) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	if s.err != nil {
		return false, s.err
	}
	return s.calls <= s.presentFor, nil
}

func useFastRegistryUninstallTimings(t *testing.T, timeout, grace time.Duration) {
	t.Helper()
	origTimeout, origGrace, origPoll := registryUninstallTimeout, registryUninstallPostExitGrace, registryUninstallPollInterval
	t.Cleanup(func() {
		registryUninstallTimeout, registryUninstallPostExitGrace, registryUninstallPollInterval = origTimeout, origGrace, origPoll
	})
	registryUninstallTimeout = timeout
	registryUninstallPostExitGrace = grace
	registryUninstallPollInterval = 5 * time.Millisecond
}

func usePresence(t *testing.T, fn func(windowsUninstallEntry) (bool, error)) {
	t.Helper()
	orig := uninstallEntryPresent
	t.Cleanup(func() { uninstallEntryPresent = orig })
	uninstallEntryPresent = fn
}

// Inno Setup's unins000.exe copies itself to %TEMP%, relaunches and exits 0
// immediately; the real removal finishes seconds later. Waiting on the launched
// process alone would read that as either success-before-removal or failure.
func TestWaitForRegistryUninstall_RelauncherExitsFirstKeyDisappearsLater(t *testing.T) {
	useFastRegistryUninstallTimings(t, 5*time.Second, 2*time.Second)
	seq := &presenceSequence{presentFor: 5}
	usePresence(t, seq.check)

	proc := newFakeProcess()
	proc.waitCh <- nil // exits 0 at once
	if err := waitForRegistryUninstall(registryUninstallPlan{Kind: registryUninstallKindQuiet}, proc); err != nil {
		t.Fatalf("expected success once the key disappeared, got %v", err)
	}
	if seq.calls < 6 {
		t.Fatalf("expected polling to continue after exit, only %d checks", seq.calls)
	}
}

// An uninstaller that leaves something running must not hang the command once
// the entry is gone.
func TestWaitForRegistryUninstall_ProcessStillRunningKeyGone(t *testing.T) {
	useFastRegistryUninstallTimings(t, 5*time.Second, 2*time.Second)
	seq := &presenceSequence{presentFor: 2}
	usePresence(t, seq.check)

	proc := newFakeProcess() // never exits on its own
	start := time.Now()
	if err := waitForRegistryUninstall(registryUninstallPlan{Kind: registryUninstallKindQuiet}, proc); err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("waited for the process instead of the registry")
	}
	if proc.wasKilled() {
		t.Fatal("a successful uninstall must not kill the uninstaller")
	}
}

func TestWaitForRegistryUninstall_MSIFailureExitFailsFast(t *testing.T) {
	useFastRegistryUninstallTimings(t, 5*time.Second, 3*time.Second)
	usePresence(t, func(windowsUninstallEntry) (bool, error) { return true, nil })

	proc := newFakeProcess()
	proc.waitCh <- fakeExitError{code: 1603}
	start := time.Now()
	err := waitForRegistryUninstall(registryUninstallPlan{Kind: registryUninstallKindMSI, ProductCode: testProductCode}, proc)
	if err == nil || !strings.Contains(err.Error(), "1603") {
		t.Fatalf("expected an error naming exit code 1603, got %v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("a failing exit code should not wait out the post-exit grace")
	}
}

// 3010 = ERROR_SUCCESS_REBOOT_REQUIRED: still a success when the key is gone.
func TestWaitForRegistryUninstall_RebootRequiredIsSuccess(t *testing.T) {
	useFastRegistryUninstallTimings(t, 5*time.Second, 2*time.Second)
	seq := &presenceSequence{presentFor: 0}
	usePresence(t, seq.check)

	proc := newFakeProcess()
	proc.waitCh <- fakeExitError{code: 3010}
	if err := waitForRegistryUninstall(registryUninstallPlan{Kind: registryUninstallKindMSI, ProductCode: testProductCode}, proc); err != nil {
		t.Fatalf("expected success, got %v", err)
	}
}

// A failing exit code is not the last word: if the entry is gone, it is gone.
func TestWaitForRegistryUninstall_NonZeroExitButKeyGoneIsSuccess(t *testing.T) {
	useFastRegistryUninstallTimings(t, 5*time.Second, 2*time.Second)
	usePresence(t, func(windowsUninstallEntry) (bool, error) { return false, nil })

	proc := newFakeProcess()
	proc.waitCh <- fakeExitError{code: 1}
	if err := waitForRegistryUninstall(registryUninstallPlan{Kind: registryUninstallKindQuiet}, proc); err != nil {
		t.Fatalf("expected success, got %v", err)
	}
}

func TestWaitForRegistryUninstall_ExitZeroButKeyRemainsFailsAfterGrace(t *testing.T) {
	useFastRegistryUninstallTimings(t, 5*time.Second, 50*time.Millisecond)
	usePresence(t, func(windowsUninstallEntry) (bool, error) { return true, nil })

	proc := newFakeProcess()
	proc.waitCh <- nil
	err := waitForRegistryUninstall(registryUninstallPlan{Kind: registryUninstallKindQuiet}, proc)
	if err == nil || !strings.Contains(err.Error(), "still present") {
		t.Fatalf("expected a still-present error, got %v", err)
	}
}

func TestWaitForRegistryUninstall_TimeoutKillsProcess(t *testing.T) {
	useFastRegistryUninstallTimings(t, 60*time.Millisecond, time.Second)
	usePresence(t, func(windowsUninstallEntry) (bool, error) { return true, nil })

	proc := newFakeProcess()
	err := waitForRegistryUninstall(registryUninstallPlan{Kind: registryUninstallKindQuiet}, proc)
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("expected timeout error, got %v", err)
	}
	if !proc.wasKilled() {
		t.Fatal("expected the hung uninstaller to be killed on timeout")
	}
}

// "We could not look" must never become "it is gone".
func TestWaitForRegistryUninstall_PresenceCheckErrorIsNotSuccess(t *testing.T) {
	useFastRegistryUninstallTimings(t, 5*time.Second, 50*time.Millisecond)
	seq := &presenceSequence{err: errors.New("access denied")}
	usePresence(t, seq.check)

	proc := newFakeProcess()
	proc.waitCh <- nil
	err := waitForRegistryUninstall(registryUninstallPlan{Kind: registryUninstallKindQuiet}, proc)
	if err == nil || !strings.Contains(err.Error(), "access denied") {
		t.Fatalf("expected the presence-check error to surface, got %v", err)
	}
}

// ---------------------------------------------------------------------------
// uninstallViaRegistryEntries + uninstallSoftwareWindows — the #7037 fallback.
// ---------------------------------------------------------------------------

type fakeRegistryUninstallEnv struct {
	entries  []windowsUninstallEntry
	listErr  error
	started  []registryUninstallPlan
	startErr error
	gone     map[string]bool // KeyName -> removed once its uninstaller ran
}

func (f *fakeRegistryUninstallEnv) install(t *testing.T) {
	t.Helper()
	useFastRegistryUninstallTimings(t, 2*time.Second, 200*time.Millisecond)
	origList, origStart, origPresent := listWindowsUninstallEntries, startRegistryUninstaller, uninstallEntryPresent
	t.Cleanup(func() {
		listWindowsUninstallEntries, startRegistryUninstaller, uninstallEntryPresent = origList, origStart, origPresent
	})
	var mu sync.Mutex
	removed := map[string]bool{}
	listWindowsUninstallEntries = func() ([]windowsUninstallEntry, error) { return f.entries, f.listErr }
	startRegistryUninstaller = func(plan registryUninstallPlan) (uninstallerProcess, error) {
		if f.startErr != nil {
			return nil, f.startErr
		}
		f.started = append(f.started, plan)
		mu.Lock()
		if f.gone[plan.Entry.KeyName] {
			removed[plan.Entry.KeyName] = true
		}
		mu.Unlock()
		p := newFakeProcess()
		p.waitCh <- nil
		return p, nil
	}
	uninstallEntryPresent = func(e windowsUninstallEntry) (bool, error) {
		mu.Lock()
		defer mu.Unlock()
		return !removed[e.KeyName], nil
	}
}

func TestUninstallViaRegistryEntries_RunsMSIAndQuietEntries(t *testing.T) {
	env := &fakeRegistryUninstallEnv{
		entries: []windowsUninstallEntry{
			{KeyName: testProductCode, DisplayName: "Foo", WindowsInstaller: true},
			{KeyName: "Foo_is1", DisplayName: "Foo", QuietUninstallString: `"C:\Program Files\Foo\unins000.exe" /SILENT`},
			{KeyName: "Other", DisplayName: "Other", QuietUninstallString: `"C:\Other\u.exe" /S`},
		},
		gone: map[string]bool{testProductCode: true, "Foo_is1": true},
	}
	env.install(t)

	if err := uninstallViaRegistryEntries("Foo", ""); err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	if len(env.started) != 2 || env.started[0].Kind != registryUninstallKindMSI || env.started[1].Kind != registryUninstallKindQuiet {
		t.Fatalf("expected MSI then quiet uninstall of the two Foo entries, got %+v", env.started)
	}
}

// Planning happens for every matched entry BEFORE anything runs, so one
// unplannable duplicate cannot leave the program half-removed.
func TestUninstallViaRegistryEntries_RefusesBeforeRunningAnythingWhenAnEntryIsUnplannable(t *testing.T) {
	env := &fakeRegistryUninstallEnv{
		entries: []windowsUninstallEntry{
			{KeyName: testProductCode, DisplayName: "Foo", WindowsInstaller: true},
			{KeyName: "Foo2", DisplayName: "Foo", UninstallString: `"C:\Foo\setup.exe" --uninstall`},
		},
		gone: map[string]bool{testProductCode: true},
	}
	env.install(t)

	err := uninstallViaRegistryEntries("Foo", "")
	if err == nil || !strings.Contains(err.Error(), "QuietUninstallString") {
		t.Fatalf("expected a no-silent-uninstaller refusal, got %v", err)
	}
	if len(env.started) != 0 {
		t.Fatalf("nothing may run when any matched entry is unplannable, ran %+v", env.started)
	}
}

func TestUninstallViaRegistryEntries_NoEntry(t *testing.T) {
	env := &fakeRegistryUninstallEnv{entries: []windowsUninstallEntry{{KeyName: "x", DisplayName: "Other"}}}
	env.install(t)
	err := uninstallViaRegistryEntries("Foo", "")
	if err == nil || !strings.Contains(err.Error(), "no machine-wide Uninstall registry entry") {
		t.Fatalf("expected no-entry error, got %v", err)
	}
}

func TestUninstallViaRegistryEntries_TooManyMatches(t *testing.T) {
	var entries []windowsUninstallEntry
	for i := 0; i < maxRegistryUninstallEntries+1; i++ {
		entries = append(entries, windowsUninstallEntry{
			KeyName: fmt.Sprintf("k%d", i), DisplayName: "Foo",
			QuietUninstallString: `"C:\Foo\u.exe" /S`,
		})
	}
	env := &fakeRegistryUninstallEnv{entries: entries}
	env.install(t)
	err := uninstallViaRegistryEntries("Foo", "")
	if err == nil || !strings.Contains(err.Error(), "entries") {
		t.Fatalf("expected a too-many-entries refusal, got %v", err)
	}
	if len(env.started) != 0 {
		t.Fatalf("nothing may run, ran %d", len(env.started))
	}
}

func TestUninstallViaRegistryEntries_ListError(t *testing.T) {
	env := &fakeRegistryUninstallEnv{listErr: errors.New("boom")}
	env.install(t)
	if err := uninstallViaRegistryEntries("Foo", ""); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("expected list error to surface, got %v", err)
	}
}

// The issue's exact failure: winget exits 0xc0000135 on every call and wmic no
// longer exists. The registered uninstaller must still run.
func TestUninstallSoftwareWindows_FallsBackToRegistryWhenWingetIsBroken(t *testing.T) {
	winget := &fakeUninstallEnv{
		available: map[string]bool{"winget": true},
		responses: map[string]struct {
			output string
			err    error
		}{
			"winget": {output: "", err: errors.New("exit status 0xc0000135")},
		},
	}
	stillPresent := true
	winget.install(t, true, nil)
	uninstallVerifyStillPresent = func(string) (bool, error) { return stillPresent, nil }

	reg := &fakeRegistryUninstallEnv{
		entries: []windowsUninstallEntry{{
			KeyName: "Freemake Video Downloader_is1", DisplayName: "Freemake Video Downloader", DisplayVersion: "3.8.5",
			QuietUninstallString: `"C:\Program Files (x86)\Freemake\unins000.exe" /SILENT`,
		}},
		gone: map[string]bool{"Freemake Video Downloader_is1": true},
	}
	reg.install(t)
	origStart := startRegistryUninstaller
	startRegistryUninstaller = func(plan registryUninstallPlan) (uninstallerProcess, error) {
		stillPresent = false
		return origStart(plan)
	}

	if err := uninstallSoftwareWindows("Freemake Video Downloader", "3.8.5"); err != nil {
		t.Fatalf("expected the registry fallback to succeed, got %v", err)
	}
	for _, cmd := range winget.ran {
		if cmd == "wmic" {
			t.Fatal("wmic must no longer be attempted")
		}
	}
	if len(reg.started) != 1 {
		t.Fatalf("expected exactly one registry uninstall, got %d", len(reg.started))
	}
}

func TestUninstallSoftwareWindows_WingetSuccessSkipsRegistry(t *testing.T) {
	winget := &fakeUninstallEnv{
		available: map[string]bool{"winget": true},
		responses: map[string]struct {
			output string
			err    error
		}{"winget": {output: "Successfully uninstalled"}},
	}
	winget.install(t, false, nil)
	reg := &fakeRegistryUninstallEnv{}
	reg.install(t)
	listWindowsUninstallEntries = func() ([]windowsUninstallEntry, error) {
		t.Fatal("registry fallback must not run when winget verifiably removed the software")
		return nil, nil
	}
	if err := uninstallSoftwareWindows("Foo", ""); err != nil {
		t.Fatalf("expected success, got %v", err)
	}
}

func TestUninstallSoftwareWindows_BothFailReportsBoth(t *testing.T) {
	winget := &fakeUninstallEnv{
		available: map[string]bool{"winget": true},
		responses: map[string]struct {
			output string
			err    error
		}{"winget": {output: "", err: errors.New("exit status 0xc0000135")}},
	}
	winget.install(t, true, nil)
	reg := &fakeRegistryUninstallEnv{entries: []windowsUninstallEntry{{
		KeyName: "Brave", DisplayName: "Brave",
		UninstallString: `"C:\Program Files\BraveSoftware\setup.exe" --uninstall --system-level`,
	}}}
	reg.install(t)

	err := uninstallSoftwareWindows("Brave", "")
	if err == nil {
		t.Fatal("expected failure")
	}
	msg := err.Error()
	if !strings.Contains(msg, "0xc0000135") || !strings.Contains(msg, "QuietUninstallString") {
		t.Fatalf("error must carry both the winget and the registry reason, got %q", msg)
	}
	if len(reg.started) != 0 {
		t.Fatal("no switches may be guessed for an entry without QuietUninstallString")
	}
}

// Keys gone but the inventory still lists the name (e.g. a same-name entry in a
// hive the fallback does not touch): report it, do not claim success.
func TestUninstallSoftwareWindows_RegistrySuccessButInventoryStillListsIt(t *testing.T) {
	winget := &fakeUninstallEnv{available: map[string]bool{}}
	winget.install(t, true, nil)
	reg := &fakeRegistryUninstallEnv{
		entries: []windowsUninstallEntry{{KeyName: testProductCode, DisplayName: "Foo", WindowsInstaller: true}},
		gone:    map[string]bool{testProductCode: true},
	}
	reg.install(t)

	err := uninstallSoftwareWindows("Foo", "")
	if err == nil || !strings.Contains(err.Error(), "still present") {
		t.Fatalf("expected a still-present error, got %v", err)
	}
}

func TestUninstallViaRegistryEntries_NoEntrySaysWhenSubkeysWereUnreadable(t *testing.T) {
	env := &fakeRegistryUninstallEnv{entries: []windowsUninstallEntry{
		{KeyName: "x", DisplayName: "Other"},
		{KeyName: "locked", KeyPath: `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\locked`, ReadErr: errors.New("Access is denied.")},
	}}
	env.install(t)
	err := uninstallViaRegistryEntries("Foo", "")
	if err == nil || !strings.Contains(err.Error(), "1 Uninstall subkey(s) could not be read") || !strings.Contains(err.Error(), "Access is denied") {
		t.Fatalf("an unreadable subkey must not be reported as a definite absence, got %v", err)
	}
}

func TestUninstallViaRegistryEntries_ExactlyMaxMatchesRun(t *testing.T) {
	var entries []windowsUninstallEntry
	gone := map[string]bool{}
	for i := 0; i < maxRegistryUninstallEntries; i++ {
		k := fmt.Sprintf("k%d", i)
		entries = append(entries, windowsUninstallEntry{KeyName: k, DisplayName: "Foo", QuietUninstallString: `"C:\Foo\u.exe" /S`})
		gone[k] = true
	}
	env := &fakeRegistryUninstallEnv{entries: entries, gone: gone}
	env.install(t)
	if err := uninstallViaRegistryEntries("Foo", ""); err != nil {
		t.Fatalf("expected success at the cap, got %v", err)
	}
	if len(env.started) != maxRegistryUninstallEntries {
		t.Fatalf("expected %d uninstallers, ran %d", maxRegistryUninstallEntries, len(env.started))
	}
}

func TestUninstallViaRegistryEntries_StopsOnStartErrorMidLoop(t *testing.T) {
	env := &fakeRegistryUninstallEnv{
		entries: []windowsUninstallEntry{
			{KeyName: "first", DisplayName: "Foo", QuietUninstallString: `"C:\Foo\a.exe" /S`},
			{KeyName: "second", DisplayName: "Foo", QuietUninstallString: `"C:\Foo\b.exe" /S`},
		},
		gone: map[string]bool{"first": true},
	}
	env.install(t)
	inner := startRegistryUninstaller
	startRegistryUninstaller = func(plan registryUninstallPlan) (uninstallerProcess, error) {
		if plan.Entry.KeyName == "second" {
			return nil, errors.New("file not found")
		}
		return inner(plan)
	}
	err := uninstallViaRegistryEntries("Foo", "")
	if err == nil || !strings.Contains(err.Error(), "second") || !strings.Contains(err.Error(), "file not found") {
		t.Fatalf("expected the second entry's start error, got %v", err)
	}
	if len(env.started) != 1 || env.started[0].Entry.KeyName != "first" {
		t.Fatalf("expected only the first entry to have run, once; got %+v", env.started)
	}
}

// The versioned winget attempt runs first, then the name-only one; a success on
// the second means the registry fallback never runs.
func TestUninstallSoftwareWindows_VersionedWingetThenNameOnly(t *testing.T) {
	origLookPath, origRun, origVerify := uninstallLookPath, runUninstallCommand, uninstallVerifyStillPresent
	t.Cleanup(func() {
		uninstallLookPath, runUninstallCommand, uninstallVerifyStillPresent = origLookPath, origRun, origVerify
	})
	var ran [][]string
	uninstallLookPath = func(string) (string, error) { return `C:\winget.exe`, nil }
	runUninstallCommand = func(a uninstallAttempt) ([]byte, error) {
		ran = append(ran, a.args)
		if len(ran) == 1 {
			return []byte("uninstall failed"), errors.New("exit status 1")
		}
		return []byte("Successfully uninstalled"), nil
	}
	uninstallVerifyStillPresent = func(string) (bool, error) { return false, nil }
	reg := &fakeRegistryUninstallEnv{}
	reg.install(t)
	listWindowsUninstallEntries = func() ([]windowsUninstallEntry, error) {
		t.Fatal("registry fallback must not run")
		return nil, nil
	}

	if err := uninstallSoftwareWindows("Foo", "1.2.3"); err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	if len(ran) != 2 {
		t.Fatalf("expected 2 winget attempts, got %d: %v", len(ran), ran)
	}
	first, second := strings.Join(ran[0], " "), strings.Join(ran[1], " ")
	if !strings.Contains(first, "--name Foo --version 1.2.3") {
		t.Fatalf("first attempt should pin the version, got %q", first)
	}
	if strings.Contains(second, "--version") || !strings.Contains(second, "--name Foo") {
		t.Fatalf("second attempt should be name-only, got %q", second)
	}
}
