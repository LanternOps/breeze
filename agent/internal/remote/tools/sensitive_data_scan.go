package tools

import (
	"bufio"
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	defaultSensitiveMaxFileSizeBytes = int64(5 * 1024 * 1024)
	maxSensitiveMaxFileSizeBytes     = int64(100 * 1024 * 1024)
	defaultSensitiveTimeoutSeconds   = 120
	defaultSensitiveWorkerCap        = 8
	maxSensitiveWorkers              = 32
	maxSensitiveFindings             = 5000
	maxSensitiveErrors               = 200
	sensitiveStreamChunkBytes        = 64 * 1024
	sensitiveBoundaryOverlapBytes    = 256
)

var sensitiveDefaultExtensions = map[string]struct{}{
	".txt": {}, ".md": {}, ".rtf": {}, ".log": {}, ".csv": {}, ".json": {}, ".yaml": {}, ".yml": {},
	".xml": {}, ".ini": {}, ".conf": {}, ".cfg": {}, ".env": {}, ".sql": {}, ".ps1": {}, ".bat": {},
	".sh": {}, ".zsh": {}, ".bash": {}, ".js": {}, ".ts": {}, ".go": {}, ".py": {}, ".java": {},
	".php": {}, ".rb": {}, ".cs": {}, ".html": {}, ".htm": {}, ".pem": {}, ".key": {}, ".crt": {},
}

type sensitivePattern struct {
	id       string
	dataType string
	re       *regexp.Regexp
}

type sensitiveScopeConfig struct {
	includePaths          []string
	excludePaths          []string
	suppressPaths         []string
	suppressPatternIDs    map[string]struct{}
	suppressFilePathRegex []*regexp.Regexp
	ruleToggles           map[string]bool
	fileTypes             map[string]struct{}
	maxFileSizeBytes      int64
	timeoutSeconds        int
	workers               int
}

type SensitiveDataScanError struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

type SensitiveDataFinding struct {
	FilePath       string  `json:"filePath"`
	DataType       string  `json:"dataType"`
	PatternID      string  `json:"patternId"`
	MatchCount     int     `json:"matchCount"`
	Risk           string  `json:"risk"`
	Confidence     float64 `json:"confidence"`
	FileOwner      string  `json:"fileOwner,omitempty"`
	FileModifiedAt string  `json:"fileModifiedAt,omitempty"`
}

type SensitiveDataScanSummary struct {
	FilesScanned   int                      `json:"filesScanned"`
	FilesSkipped   int                      `json:"filesSkipped"`
	BytesScanned   int64                    `json:"bytesScanned"`
	FindingsCount  int                      `json:"findingsCount"`
	TimedOut       bool                     `json:"timedOut"`
	Partial        bool                     `json:"partial"`
	Errors         []SensitiveDataScanError `json:"errors"`
	DurationMs     int64                    `json:"durationMs"`
	DetectionClass []string                 `json:"detectionClasses"`
}

type SensitiveDataScanResponse struct {
	ScanID   string                   `json:"scanId,omitempty"`
	PolicyID string                   `json:"policyId,omitempty"`
	Status   string                   `json:"status"`
	Summary  SensitiveDataScanSummary `json:"summary"`
	Findings []SensitiveDataFinding   `json:"findings"`
}

