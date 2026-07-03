package tools

import (
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"strconv"
	"strings"
)

// DetectionRule describes one clause in a software detection rule set.
// A package is considered detected only when ALL clauses evaluate to true.
type DetectionRule struct {
	Type string `json:"type"` // "registry" | "file_exists" | "msi_product_code" | "file_version"

	// registry fields
	Hive      string `json:"hive,omitempty"`      // HKLM (default) | HKCU | HKCR | HKU | HKCC
	Path      string `json:"path,omitempty"`      // registry key path, or file/dir path for file_exists / file_version
	ValueName string `json:"valueName,omitempty"` // optional value name under the key
	ValueData string `json:"valueData,omitempty"` // optional exact-match expected data

	// msi_product_code fields
	ProductCode string `json:"productCode,omitempty"` // GUID, braces optional

	// file_version fields
	Operator string `json:"operator,omitempty"` // ">=" | ">" | "==" | "<=" | "<"
	Version  string `json:"version,omitempty"`  // dotted numeric target version, e.g. "1.2.3.4"
}

// DetectionOutcome is the result of evaluating a rule set on this device.
type DetectionOutcome struct {
	// Detected is true only when Supported is true and ALL clauses matched.
	Detected bool
	// Supported is false when at least one clause type is not evaluable on this
	// platform (e.g. a registry/msi clause on non-Windows). Callers must then
	// fall back to exit-code behaviour — never silently treat unsupported as
	// pass or fail.
	Supported bool
	// Detail is a short human-readable explanation for logs/output.
	Detail string
}

// parseDetectionRules extracts detection rules from the command payload.
// payload["detectionRules"] must be []any of map[string]any (the natural
// shape after JSON→map[string]any decode). Clauses with an empty Type are
// silently skipped. Returns nil for absent, empty, or entirely-garbage input.
func parseDetectionRules(payload map[string]any) []DetectionRule {
	raw, ok := payload["detectionRules"]
	if !ok {
		return nil
	}
	slice, ok := raw.([]any)
	if !ok || len(slice) == 0 {
		return nil
	}

	var rules []DetectionRule
	for _, item := range slice {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		rule := DetectionRule{
			Type:        detectionStringField(m, "type"),
			Hive:        detectionStringField(m, "hive"),
			Path:        detectionStringField(m, "path"),
			ValueName:   detectionStringField(m, "valueName"),
			ValueData:   detectionStringField(m, "valueData"),
			ProductCode: detectionStringField(m, "productCode"),
			Operator:    detectionStringField(m, "operator"),
			Version:     detectionStringField(m, "version"),
		}
		if rule.Type == "" {
			continue
		}
		rules = append(rules, rule)
	}
	return rules
}

