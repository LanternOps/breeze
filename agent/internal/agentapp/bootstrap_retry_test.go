package agentapp

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// #4127: an install that carried enrollment material which cannot be used must
// fail loudly (so a deploy tool sees the failure), while a genuinely bare
// install with no enrollment material at all keeps the soft path.
func TestResolveBootstrapInputs_UnusableMaterialIsDistinctFromNone(t *testing.T) {
	cases := []struct {
		name    string
		data    string
		wantErr error
	}{
		{
			// BOOTSTRAP_TOKEN set on the msiexec command line, but no SERVER_URL
			// and no filename token to fall back on: enrollment was clearly
			// intended and can never happen.
			name:    "property token without server and no filename token",
			data:    `C:\dl\breeze-agent.msi|ZZZZZ99999|`,
			wantErr: errBootstrapInputUnusable,
		},
		{
			// A deploy tool / file system lowercased the name: the token group is
			// still there, just no longer in the canonical shape.
			name:    "lowercased filename token",
			data:    `C:\ProgramData\Deploy\breeze agent (6ke9mdug56@us.2breeze.app).msi||`,
			wantErr: errBootstrapInputUnusable,
		},
		{
			name:    "lowercased token with the port colon kept",
			data:    `C:\dl\Breeze Agent (6ke9mdug56@rmm.acme.example:8443).msi||`,
			wantErr: errBootstrapInputUnusable,
		},
		{
			// An ordinary rename that happens to carry an e-mail address or a
			// note must NOT roll the install back.
			name:    "e-mail address in parentheses",
			data:    `C:\dl\Breeze Agent (support@acme.com).msi||`,
			wantErr: errNoBootstrapInput,
		},
		{
			name:    "deployer note in parentheses",
			data:    `C:\dl\BreezeAgent (deployed by admin@corp).msi||`,
			wantErr: errNoBootstrapInput,
		},
		{
			name:    "bracketed filename token with bad host",
			data:    `C:\dl\Breeze Agent [6KE9MDUG56@].msi||`,
			wantErr: errBootstrapInputUnusable,
		},
		{
			// Browser dedup suffix, no token group: nothing was intended.
			name:    "browser dedup suffix only",
			data:    `C:\Users\me\Downloads\Breeze Agent (1).msi||`,
			wantErr: errNoBootstrapInput,
		},
		{
			// Maintenance/repair run from the Windows Installer cache: the
			// cached package name never carries a token.
			name:    "cached package path",
			data:    `C:\Windows\Installer\1a2b3c.msi||`,
			wantErr: errNoBootstrapInput,
		},
		{
			name:    "renamed file with no token",
			data:    `C:\ProgramData\Deploy\BreezeAgent.msi||`,
			wantErr: errNoBootstrapInput,
		},
		{
			// An '@' in a parenthesised group of the DIRECTORY must not count:
			// only the package file name can carry a token.
			name:    "at-sign in a parent directory, not the file name",
			data:    `C:\Users\me (me@corp.example)\Downloads\BreezeAgent.msi||`,
			wantErr: errNoBootstrapInput,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, _, err := resolveBootstrapInputs(tc.data)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("want err %v, got %v", tc.wantErr, err)
			}
		})
	}
}

// setupRunBootstrapSinks points runBootstrap at a fresh unenrolled config and
// captures every durable sink plus the exit code.
func setupRunBootstrapSinks(t *testing.T, installData string) (exitCode *int, lastError, eventErr, eventWarn *string) {
	t.Helper()
	dir := t.TempDir()
	origCfg, origData, origQuiet := cfgFile, bootstrapInstallData, quietEnroll
	origExit, origWrite, origEvErr, origEvWarn := osExit, writeLastErrorFile, eventLogError, eventLogWarning
	t.Cleanup(func() {
		cfgFile, bootstrapInstallData, quietEnroll = origCfg, origData, origQuiet
		osExit, writeLastErrorFile, eventLogError, eventLogWarning = origExit, origWrite, origEvErr, origEvWarn
	})
	cfgFile, quietEnroll = filepath.Join(dir, "agent.yaml"), true
	bootstrapInstallData = installData

	code := -1
	var le, ee, ew string
	osExit = func(c int) {
		code = c
		panic(fmt.Sprintf("test exit %d", c))
	}
	writeLastErrorFile = func(line string) { le = line }
	eventLogError = func(_, m string) { ee = m }
	eventLogWarning = func(_, m string) { ew = m }
	return &code, &le, &ee, &ew
}

func runBootstrapRecovering() {
	defer func() { _ = recover() }()
	runBootstrap()
}

func TestRunBootstrap_UnusableMaterialFailsHard(t *testing.T) {
	code, lastErr, evErr, _ := setupRunBootstrapSinks(t,
		`C:\ProgramData\Deploy\breeze agent (6ke9mdug56@us.2breeze.app).msi||`)

	runBootstrapRecovering()

	if *code != 1 {
		t.Fatalf("exit code = %d, want 1 (MSI must roll back so the deploy tool sees the failure)", *code)
	}
	for sink, got := range map[string]string{"enroll-last-error.txt": *lastErr, "event log (error)": *evErr} {
		if !strings.Contains(got, "Bootstrap failed") {
			t.Errorf("%s = %q, want a Bootstrap failed line", sink, got)
		}
	}
}

func TestRunBootstrap_NoMaterialSoftSucceedsButLeavesTrace(t *testing.T) {
	code, lastErr, evErr, evWarn := setupRunBootstrapSinks(t, `C:\ProgramData\Deploy\BreezeAgent.msi||`)

	runBootstrapRecovering()

	if *code != -1 {
		t.Fatalf("exit code = %d, want no exit (bare install must keep the soft path)", *code)
	}
	if *evErr != "" {
		t.Errorf("event log error = %q, want none for a bare install", *evErr)
	}
	for sink, got := range map[string]string{"enroll-last-error.txt": *lastErr, "event log (warning)": *evWarn} {
		if !strings.Contains(got, "not enrolled") {
			t.Errorf("%s = %q, want a durable 'not enrolled' trace", sink, got)
		}
	}
}

// A maintenance rerun on an ALREADY-ENROLLED device must never trip the new
// hard-fail: the enrolled short-circuit has to run before input resolution, or
// every later repair of a device installed from a renamed/mangled file would
// roll back.
func TestRunBootstrap_EnrolledAgentWithMangledFilenameDoesNotFail(t *testing.T) {
	code, lastErr, evErr, evWarn := setupRunBootstrapSinks(t,
		`C:\ProgramData\Deploy\breeze agent (6ke9mdug56@us.2breeze.app).msi||`)
	if err := os.WriteFile(cfgFile, []byte(
		"agent_id: 0f0e0d0c-0b0a-4908-8706-050403020100\nlog_file: "+
			filepath.ToSlash(filepath.Join(filepath.Dir(cfgFile), "agent.log"))+"\n",
	), 0o600); err != nil {
		t.Fatal(err)
	}

	runBootstrapRecovering()

	if *code != -1 {
		t.Fatalf("exit code = %d, want no exit for an already-enrolled agent", *code)
	}
	if *lastErr != "" || *evErr != "" || *evWarn != "" {
		t.Fatalf("enrolled agent wrote sinks: lastErr=%q evErr=%q evWarn=%q", *lastErr, *evErr, *evWarn)
	}
}