func sensitivePatternCatalog() []sensitivePattern {
	return []sensitivePattern{
		{id: "pii_ssn", dataType: "pii", re: regexp.MustCompile(`\b\d{3}-\d{2}-\d{4}\b`)},
		{id: "pii_email", dataType: "pii", re: regexp.MustCompile(`(?i)\b[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}\b`)},
		{id: "pci_card_number", dataType: "pci", re: regexp.MustCompile(`\b(?:\d[ -]*?){13,19}\b`)},
		{id: "phi_medical_reference", dataType: "phi", re: regexp.MustCompile(`(?i)\b(?:mrn|medical record|diagnosis|patient id)\s*[:#-]?\s*[A-Z0-9-]{5,}\b`)},
		{id: "credential_aws_access_key", dataType: "credential", re: regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`)},
		{id: "credential_private_key", dataType: "credential", re: regexp.MustCompile(`(?i)-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----`)},
		{id: "credential_secret_assignment", dataType: "credential", re: regexp.MustCompile(`(?i)(password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*["'][^"'\n]{6,}["']`)},
		{id: "financial_account_reference", dataType: "financial", re: regexp.MustCompile(`(?i)\b(?:routing|account)\s*(?:number|no)?\s*[:#-]?\s*\d{6,17}\b`)},
		{id: "financial_iban", dataType: "financial", re: regexp.MustCompile(`\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b`)},
	}
}

func parseSensitiveScope(payload map[string]any) sensitiveScopeConfig {
	scope := sensitiveScopeConfig{
		includePaths:          resolveDefaultSensitiveIncludePaths(),
		excludePaths:          defaultSensitiveExcludePaths(),
		suppressPaths:         nil,
		suppressPatternIDs:    map[string]struct{}{},
		suppressFilePathRegex: nil,
		ruleToggles:           map[string]bool{},
		fileTypes:             sensitiveDefaultExtensions,
		maxFileSizeBytes:      defaultSensitiveMaxFileSizeBytes,
		timeoutSeconds:        defaultSensitiveTimeoutSeconds,
		workers:               clampInt(runtime.NumCPU(), 2, defaultSensitiveWorkerCap),
	}

	rawScope, hasScope := payload["scope"].(map[string]any)
	if hasScope {
		if includes := toStringSlice(rawScope["includePaths"]); len(includes) > 0 {
			scope.includePaths = normalizePaths(includes)
		}
		if _, hasExcludes := rawScope["excludePaths"]; hasExcludes {
			excludes := toStringSlice(rawScope["excludePaths"])
			scope.excludePaths = normalizePaths(excludes)
		}
		if suppressPaths := toStringSlice(rawScope["suppressPaths"]); len(suppressPaths) > 0 {
			scope.suppressPaths = normalizePaths(suppressPaths)
		}
		if suppressPatternIDs := toLowerStringSet(rawScope["suppressPatternIds"]); len(suppressPatternIDs) > 0 {
			scope.suppressPatternIDs = suppressPatternIDs
		}
		if suppressRegex := compileRegexSlice(rawScope["suppressFilePathRegex"]); len(suppressRegex) > 0 {
			scope.suppressFilePathRegex = suppressRegex
		}
		if toggles := toLowerStringBoolMap(rawScope["ruleToggles"]); len(toggles) > 0 {
			scope.ruleToggles = toggles
		}
		if fileTypes := toFileTypeSet(rawScope["fileTypes"]); len(fileTypes) > 0 {
			scope.fileTypes = fileTypes
		}
		if v := toInt64(rawScope["maxFileSizeBytes"]); v > 0 {
			scope.maxFileSizeBytes = v
		}
		if v := toInt(rawScope["timeoutSeconds"]); v > 0 {
			scope.timeoutSeconds = v
		}
		if v := toInt(rawScope["workers"]); v > 0 {
			scope.workers = v
		}
	}

	if v := toInt64(payload["maxFileSizeBytes"]); v > 0 {
		scope.maxFileSizeBytes = v
	}
	if v := toInt(payload["timeoutSeconds"]); v > 0 {
		scope.timeoutSeconds = v
	}
	if v := toInt(payload["workers"]); v > 0 {
		scope.workers = v
	}

	scope.maxFileSizeBytes = clampInt64(scope.maxFileSizeBytes, 1024, maxSensitiveMaxFileSizeBytes)
	scope.timeoutSeconds = clampInt(scope.timeoutSeconds, 5, 1800)
	scope.workers = clampInt(scope.workers, 1, maxSensitiveWorkers)
	scope.suppressPaths = normalizePaths(scope.suppressPaths)
	return scope
}

func resolveDefaultSensitiveIncludePaths() []string {
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		if runtime.GOOS == "windows" {
			if profile := strings.TrimSpace(os.Getenv("USERPROFILE")); profile != "" {
				home = profile
			}
		}
	}
	if strings.TrimSpace(home) == "" {
		if runtime.GOOS == "windows" {
			return []string{`C:\Users`}
		}
		return []string{"/home", "/Users"}
	}

	switch runtime.GOOS {
	case "windows":
		return []string{
			home,
			filepath.Join(home, "Desktop"),
			filepath.Join(home, "Documents"),
			filepath.Join(home, "Downloads"),
		}
	default:
		return []string{
			home,
			filepath.Join(home, "Desktop"),
			filepath.Join(home, "Documents"),
			filepath.Join(home, "Downloads"),
		}
	}
}

func defaultSensitiveExcludePaths() []string {
	switch runtime.GOOS {
	case "windows":
		return []string{
			`C:\Windows`,
			`C:\Program Files`,
			`C:\Program Files (x86)`,
			`C:\ProgramData`,
			`C:\$Recycle.Bin`,
		}
	default:
		return []string{
			"/System",
			"/Library",
			"/Applications",
			"/usr",
			"/bin",
			"/sbin",
			"/proc",
			"/dev",
			"/run",
			"/tmp",
		}
	}
}

func normalizePaths(paths []string) []string {
	seen := make(map[string]struct{}, len(paths))
	result := make([]string, 0, len(paths))
	for _, item := range paths {
		trimmed := strings.TrimSpace(item)
		if trimmed == "" {
			continue
		}
		cleaned := filepath.Clean(trimmed)
		key := strings.ToLower(cleaned)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, cleaned)
	}
	return result
}

func toStringSlice(value any) []string {
	if raw, ok := value.([]string); ok {
		out := make([]string, 0, len(raw))
		for _, entry := range raw {
			trimmed := strings.TrimSpace(entry)
			if trimmed != "" {
				out = append(out, trimmed)
			}
		}
		return out
	}
	raw, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, entry := range raw {
		if s, ok := entry.(string); ok {
			trimmed := strings.TrimSpace(s)
			if trimmed != "" {
				out = append(out, trimmed)
			}
		}
	}
	return out
}

func toInt(value any) int {
	switch n := value.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	default:
		return 0
	}
}

