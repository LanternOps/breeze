package tools

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestValidateSoftwareName(t *testing.T) {
	t.Parallel()

	valid := []string{
		"Google Chrome",
		"Visual Studio Code",
		"nodejs-lts",
		"7-Zip",
	}

	for _, name := range valid {
		if err := validateSoftwareName(name); err != nil {
			t.Errorf("expected %q to be valid, got error: %v", name, err)
		}
	}

	invalid := []string{
		"",
		"../../etc/passwd",
		"name/with/slash",
		"bad;name",
		"foo'bar",
		"name with ' quote",
		"name'with'quotes",
		"Foo' OR name like '%",
		`name"with"doublequotes`,
	}

	for _, name := range invalid {
		if err := validateSoftwareName(name); err == nil {
			t.Errorf("expected %q to be invalid", name)
		}
	}
}

func TestSafeMacOSApplicationPath(t *testing.T) {
	t.Parallel()

	path, err := safeMacOSApplicationPath("Slack")
	if err != nil {
		t.Fatalf("expected Slack path to be valid, got %v", err)
	}
	if path != "/Applications/Slack.app" {
		t.Fatalf("unexpected path: %s", path)
	}

	if _, err := safeMacOSApplicationPath("../BadApp"); err == nil {
		t.Fatal("expected traversal app name to fail")
	}
}

func TestIsProtectedLinuxPackage(t *testing.T) {
	t.Parallel()

	protected := []string{
		"systemd",
		"kernel-default",
		"linux-image-5.15.0-91-generic",
		"linux-headers-5.15.0",
		"systemd-resolved",
		"libc6",
		"bash",
		"apt",
		"dpkg",
		"rpm",
		"grub",
		"grub2-common",
		"openssl",
		"openssh-server",
		"initramfs-tools",
	}
	allowed := []string{
		"google-chrome-stable",
		"slack",
		"vscode",
		"nodejs",
	}

	for _, name := range protected {
		if !isProtectedLinuxPackage(name) {
			t.Errorf("expected %q to be protected", name)
		}
	}
	for _, name := range allowed {
		if isProtectedLinuxPackage(name) {
			t.Errorf("expected %q to be allowed", name)
		}
	}
}

func TestUninstallSoftwareMacOSPathValidation(t *testing.T) {
	t.Parallel()

	// Traversal in name should fail at safeMacOSApplicationPath
	if _, err := safeMacOSApplicationPath("../../../etc"); err == nil {
		t.Fatal("expected path traversal to fail")
	}

	// Empty name should fail
	if _, err := safeMacOSApplicationPath(""); err == nil {
		t.Fatal("expected empty name to fail")
	}

	// Valid name should succeed
	path, err := safeMacOSApplicationPath("Spotify")
	if err != nil {
		t.Fatalf("expected Spotify to produce valid path, got: %v", err)
	}
	if path != "/Applications/Spotify.app" {
		t.Fatalf("unexpected path: %s", path)
	}
}

func TestIsProtectedLinuxPackageSystemdVariants(t *testing.T) {
	t.Parallel()
	protected := []string{
		"systemd-journald",
		"systemd-resolved",
		"systemd-networkd",
	}
	for _, name := range protected {
		if !isProtectedLinuxPackage(name) {
			t.Errorf("expected %q to be protected", name)
		}
	}
}

func TestValidateSoftwareNameBoundaries(t *testing.T) {
	t.Parallel()

	// Exactly 200 chars — must be valid
	long200 := strings.Repeat("a", 200)
	if err := validateSoftwareName(long200); err != nil {
		t.Fatalf("expected 200-char name to be valid, got: %v", err)
	}

	// 201 chars — must be invalid
	long201 := strings.Repeat("a", 201)
	if err := validateSoftwareName(long201); err == nil {
		t.Fatal("expected 201-char name to be invalid")
	}
}

func TestValidateSoftwareNameRejectsSingleQuote(t *testing.T) {
	t.Parallel()
	if err := validateSoftwareName("Joe's App"); err == nil {
		t.Fatal("expected name with single quote to be rejected")
	}
}

func TestValidateSoftwareNameRejectsLeadingHyphen(t *testing.T) {
	t.Parallel()
	if err := validateSoftwareName("--purge"); err == nil {
		t.Fatal("expected leading-hyphen software name to be rejected")
	}
}

func TestValidateSoftwareVersionRejectsUnsafeValues(t *testing.T) {
	t.Parallel()
	if err := validateSoftwareVersion("--latest"); err == nil {
		t.Fatal("expected leading-hyphen version to be rejected")
	}
	if err := validateSoftwareVersion(strings.Repeat("1", maxSoftwareVersionLength+1)); err == nil {
		t.Fatal("expected oversized version to be rejected")
	}
}

