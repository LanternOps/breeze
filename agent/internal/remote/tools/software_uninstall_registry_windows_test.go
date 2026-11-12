//go:build windows

package tools

import (
	"crypto/rand"
	"encoding/hex"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// copyHostname copies hostname.exe (harmless if it ever ran) to dst.
func copyHostname(t *testing.T, dst string) {
	t.Helper()
	src, err := os.Open(filepath.Join(os.Getenv("SystemRoot"), "System32", "hostname.exe"))
	if err != nil {
		t.Skipf("hostname.exe: %v", err)
	}
	defer src.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o700)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(out, src); err != nil {
		out.Close()
		t.Fatal(err)
	}
	if err := out.Close(); err != nil {
		t.Fatal(err)
	}
}

// profileUninstaller creates <profile>\breeze-t-<random>\u.exe and returns its
// directory name and path. It skips when the profile is not under C:\Users.
func profileUninstaller(t *testing.T) (string, string) {
	t.Helper()
	profile := os.Getenv("USERPROFILE")
	usersRoot := filepath.Join(os.Getenv("SystemDrive")+`\`, "Users") + `\`
	if !strings.HasPrefix(strings.ToLower(profile), strings.ToLower(usersRoot)) {
		t.Skipf("profile %q is not under %s", profile, usersRoot)
	}
	var b [6]byte
	_, _ = rand.Read(b[:])
	dirName := "breeze-t-" + hex.EncodeToString(b[:])
	dir := filepath.Join(profile, dirName)
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	exe := filepath.Join(dir, "u.exe")
	copyHostname(t, exe)
	return dirName, exe
}

// requireRefusedAtResolvedPath checks that path passes the registered-string
// check but is refused once resolved, both by openResolvedUninstaller and by
// the launch path, which must not start it.
func requireRefusedAtResolvedPath(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); err != nil {
		t.Skipf("%q is not reachable here: %v", path, err)
	}
	if err := validateUninstallerPath(path); err != nil {
		t.Fatalf("validateUninstallerPath(%q) = %v; the test needs a path the string check accepts", path, err)
	}
	if f, resolved, err := openResolvedUninstaller(path); err == nil || !strings.Contains(err.Error(), "user-writable") {
		if f != nil {
			f.Close()
		}
		t.Fatalf("openResolvedUninstaller(%q) = %q, %v; want a user-writable refusal", path, resolved, err)
	}
	proc, err := startRegistryUninstallerOS(registryUninstallPlan{Kind: registryUninstallKindQuiet, Exe: path})
	if err == nil {
		_ = proc.Kill()
		_ = proc.Wait()
		t.Fatalf("startRegistryUninstallerOS started %q; want it refused at its resolved location", path)
	}
	if !strings.Contains(err.Error(), "resolves to") {
		t.Fatalf("startRegistryUninstallerOS(%q) = %v; want a resolved-location refusal", path, err)
	}
}

func TestOpenResolvedUninstallerRefusesTempAndRepeatedSeparators(t *testing.T) {
	// The test's temp directory is normally under a user profile or a Temp
	// folder; the refusal below needs that.
	userFile := filepath.Join(t.TempDir(), "unins000.exe")
	if validateUninstallerPath(userFile) == nil {
		t.Skipf("temp directory %q is not in a refused location", userFile)
	}
	copyHostname(t, userFile)
	for _, path := range []string{userFile, strings.ReplaceAll(userFile, `\`, `\\`)} {
		if f, _, err := openResolvedUninstaller(path); err == nil || !strings.Contains(err.Error(), "user-writable") {
			if f != nil {
				f.Close()
			}
			t.Fatalf("openResolvedUninstaller(%q) = %v, want a user-writable refusal", path, err)
		}
	}
}

// C:\Documents and Settings is a junction to C:\Users.
func TestUninstallerThroughDocumentsAndSettingsIsRefused(t *testing.T) {
	dirName, exe := profileUninstaller(t)
	profileName := filepath.Base(filepath.Dir(filepath.Dir(exe)))
	path := filepath.Join(os.Getenv("SystemDrive")+`\`, "Documents and Settings", profileName, dirName, "u.exe")
	requireRefusedAtResolvedPath(t, path)
}

func TestUninstallerThroughJunctionIsRefused(t *testing.T) {
	dirName, exe := profileUninstaller(t)
	link := filepath.Join(os.Getenv("SystemDrive")+`\`, dirName)
	if out, err := exec.Command("cmd.exe", "/D", "/C", "mklink", "/J", link, filepath.Dir(exe)).CombinedOutput(); err != nil {
		t.Skipf("cannot create a junction at %q: %v: %s", link, err, out)
	}
	t.Cleanup(func() { _ = os.Remove(link) })
	requireRefusedAtResolvedPath(t, filepath.Join(link, "u.exe"))
}

// The read-only handle held across the launch must not stop the process from
// starting, and the resolved path is the one launched.
func TestStartRegistryUninstallerStartsResolvedPath(t *testing.T) {
	exe := filepath.Join(os.Getenv("SystemRoot"), "System32", "hostname.exe")
	if _, err := os.Stat(exe); err != nil {
		t.Skipf("hostname.exe: %v", err)
	}
	f, resolved, err := openResolvedUninstaller(exe)
	if err != nil {
		t.Fatalf("openResolvedUninstaller(%q) = %v", exe, err)
	}
	f.Close()
	if !strings.EqualFold(resolved, exe) {
		t.Fatalf("resolved %q, want %q", resolved, exe)
	}
	proc, err := startRegistryUninstallerOS(registryUninstallPlan{Kind: registryUninstallKindQuiet, Exe: exe})
	if err != nil {
		t.Fatalf("startRegistryUninstallerOS(%q) = %v", exe, err)
	}
	if err := proc.Wait(); err != nil {
		t.Fatalf("wait: %v", err)
	}
	cp, ok := proc.(cmdProcess)
	if !ok || !strings.EqualFold(cp.cmd.Path, resolved) {
		t.Fatalf("launched %#v, want path %q", proc, resolved)
	}
}