func toInt64(value any) int64 {
	switch n := value.(type) {
	case int:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	default:
		return 0
	}
}

func toFileTypeSet(value any) map[string]struct{} {
	items := toStringSlice(value)
	if len(items) == 0 {
		return nil
	}
	out := make(map[string]struct{}, len(items))
	for _, item := range items {
		ext := strings.ToLower(strings.TrimSpace(item))
		if ext == "" {
			continue
		}
		if !strings.HasPrefix(ext, ".") {
			ext = "." + ext
		}
		out[ext] = struct{}{}
	}
	return out
}

func toLowerStringSet(value any) map[string]struct{} {
	items := toStringSlice(value)
	if len(items) == 0 {
		return nil
	}
	out := make(map[string]struct{}, len(items))
	for _, item := range items {
		key := strings.ToLower(strings.TrimSpace(item))
		if key == "" {
			continue
		}
		out[key] = struct{}{}
	}
	return out
}

func toLowerStringBoolMap(value any) map[string]bool {
	raw, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	out := make(map[string]bool, len(raw))
	for k, v := range raw {
		key := strings.ToLower(strings.TrimSpace(k))
		if key == "" {
			continue
		}
		enabled, ok := v.(bool)
		if !ok {
			continue
		}
		out[key] = enabled
	}
	return out
}

func compileRegexSlice(value any) []*regexp.Regexp {
	items := toStringSlice(value)
	if len(items) == 0 {
		return nil
	}
	out := make([]*regexp.Regexp, 0, len(items))
	for _, item := range items {
		re, err := regexp.Compile(item)
		if err != nil {
			continue
		}
		out = append(out, re)
	}
	return out
}

func clampInt64(value, min, max int64) int64 {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func parseDetectionClasses(payload map[string]any) []string {
	raw := GetPayloadStringSlice(payload, "detectionClasses")
	if len(raw) == 0 {
		return []string{"credential"}
	}
	allowed := map[string]struct{}{
		"pii":        {},
		"pci":        {},
		"phi":        {},
		"credential": {},
		"financial":  {},
	}
	seen := make(map[string]struct{}, len(raw))
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		key := strings.ToLower(strings.TrimSpace(item))
		if _, ok := allowed[key]; !ok {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, key)
	}
	if len(out) == 0 {
		return []string{"credential"}
	}
	return out
}

func buildActiveSensitivePatterns(classes []string, scope sensitiveScopeConfig) []sensitivePattern {
	enabled := make(map[string]struct{}, len(classes))
	for _, class := range classes {
		enabled[class] = struct{}{}
	}

	patterns := sensitivePatternCatalog()
	active := make([]sensitivePattern, 0, len(patterns))
	for _, pattern := range patterns {
		if _, ok := enabled[pattern.dataType]; ok {
			if isPatternSuppressed(pattern, scope) {
				continue
			}
			active = append(active, pattern)
		}
	}
	return active
}

func isPatternSuppressed(pattern sensitivePattern, scope sensitiveScopeConfig) bool {
	if _, ok := scope.suppressPatternIDs[strings.ToLower(pattern.id)]; ok {
		return true
	}
	if toggle, ok := scope.ruleToggles[strings.ToLower(pattern.id)]; ok && !toggle {
		return true
	}
	if toggle, ok := scope.ruleToggles[strings.ToLower(pattern.dataType)]; ok && !toggle {
		return true
	}
	return false
}

