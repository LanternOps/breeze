package tools

import (
	"encoding/json"
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
