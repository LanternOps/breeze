package tools

import "testing"

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
			t.Fatalf("expected %q to be valid, got error: %v", name, err)
		}
	}

	invalid := []string{
		"",
		"../../etc/passwd",
		"name/with/slash",
		"bad;name",
		"foo'bar",
		"name with ' quote",
	}

	for _, name := range invalid {
		if err := validateSoftwareName(name); err == nil {
			t.Fatalf("expected %q to be invalid", name)
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

	if !isProtectedLinuxPackage("systemd") {
		t.Fatal("expected systemd to be protected")
	}
	if !isProtectedLinuxPackage("kernel-default") {
		t.Fatal("expected kernel-default to be protected")
	}
	if isProtectedLinuxPackage("google-chrome-stable") {
		t.Fatal("expected google-chrome-stable to be allowed")
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
