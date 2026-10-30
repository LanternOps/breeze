package tools

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func decodeSensitiveScanResult(t *testing.T, result CommandResult) SensitiveDataScanResponse {
	t.Helper()
	if result.Status != "completed" {
		t.Fatalf("expected completed status, got %s (error=%s)", result.Status, result.Error)
	}

	var response SensitiveDataScanResponse
	if err := json.Unmarshal([]byte(result.Stdout), &response); err != nil {
		t.Fatalf("failed to decode response JSON: %v", err)
	}
	return response
}

func TestScanSensitiveDataDoesNotLeakRawSecretValues(t *testing.T) {
	t.Parallel()

	tempDir := t.TempDir()
	filePath := filepath.Join(tempDir, "app.env")
	secretValue := "SuperSecret123!"
	content := `password="` + secretValue + `"` + "\n"
	if err := os.WriteFile(filePath, []byte(content), 0o600); err != nil {
		t.Fatalf("failed to write temp file: %v", err)
	}

	result := ScanSensitiveData(map[string]any{
		"scope": map[string]any{
			"includePaths": []any{tempDir},
			"excludePaths": []any{},
			"fileTypes":    []any{".env"},
			"workers":      1,
		},
		"detectionClasses": []any{"credential"},
	})
	response := decodeSensitiveScanResult(t, result)

	if strings.Contains(result.Stdout, secretValue) {
		t.Fatalf("scan output leaked raw secret value")
	}
	if len(response.Findings) == 0 {
		t.Fatalf("expected at least one finding")
	}
	if response.Findings[0].PatternID == "" {
		t.Fatalf("expected finding pattern ID")
	}
}

func TestScanSensitiveDataHonorsSuppressionsAndRuleToggles(t *testing.T) {
	t.Parallel()

	tempDir := t.TempDir()
	visiblePath := filepath.Join(tempDir, "visible.txt")
	suppressedDir := filepath.Join(tempDir, "suppressed")
	if err := os.MkdirAll(suppressedDir, 0o755); err != nil {
		t.Fatalf("failed to create suppressed directory: %v", err)
	}
	suppressedPath := filepath.Join(suppressedDir, "secret.txt")

	visibleContent := "password=\"abc123456\"\nadmin@example.com\n"
	if err := os.WriteFile(visiblePath, []byte(visibleContent), 0o600); err != nil {
		t.Fatalf("failed to write visible file: %v", err)
	}
	if err := os.WriteFile(suppressedPath, []byte("AKIA1234567890ABCDEF"), 0o600); err != nil {
		t.Fatalf("failed to write suppressed file: %v", err)
	}

	result := ScanSensitiveData(map[string]any{
		"scope": map[string]any{
			"includePaths":          []any{tempDir},
			"excludePaths":          []any{},
			"fileTypes":             []any{".txt"},
			"suppressPaths":         []any{suppressedDir},
			"suppressPatternIds":    []any{"credential_secret_assignment"},
			"suppressFilePathRegex": []any{".*visible\\.txt$"},
			"ruleToggles": map[string]any{
				"pii": false,
			},
			"workers": 1,
		},
		"detectionClasses": []any{"credential", "pii"},
	})
	response := decodeSensitiveScanResult(t, result)

	if len(response.Findings) != 0 {
		t.Fatalf("expected no findings after suppressions/rule toggles, got %d", len(response.Findings))
	}
	if response.Summary.FilesSkipped == 0 {
		t.Fatalf("expected skipped files due to suppressions")
	}
}

func TestScanSensitiveDataStreamDetectsChunkBoundaryMatch(t *testing.T) {
	t.Parallel()

	tempDir := t.TempDir()
	filePath := filepath.Join(tempDir, "boundary.txt")
	prefix := strings.Repeat("A", sensitiveStreamChunkBytes-3)
	content := prefix + " AKIA1234567890ABCDEF " + "\n"
	if err := os.WriteFile(filePath, []byte(content), 0o600); err != nil {
		t.Fatalf("failed to write boundary test file: %v", err)
	}

	result := ScanSensitiveData(map[string]any{
		"scope": map[string]any{
			"includePaths": []any{tempDir},
			"excludePaths": []any{},
			"fileTypes":    []any{".txt"},
			"workers":      1,
		},
		"detectionClasses": []any{"credential"},
	})
	response := decodeSensitiveScanResult(t, result)

	matched := false
	for _, finding := range response.Findings {
		if finding.PatternID == "credential_aws_access_key" && finding.MatchCount > 0 {
			matched = true
			break
		}
	}
	if !matched {
		t.Fatalf("expected chunk-boundary AWS key finding")
	}
}