// detectionStringField is a nil-safe type-asserting field reader for map[string]any
// used by parseDetectionRules.
func detectionStringField(m map[string]any, key string) string {
	if v, ok := m[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// evaluateFileExists reports whether path exists as a file or directory.
//
// A stat error is NOT blindly read as "absent": only a genuine not-exist error
// counts as a clean negative (matched=false, supported=true). Any other error
// (permission denied, transient I/O) means we cannot determine presence, so we
// report supported=false and let the caller fall back to exit-code behavior
// rather than mis-reporting an installed package as missing (#2022).
func evaluateFileExists(path string) (matched bool, supported bool) {
	_, err := os.Stat(path)
	if err == nil {
		return true, true
	}
	if errors.Is(err, fs.ErrNotExist) {
		return false, true
	}
	slog.Warn("detection: cannot stat path, treating as undeterminable", "path", path, "error", err.Error())
	return false, false
}

// EvaluateDetectionRules evaluates a slice of DetectionRule clauses (AND
// logic) against the current device state and returns a DetectionOutcome.
//
// Platform dispatch:
//   - "file_exists"      → cross-platform os.Stat check (this file)
//   - "registry"         → evaluateRegistryRule       (platform files)
//   - "msi_product_code" → evaluateMsiProductCodeRule (platform files)
//   - "file_version"     → evaluateFileVersionRule    (platform files, Windows-only)
//   - anything else      → unsupported
func EvaluateDetectionRules(rules []DetectionRule) DetectionOutcome {
	if len(rules) == 0 {
		return DetectionOutcome{
			Detected:  false,
			Supported: false,
			Detail:    "no detection rules",
		}
	}

	for _, rule := range rules {
		matched, supported := evaluateClause(rule)
		if !supported {
			return DetectionOutcome{
				Detected:  false,
				Supported: false,
				Detail:    fmt.Sprintf("unsupported on this platform: %s", rule.Type),
			}
		}
		if !matched {
			return DetectionOutcome{
				Detected:  false,
				Supported: true,
				Detail:    ruleNotSatisfiedDetail(rule),
			}
		}
	}

	return DetectionOutcome{
		Detected:  true,
		Supported: true,
		Detail:    fmt.Sprintf("all %d rule(s) satisfied", len(rules)),
	}
}

// evaluateClause dispatches a single DetectionRule clause.
// Returns (matched, supported).
func evaluateClause(rule DetectionRule) (matched bool, supported bool) {
	switch rule.Type {
	case "file_exists":
		return evaluateFileExists(rule.Path)
	case "registry":
		return evaluateRegistryRule(rule)
	case "msi_product_code":
		return evaluateMsiProductCodeRule(rule)
	case "file_version":
		return evaluateFileVersionRule(rule)
	default:
		return false, false
	}
}

// ruleNotSatisfiedDetail builds a human-readable detail string for a failed clause.
func ruleNotSatisfiedDetail(rule DetectionRule) string {
	switch rule.Type {
	case "registry":
		hive := rule.Hive
		if hive == "" {
			hive = "HKLM"
		}
		path := strings.Join([]string{hive, rule.Path}, `\`)
		if rule.ValueName != "" {
			path += " -> " + rule.ValueName
		}
		return "rule not satisfied: registry " + path
	case "file_exists":
		return "rule not satisfied: file_exists " + rule.Path
	case "msi_product_code":
		return "rule not satisfied: msi_product_code " + rule.ProductCode
	case "file_version":
		return fmt.Sprintf("rule not satisfied: file_version %s %s %s", rule.Path, rule.Operator, rule.Version)
	default:
		return "rule not satisfied: " + rule.Type
	}
}

// parseFileVersion parses a dotted numeric version string ("1", "1.2",
// "1.2.3", "1.2.3.4") into a fixed 4-element quad. Missing trailing components
// default to 0, so "1.2" parses as {1,2,0,0}. Accepts 1–4 components; anything
// non-numeric, negative, or with more than four components is an error.
func parseFileVersion(s string) ([4]int64, error) {
	var out [4]int64
	s = strings.TrimSpace(s)
	if s == "" {
		return out, errors.New("empty version string")
	}
	parts := strings.Split(s, ".")
	if len(parts) > 4 {
		return out, fmt.Errorf("too many version components: %q", s)
	}
	for i, p := range parts {
		n, err := strconv.ParseInt(strings.TrimSpace(p), 10, 64)
		if err != nil {
			return out, fmt.Errorf("invalid version component %q in %q: %w", p, s, err)
		}
		if n < 0 {
			return out, fmt.Errorf("negative version component %q in %q", p, s)
		}
		out[i] = n
	}
	return out, nil
}

// compareFileVersions returns -1, 0 or 1 as a orders before, equal to, or
// after b, comparing component-by-component (major, minor, build, revision).
func compareFileVersions(a, b [4]int64) int {
	for i := 0; i < 4; i++ {
		switch {
		case a[i] < b[i]:
			return -1
		case a[i] > b[i]:
			return 1
		}
	}
	return 0
}

// evaluateFileVersionComparison compares an actual on-disk file version against
// the rule's target version using the given operator. It returns
// (matched, supported). Both version strings are parsed to integer quads first —
// a naive string compare would mis-order "1.10" against "1.9".
//
// An unparseable version or an unrecognized operator yields supported=false, so
// the caller falls back to exit-code behavior rather than reporting a false
// negative (mirrors the platform-unsupported contract). Schema validation
// normally prevents both, but the agent must not trust the payload blindly.
func evaluateFileVersionComparison(actual, operator, target string) (matched bool, supported bool) {
	av, err := parseFileVersion(actual)
	if err != nil {
		slog.Warn("detection: cannot parse actual file version", "version", actual, "error", err.Error())
		return false, false
	}
	tv, err := parseFileVersion(target)
	if err != nil {
		slog.Warn("detection: cannot parse target file version", "version", target, "error", err.Error())
		return false, false
	}

	cmp := compareFileVersions(av, tv)
	switch operator {
	case ">=":
		return cmp >= 0, true
	case ">":
		return cmp > 0, true
	case "==":
		return cmp == 0, true
	case "<=":
		return cmp <= 0, true
	case "<":
		return cmp < 0, true
	default:
		// Operator set is the FILE_VERSION_OPERATORS enum in
		// packages/shared/src/validators/softwareDetection.ts (the source of
		// truth). Anything else can't be evaluated → undeterminable.
		slog.Warn("detection: unknown file_version operator", "operator", operator)
		return false, false
	}
}

// normalizeVersionString converts a Win32 StringFileInfo "FileVersion" value
// into the dotted numeric form parseFileVersion accepts. Version resources
// commonly use comma separators ("1, 2, 3, 4"); anything still non-numeric after
// this (e.g. "5.0.1 (build 3)") is left for parseFileVersion to reject, so the
// caller falls back to the binary fixed-version block.
func normalizeVersionString(s string) string {
	s = strings.TrimSpace(s)
	s = strings.ReplaceAll(s, ", ", ".")
	s = strings.ReplaceAll(s, ",", ".")
	s = strings.ReplaceAll(s, " ", "")
	return s
}
