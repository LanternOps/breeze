package tools

import (
	"fmt"
	"os"
	"strings"
)

// DetectionRule describes one clause in a software detection rule set.
// A package is considered detected only when ALL clauses evaluate to true.
type DetectionRule struct {
	Type string `json:"type"` // "registry" | "file_exists" | "msi_product_code"

	// registry fields
	Hive      string `json:"hive,omitempty"`      // HKLM (default) | HKCU | HKCR | HKU | HKCC
	Path      string `json:"path,omitempty"`      // registry key path, or file/dir path for file_exists
	ValueName string `json:"valueName,omitempty"` // optional value name under the key
	ValueData string `json:"valueData,omitempty"` // optional exact-match expected data

	// msi_product_code fields
	ProductCode string `json:"productCode,omitempty"` // GUID, braces optional
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

// fileExists returns true if path exists as a file or directory.
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// EvaluateDetectionRules evaluates a slice of DetectionRule clauses (AND
// logic) against the current device state and returns a DetectionOutcome.
//
// Platform dispatch:
//   - "file_exists"      → cross-platform os.Stat check (this file)
//   - "registry"         → evaluateRegistryRule    (platform files)
//   - "msi_product_code" → evaluateMsiProductCodeRule (platform files)
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
		return fileExists(rule.Path), true
	case "registry":
		return evaluateRegistryRule(rule)
	case "msi_product_code":
		return evaluateMsiProductCodeRule(rule)
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
	default:
		return "rule not satisfied: " + rule.Type
	}
}