func TestParseSensitiveScopeCapsPathAndRegexInputs(t *testing.T) {
	t.Parallel()

	includePaths := make([]any, 0, maxSensitiveScopePaths+10)
	regexes := make([]any, 0, maxSensitiveSuppressionRegexes+10)
	for i := 0; i < maxSensitiveScopePaths+10; i++ {
		includePaths = append(includePaths, fmt.Sprintf("/tmp/include-%d", i))
	}
	for i := 0; i < maxSensitiveSuppressionRegexes+10; i++ {
		regexes = append(regexes, fmt.Sprintf("include-%d", i))
	}

	scope := parseSensitiveScope(map[string]any{
		"scope": map[string]any{
			"includePaths":          includePaths,
			"suppressFilePathRegex": regexes,
		},
	})

	if len(scope.includePaths) != maxSensitiveScopePaths {
		t.Fatalf("expected %d include paths, got %d", maxSensitiveScopePaths, len(scope.includePaths))
	}
	if len(scope.suppressFilePathRegex) != maxSensitiveSuppressionRegexes {
		t.Fatalf("expected %d regexes, got %d", maxSensitiveSuppressionRegexes, len(scope.suppressFilePathRegex))
	}
}

func TestParseSensitiveScopeCapsRuleTogglesAndFileTypes(t *testing.T) {
	t.Parallel()

	fileTypes := make([]any, 0, maxSensitiveFileTypes+10)
	toggles := make(map[string]any, maxSensitiveRuleToggles+10)
	for i := 0; i < maxSensitiveFileTypes+10; i++ {
		fileTypes = append(fileTypes, fmt.Sprintf(".ext%d", i))
	}
	for i := 0; i < maxSensitiveRuleToggles+10; i++ {
		toggles[fmt.Sprintf("rule-%d", i)] = true
	}

	scope := parseSensitiveScope(map[string]any{
		"scope": map[string]any{
			"fileTypes":   fileTypes,
			"ruleToggles": toggles,
		},
	})

	if len(scope.fileTypes) != maxSensitiveFileTypes {
		t.Fatalf("expected %d file types, got %d", maxSensitiveFileTypes, len(scope.fileTypes))
	}
	if len(scope.ruleToggles) != maxSensitiveRuleToggles {
		t.Fatalf("expected %d rule toggles, got %d", maxSensitiveRuleToggles, len(scope.ruleToggles))
	}
}

func TestParseSensitiveScopeSkipsOversizedRegexPatterns(t *testing.T) {
	t.Parallel()

	scope := parseSensitiveScope(map[string]any{
		"scope": map[string]any{
			"suppressFilePathRegex": []any{
				strings.Repeat("a", maxSensitiveRegexPatternBytes+1),
				"visible",
			},
		},
	})

	if len(scope.suppressFilePathRegex) != 1 {
		t.Fatalf("expected only valid regex patterns to be compiled, got %d", len(scope.suppressFilePathRegex))
	}
}

// #10380: the agent runs as root/SYSTEM, so the service account's own home
// (C:\Windows\system32\config\systemprofile, /var/root, /root) is never where
// user data lives. The default scope enumerates the device's user profiles.
func TestDefaultSensitiveIncludePathsEnumeratesUserProfileFolders(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	mk := func(parts ...string) string {
		p := filepath.Join(append([]string{root}, parts...)...)
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", p, err)
		}
		return p
	}
	aliceDesktop := mk("alice", "Desktop")
	aliceDocuments := mk("alice", "Documents")
	mk("alice", "AppData", "Local")
	bobDownloads := mk("bob", "Downloads")
	mk("Default", "Documents")
	mk("Default User", "Desktop")
	mk("carol") // a profile with none of the common folders
	if err := os.WriteFile(filepath.Join(root, "desktop.ini"), []byte("x"), 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}

	got := defaultSensitiveIncludePathsUnder([]string{root, filepath.Join(root, "missing-root")})
	want := []string{aliceDesktop, aliceDocuments, bobDownloads}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("default include paths = %v, want %v", got, want)
	}
}