func shouldExcludeSensitivePath(path string, excludes []string) bool {
	cleaned := filepath.Clean(path)
	for _, exclude := range excludes {
		if pathHasPrefix(cleaned, exclude) {
			return true
		}
	}
	return false
}

func shouldSuppressSensitivePath(path string, scope sensitiveScopeConfig) bool {
	if shouldExcludeSensitivePath(path, scope.suppressPaths) {
		return true
	}
	for _, re := range scope.suppressFilePathRegex {
		if re.MatchString(path) {
			return true
		}
	}
	return false
}

func pathHasPrefix(path string, prefix string) bool {
	pathClean := filepath.Clean(path)
	prefixClean := filepath.Clean(prefix)
	if runtime.GOOS == "windows" {
		pathClean = strings.ToLower(pathClean)
		prefixClean = strings.ToLower(prefixClean)
	}
	if pathClean == prefixClean {
		return true
	}
	if strings.HasPrefix(pathClean, prefixClean+string(os.PathSeparator)) {
		return true
	}
	return false
}

func isLikelyBinary(data []byte) bool {
	if len(data) == 0 {
		return false
	}
	limit := len(data)
	if limit > 512 {
		limit = 512
	}
	nonText := 0
	for _, b := range data[:limit] {
		if b == 0 {
			return true
		}
		if b < 9 || (b > 13 && b < 32) {
			nonText++
		}
	}
	return float64(nonText)/float64(limit) > 0.3
}

func countSensitiveMatchesWithOffset(pattern sensitivePattern, content string, minStart int) int {
	indexes := pattern.re.FindAllStringIndex(content, -1)
	if pattern.id != "pci_card_number" {
		count := 0
		for _, idx := range indexes {
			if len(idx) != 2 || idx[1] <= minStart {
				continue
			}
			count++
		}
		return count
	}

	count := 0
	for _, idx := range indexes {
		if len(idx) != 2 || idx[1] <= minStart {
			continue
		}
		candidate := content[idx[0]:idx[1]]
		digits := extractDigits(candidate)
		if len(digits) < 13 || len(digits) > 19 {
			continue
		}
		if luhnValid(digits) {
			count++
		}
	}
	return count
}

func extractDigits(value string) string {
	builder := strings.Builder{}
	builder.Grow(len(value))
	for _, r := range value {
		if r >= '0' && r <= '9' {
			builder.WriteRune(r)
		}
	}
	return builder.String()
}

func luhnValid(digits string) bool {
	sum := 0
	double := false
	for i := len(digits) - 1; i >= 0; i-- {
		d := int(digits[i] - '0')
		if double {
			d *= 2
			if d > 9 {
				d -= 9
			}
		}
		sum += d
		double = !double
	}
	return sum > 0 && sum%10 == 0
}

func baseSensitiveRisk(dataType string) string {
	switch dataType {
	case "credential", "pci":
		return "critical"
	case "phi", "financial":
		return "high"
	case "pii":
		return "medium"
	default:
		return "low"
	}
}

func bumpRisk(risk string) string {
	switch risk {
	case "low":
		return "medium"
	case "medium":
		return "high"
	case "high":
		return "critical"
	default:
		return risk
	}
}

func computeSensitiveRisk(dataType, path string) string {
	risk := baseSensitiveRisk(dataType)
	lowerPath := strings.ToLower(path)
	if strings.Contains(lowerPath, "desktop") || strings.Contains(lowerPath, "downloads") || strings.Contains(lowerPath, "public") {
		return bumpRisk(risk)
	}
	return risk
}

