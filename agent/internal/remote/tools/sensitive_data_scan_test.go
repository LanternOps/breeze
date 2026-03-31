package tools

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
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