func TestSensitiveProfileRootsFor(t *testing.T) {
	t.Parallel()

	env := func(vars map[string]string) func(string) string {
		return func(k string) string { return vars[k] }
	}
	cases := []struct {
		name string
		goos string
		vars map[string]string
		want string
	}{
		{"windows public", "windows", map[string]string{"PUBLIC": `C:\Users\Public`, "SystemDrive": "C:"}, `C:\Users`},
		{"windows profiles on D", "windows", map[string]string{"PUBLIC": `D:\Profiles\Public\`}, `D:\Profiles`},
		{"windows no public", "windows", map[string]string{"SystemDrive": "E:"}, `E:\Users`},
		{"windows nothing set", "windows", map[string]string{}, `C:\Users`},
		{"darwin", "darwin", map[string]string{"HOME": "/var/root"}, "/Users"},
		{"linux", "linux", map[string]string{"HOME": "/root"}, "/home"},
	}
	for _, tc := range cases {
		got := sensitiveProfileRootsFor(tc.goos, env(tc.vars))
		if len(got) != 1 || got[0] != tc.want {
			t.Fatalf("%s: roots = %v, want [%s]", tc.name, got, tc.want)
		}
	}
}

// Security review of #10380: the agent runs as SYSTEM/root, so following a
// link a user planted in their own profile would read files that user cannot.
func TestDefaultSensitiveIncludePathsSkipLinkedProfilesAndFolders(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation is unreliable without privilege on Windows CI")
	}
	t.Parallel()

	root := t.TempDir()
	privileged := t.TempDir()
	if err := os.MkdirAll(filepath.Join(privileged, "Documents"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "mallory"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Profile folder that is a link to a privileged directory.
	if err := os.Symlink(privileged, filepath.Join(root, "mallory", "Documents")); err != nil {
		t.Fatal(err)
	}
	// Profile entry that is itself a link.
	if err := os.Symlink(privileged, filepath.Join(root, "linkedprofile")); err != nil {
		t.Fatal(err)
	}
	realDesktop := filepath.Join(root, "mallory", "Desktop")
	if err := os.MkdirAll(realDesktop, 0o755); err != nil {
		t.Fatal(err)
	}

	got := defaultSensitiveIncludePathsUnder([]string{root})
	if strings.Join(got, "|") != realDesktop {
		t.Fatalf("default include paths = %v, want only %s", got, realDesktop)
	}
}

func TestScanSensitiveDataDoesNotFollowLinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation is unreliable without privilege on Windows CI")
	}
	t.Parallel()

	privileged := t.TempDir()
	secret := filepath.Join(privileged, "secret.txt")
	if err := os.WriteFile(secret, []byte("AKIA1234567890ABCDEF\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	if err := os.Symlink(secret, filepath.Join(root, "innocent.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(privileged, filepath.Join(root, "subdir")); err != nil {
		t.Fatal(err)
	}

	result := ScanSensitiveData(map[string]any{
		"scope": map[string]any{
			"includePaths": []any{root},
			"excludePaths": []any{},
			"fileTypes":    []any{".txt"},
			"workers":      1,
		},
		"detectionClasses": []any{"credential"},
	})
	response := decodeSensitiveScanResult(t, result)
	if len(response.Findings) != 0 || response.Summary.FilesScanned != 0 {
		t.Fatalf("scan followed a link: filesScanned=%d findings=%+v", response.Summary.FilesScanned, response.Findings)
	}
	if response.Summary.FilesSkipped == 0 {
		t.Fatalf("expected the links to be counted as skipped")
	}
	// Visible in the summary, so a folder full of links / OneDrive
	// placeholders does not read as an unexplained near-empty scan.
	if response.Summary.LinksSkipped != 2 {
		t.Fatalf("linksSkipped = %d, want 2 (file link + directory link)", response.Summary.LinksSkipped)
	}

	// A root that is itself a link is refused and reported, not walked.
	linkRoot := filepath.Join(t.TempDir(), "linkroot")
	if err := os.Symlink(privileged, linkRoot); err != nil {
		t.Fatal(err)
	}
	result = ScanSensitiveData(map[string]any{
		"scope": map[string]any{
			"includePaths": []any{linkRoot},
			"excludePaths": []any{},
			"workers":      1,
		},
		"detectionClasses": []any{"credential"},
	})
	if result.Status != "failed" || !strings.Contains(result.Stdout, "link") {
		t.Fatalf("expected a failed scan reporting the linked root, got %s: %s", result.Status, result.Stdout)
	}
}

func TestScanSensitiveDataUnreadableRootIsNotACleanScan(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("needs POSIX permissions and a non-root user")
	}
	t.Parallel()

	root := filepath.Join(t.TempDir(), "locked")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(root, 0o755) })

	result := ScanSensitiveData(map[string]any{
		"scope": map[string]any{
			"includePaths": []any{root},
			"excludePaths": []any{},
			"workers":      1,
		},
		"detectionClasses": []any{"credential"},
	})
	if result.Status != "failed" {
		t.Fatalf("expected failed when the only root cannot be read, got %s", result.Status)
	}
}

func TestScanSensitiveDataMixedRootsStillComplete(t *testing.T) {
	t.Parallel()

	good := t.TempDir()
	if err := os.WriteFile(filepath.Join(good, "a.txt"), []byte("AKIA1234567890ABCDEF\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(t.TempDir(), "missing")
	result := ScanSensitiveData(map[string]any{
		"scope": map[string]any{
			"includePaths": []any{good, missing},
			"excludePaths": []any{},
			"fileTypes":    []any{".txt"},
			"workers":      1,
		},
		"detectionClasses": []any{"credential"},
	})
	response := decodeSensitiveScanResult(t, result)
	if response.Summary.FilesScanned != 1 || len(response.Findings) == 0 {
		t.Fatalf("expected the readable root to be scanned, got %+v", response.Summary)
	}
	if len(response.Summary.Errors) == 0 {
		t.Fatalf("expected the missing root to be reported")
	}
}

func TestScanSensitiveDataNoProfileFoldersRecordsReason(t *testing.T) {
	t.Parallel()

	result := scanSensitiveDataWithProfileRoots(map[string]any{
		"detectionClasses": []any{"credential"},
	}, []string{t.TempDir()})
	if result.Status != "failed" {
		t.Fatalf("expected failed, got %s", result.Status)
	}
	var response SensitiveDataScanResponse
	if err := json.Unmarshal([]byte(result.Stdout), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Summary.Errors) == 0 || !strings.Contains(response.Summary.Errors[0].Error, "Desktop, Documents or Downloads") {
		t.Fatalf("expected the reason in summary.errors so the server records it, got %+v", response.Summary.Errors)
	}
}

// #10380: a scan that walked no folder at all must not read as a clean,
// completed scan with zero findings.
func TestScanSensitiveDataFailsWhenNoIncludePathCanBeWalked(t *testing.T) {
	t.Parallel()

	tempDir := t.TempDir()
	missing := filepath.Join(tempDir, "does-not-exist")
	excluded := filepath.Join(tempDir, "excluded")
	if err := os.MkdirAll(excluded, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	notADir := filepath.Join(tempDir, "file.txt")
	if err := os.WriteFile(notADir, []byte("AKIA1234567890ABCDEF"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	result := ScanSensitiveData(map[string]any{
		"scope": map[string]any{
			"includePaths": []any{missing, excluded, notADir},
			"excludePaths": []any{excluded},
			"workers":      1,
		},
		"detectionClasses": []any{"credential"},
	})
	if result.Status != "failed" {
		t.Fatalf("expected failed status when nothing was scanned, got %s", result.Status)
	}
	if result.ExitCode == 0 {
		t.Fatalf("expected nonzero exit code on failure")
	}
	if !strings.Contains(result.Error, "no folder in the scan scope") {
		t.Fatalf("unexpected error: %q", result.Error)
	}
	var response SensitiveDataScanResponse
	if err := json.Unmarshal([]byte(result.Stdout), &response); err != nil {
		t.Fatalf("expected JSON summary on stdout so the server records why: %v", err)
	}
	if response.Status != "failed" {
		t.Fatalf("response status = %q, want failed", response.Status)
	}
	if response.Summary.FilesScanned != 0 {
		t.Fatalf("filesScanned = %d, want 0", response.Summary.FilesScanned)
	}
	paths := map[string]bool{}
	for _, e := range response.Summary.Errors {
		paths[e.Path] = true
	}
	for _, p := range []string{missing, excluded, notADir} {
		if !paths[filepath.Clean(p)] {
			t.Fatalf("expected an error entry for %s, got %+v", p, response.Summary.Errors)
		}
	}
}

func TestScanSensitiveDataEmptyFolderStillCompletes(t *testing.T) {
	t.Parallel()

	result := ScanSensitiveData(map[string]any{
		"scope": map[string]any{
			"includePaths": []any{t.TempDir()},
			"excludePaths": []any{},
			"workers":      1,
		},
		"detectionClasses": []any{"credential"},
	})
	response := decodeSensitiveScanResult(t, result)
	if response.Summary.FilesScanned != 0 || len(response.Findings) != 0 {
		t.Fatalf("expected an empty but completed scan, got %+v", response.Summary)
	}
}