func clampFloat64(value, min, max float64) float64 {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func computeSensitiveConfidence(patternID, dataType string, matchCount int, path string) float64 {
	baseByPattern := map[string]float64{
		"credential_private_key":       0.99,
		"credential_aws_access_key":    0.98,
		"credential_secret_assignment": 0.86,
		"pci_card_number":              0.92,
		"pii_ssn":                      0.88,
		"pii_email":                    0.74,
		"phi_medical_reference":        0.8,
		"financial_account_reference":  0.84,
		"financial_iban":               0.9,
	}
	confidence, ok := baseByPattern[patternID]
	if !ok {
		switch dataType {
		case "credential":
			confidence = 0.9
		case "pci":
			confidence = 0.88
		case "phi":
			confidence = 0.8
		case "financial":
			confidence = 0.78
		case "pii":
			confidence = 0.72
		default:
			confidence = 0.6
		}
	}

	if matchCount >= 3 {
		confidence += 0.03
	}
	lowerPath := strings.ToLower(path)
	if strings.Contains(lowerPath, "desktop") || strings.Contains(lowerPath, "downloads") || strings.Contains(lowerPath, "public") {
		confidence += 0.02
	}

	return clampFloat64(confidence, 0.5, 0.995)
}

func scanSensitiveFile(path string, patterns []sensitivePattern, scope sensitiveScopeConfig) (int, int, int64, []SensitiveDataFinding, []SensitiveDataScanError) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, 1, 0, nil, []SensitiveDataScanError{{Path: path, Error: err.Error()}}
	}
	if !info.Mode().IsRegular() {
		return 0, 1, 0, nil, nil
	}
	if info.Size() <= 0 {
		return 0, 1, 0, nil, nil
	}
	if info.Size() > scope.maxFileSizeBytes {
		return 0, 1, 0, nil, nil
	}
	if shouldSuppressSensitivePath(path, scope) {
		return 0, 1, 0, nil, nil
	}

	file, err := os.Open(path)
	if err != nil {
		return 0, 1, 0, nil, []SensitiveDataScanError{{Path: path, Error: err.Error()}}
	}
	defer file.Close()

	probe := make([]byte, 1024)
	n, readErr := file.Read(probe)
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		return 0, 1, 0, nil, []SensitiveDataScanError{{Path: path, Error: readErr.Error()}}
	}
	if n > 0 && isLikelyBinary(probe[:n]) {
		return 0, 1, 0, nil, nil
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return 0, 1, 0, nil, []SensitiveDataScanError{{Path: path, Error: err.Error()}}
	}

	reader := bufio.NewReaderSize(file, sensitiveStreamChunkBytes)
	totals := make(map[string]int, len(patterns))
	tail := make([]byte, 0, sensitiveBoundaryOverlapBytes)
	firstChunk := true

	for {
		chunk := make([]byte, sensitiveStreamChunkBytes)
		n, err := reader.Read(chunk)
		if n > 0 {
			combined := make([]byte, 0, len(tail)+n)
			combined = append(combined, tail...)
			combined = append(combined, chunk[:n]...)
			combinedText := string(combined)
			minStart := len(tail)
			if firstChunk {
				minStart = 0
				firstChunk = false
			}

			for _, pattern := range patterns {
				matches := countSensitiveMatchesWithOffset(pattern, combinedText, minStart)
				if matches > 0 {
					totals[pattern.id] += matches
				}
			}

			if len(combined) > sensitiveBoundaryOverlapBytes {
				tail = append(tail[:0], combined[len(combined)-sensitiveBoundaryOverlapBytes:]...)
			} else {
				tail = append(tail[:0], combined...)
			}
		}

		if err == nil {
			continue
		}
		if errors.Is(err, io.EOF) {
			break
		}
		return 0, 1, 0, nil, []SensitiveDataScanError{{Path: path, Error: err.Error()}}
	}

	owner := getFileOwner(info)
	modifiedAt := info.ModTime().UTC().Format(time.RFC3339)
	findings := make([]SensitiveDataFinding, 0, 4)
	for _, pattern := range patterns {
		matchCount := totals[pattern.id]
		if matchCount <= 0 {
			continue
		}
		finding := SensitiveDataFinding{
			FilePath:       path,
			DataType:       pattern.dataType,
			PatternID:      pattern.id,
			MatchCount:     matchCount,
			Risk:           computeSensitiveRisk(pattern.dataType, path),
			Confidence:     computeSensitiveConfidence(pattern.id, pattern.dataType, matchCount, path),
			FileOwner:      owner,
			FileModifiedAt: modifiedAt,
		}
		findings = append(findings, finding)
	}

	return 1, 0, info.Size(), findings, nil
}