func TestValidateInstallInputsRejectsOversizedFields(t *testing.T) {
	t.Parallel()

	_, _, _, _, _, _, err := validateInstallInputs(
		"installer.exe",
		"exe",
		"",
		strings.Repeat("a", maxInstallArgBytes+1),
		"App",
		"1.0.0",
	)
	if err == nil {
		t.Fatal("expected oversized silentInstallArgs to fail")
	}
}

func TestValidateInstallInputsRejectsUnsupportedFileTypeAndBadChecksum(t *testing.T) {
	t.Parallel()

	if _, _, _, _, _, _, err := validateInstallInputs("installer.bin", "bin", "", "", "App", "1.0.0"); err == nil {
		t.Fatal("expected unsupported fileType to fail")
	}
	if _, _, _, _, _, _, err := validateInstallInputs("installer.exe", "exe", "not-a-checksum", "", "App", "1.0.0"); err == nil {
		t.Fatal("expected invalid checksum to fail")
	}
}

func TestValidateInstallInputsRejectsMismatchedFileNameAndArgsFormat(t *testing.T) {
	t.Parallel()

	if _, _, _, _, _, _, err := validateInstallInputs("installer.exe", "msi", "", "", "App", "1.0.0"); err == nil {
		t.Fatal("expected mismatched fileName/fileType to fail")
	}
	if _, _, _, _, _, _, err := validateInstallInputs("installer.msi", "msi", "", "\"unterminated", "App", "1.0.0"); err == nil {
		t.Fatal("expected unmatched quotes to fail")
	}
	if _, _, _, _, _, _, err := validateInstallInputs("installer.msi", "msi", "", "line1\nline2", "App", "1.0.0"); err == nil {
		t.Fatal("expected control characters to fail")
	}
	if _, _, _, _, _, _, err := validateInstallInputs("installer.msi", "msi", "", "/x {file}", "App", "1.0.0"); err == nil {
		t.Fatal("expected unsupported MSI uninstall action to fail")
	}
}

func TestValidateDownloadURLAndRedirectPolicy(t *testing.T) {
	t.Parallel()

	if err := validateDownloadURL("https://example.com/file.exe"); err != nil {
		t.Fatalf("expected https URL to pass, got %v", err)
	}
	if err := validateDownloadURL("https://user:pass@example.com/file.exe"); err == nil {
		t.Fatal("expected userinfo URL to fail")
	}

	req := &http.Request{URL: &url.URL{Scheme: "http", Host: "example.com", Path: "/file.exe"}}
	err := newInstallerHTTPClient().CheckRedirect(req, []*http.Request{{URL: &url.URL{Scheme: "https", Host: "example.com"}}})
	if err == nil || !strings.Contains(err.Error(), "redirect blocked") {
		t.Fatalf("expected insecure redirect to be blocked, got %v", err)
	}
}

func TestInstallSoftwareRejectsNonHTTPSDownloadURL(t *testing.T) {
	t.Parallel()

	result := InstallSoftware(map[string]any{
		"downloadUrl": "http://example.com/installer.exe",
		"fileName":    "installer.exe",
		"fileType":    "exe",
	})
	if result.Status != "failed" {
		t.Fatalf("expected failed status, got %q", result.Status)
	}
	if !strings.Contains(result.Error, "downloadUrl must use HTTPS") {
		t.Fatalf("unexpected error: %q", result.Error)
	}
}

func TestBuildMSIExecArgsForcesMsiexecAndInstallerPath(t *testing.T) {
	t.Parallel()

	localPath := `C:\Temp\installer.msi`
	args := buildMSIExecArgs(localPath, `msiexec /qn /norestart`)
	if len(args) < 3 {
		t.Fatalf("expected msiexec args to include installer path, got %v", args)
	}
	if args[0] != "/i" || args[1] != localPath {
		t.Fatalf("expected args to start with installer target, got %v", args)
	}

	args = buildMSIExecArgs(localPath, `/qn /norestart`)
	if args[0] != "/i" || args[1] != localPath {
		t.Fatalf("expected local path to be prepended, got %v", args)
	}

	args = buildMSIExecArgs(localPath, `/i {file} /qn`)
	if args[0] != "/i" || args[1] != localPath {
		t.Fatalf("expected explicit placeholder to resolve to installer path, got %v", args)
	}
}

func TestSanitizeUninstallOutput(t *testing.T) {
	t.Parallel()

	output, truncated := sanitizeUninstallOutput(strings.Repeat("o", maxUninstallOutputBytes+64))
	if !truncated {
		t.Fatal("expected uninstall output to be truncated")
	}
	if got := len(output); got > maxUninstallOutputBytes {
		t.Fatalf("expected uninstall output to be truncated, got %d bytes", got)
	}
}