// ScanSensitiveData scans bounded file scope for sensitive data patterns and
// returns metadata-only findings (never raw matched values).
func ScanSensitiveData(payload map[string]any) CommandResult {
	start := time.Now()

	scope := parseSensitiveScope(payload)
	classes := parseDetectionClasses(payload)
	patterns := buildActiveSensitivePatterns(classes, scope)

	scanID := GetPayloadString(payload, "scanId", "")
	policyID := GetPayloadString(payload, "policyId", "")

	if len(patterns) == 0 {
		response := SensitiveDataScanResponse{
			ScanID:   scanID,
			PolicyID: policyID,
			Status:   "completed",
			Summary: SensitiveDataScanSummary{
				FilesScanned:   0,
				FilesSkipped:   0,
				BytesScanned:   0,
				FindingsCount:  0,
				DurationMs:     time.Since(start).Milliseconds(),
				DetectionClass: classes,
				Errors:         []SensitiveDataScanError{},
			},
			Findings: []SensitiveDataFinding{},
		}
		return NewSuccessResult(response, time.Since(start).Milliseconds())
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(scope.timeoutSeconds)*time.Second)
	defer cancel()

	var (
		mu           sync.Mutex
		filesScanned int
		filesSkipped int
		bytesScanned int64
		timedOut     bool
		partial      bool
		findings     = make([]SensitiveDataFinding, 0, 128)
		errorsOut    = make([]SensitiveDataScanError, 0, 32)
	)

	markTimedOut := func() {
		mu.Lock()
		timedOut = true
		partial = true
		mu.Unlock()
	}

	recordErrors := func(items []SensitiveDataScanError) {
		if len(items) == 0 {
			return
		}
		for _, item := range items {
			if len(errorsOut) >= maxSensitiveErrors {
				return
			}
			errorsOut = append(errorsOut, item)
		}
	}

	fileCh := make(chan string, scope.workers*4)
	var wg sync.WaitGroup

	for i := 0; i < scope.workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for path := range fileCh {
				select {
				case <-ctx.Done():
					return
				default:
				}

				scanned, skipped, scannedBytes, found, scanErrs := scanSensitiveFile(path, patterns, scope)

				mu.Lock()
				filesScanned += scanned
				filesSkipped += skipped
				bytesScanned += scannedBytes
				recordErrors(scanErrs)
				if len(found) > 0 {
					remaining := maxSensitiveFindings - len(findings)
					if remaining > 0 {
						if len(found) > remaining {
							findings = append(findings, found[:remaining]...)
							partial = true
						} else {
							findings = append(findings, found...)
						}
					} else {
						partial = true
					}
				}
				mu.Unlock()
			}
		}()
	}

	walkErr := func(root string) error {
		return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				mu.Lock()
				recordErrors([]SensitiveDataScanError{{Path: path, Error: err.Error()}})
				mu.Unlock()
				if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
					markTimedOut()
					return err
				}
				return nil
			}

			select {
			case <-ctx.Done():
				markTimedOut()
				return ctx.Err()
			default:
			}

			if d.IsDir() {
				if shouldExcludeSensitivePath(path, scope.excludePaths) || shouldSuppressSensitivePath(path, scope) {
					return filepath.SkipDir
				}
				return nil
			}

			if shouldExcludeSensitivePath(path, scope.excludePaths) || shouldSuppressSensitivePath(path, scope) {
				mu.Lock()
				filesSkipped++
				mu.Unlock()
				return nil
			}

			ext := strings.ToLower(filepath.Ext(path))
			if len(scope.fileTypes) > 0 {
				if _, ok := scope.fileTypes[ext]; !ok {
					mu.Lock()
					filesSkipped++
					mu.Unlock()
					return nil
				}
			}

			select {
			case fileCh <- path:
				return nil
			case <-ctx.Done():
				markTimedOut()
				return ctx.Err()
			}
		})
	}

	for _, include := range scope.includePaths {
		if shouldExcludeSensitivePath(include, scope.excludePaths) {
			continue
		}
		info, err := os.Stat(include)
		if err != nil {
			mu.Lock()
			recordErrors([]SensitiveDataScanError{{Path: include, Error: err.Error()}})
			mu.Unlock()
			continue
		}
		if !info.IsDir() {
			continue
		}
		if err := walkErr(include); err != nil {
			break
		}
	}

	close(fileCh)
	wg.Wait()

	mu.Lock()
	summary := SensitiveDataScanSummary{
		FilesScanned:   filesScanned,
		FilesSkipped:   filesSkipped,
		BytesScanned:   bytesScanned,
		FindingsCount:  len(findings),
		TimedOut:       timedOut,
		Partial:        partial,
		Errors:         errorsOut,
		DurationMs:     time.Since(start).Milliseconds(),
		DetectionClass: classes,
	}
	resultFindings := make([]SensitiveDataFinding, len(findings))
	copy(resultFindings, findings)
	mu.Unlock()

	response := SensitiveDataScanResponse{
		ScanID:   scanID,
		PolicyID: policyID,
		Status:   "completed",
		Summary:  summary,
		Findings: resultFindings,
	}

	return NewSuccessResult(response, time.Since(start).Milliseconds())
}
