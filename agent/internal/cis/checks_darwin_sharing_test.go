//go:build darwin

package cis

import (
	"testing"
)

func TestSharingAndSecurityChecksCount(t *testing.T) {
	checks := sharingAndSecurityChecks()
	if len(checks) != 15 {
		t.Errorf("expected 15 checks, got %d", len(checks))
	}
}

func TestSharingAndSecurityChecksUniqueIDs(t *testing.T) {
	checks := sharingAndSecurityChecks()
	ids := make(map[string]bool, len(checks))
	for _, c := range checks {
		if ids[c.ID] {
			t.Errorf("duplicate check ID: %s", c.ID)
		}
		ids[c.ID] = true
	}
}

func TestSharingAndSecurityChecksMetadata(t *testing.T) {
	validSeverities := map[string]bool{"low": true, "medium": true, "high": true, "critical": true}
	validLevels := map[string]bool{"l1": true, "l2": true}

	for _, c := range sharingAndSecurityChecks() {
		t.Run(c.ID, func(t *testing.T) {
			if c.Title == "" {
				t.Error("Title is empty")
			}
			if !validSeverities[c.Severity] {
				t.Errorf("invalid severity: %s", c.Severity)
			}
			if !validLevels[c.Level] {
				t.Errorf("invalid level: %s", c.Level)
			}
			if c.Fn == nil {
				t.Error("Fn is nil")
			}
		})
	}
}

func TestAllSharingChecksReturnValidResult(t *testing.T) {
	validStatuses := map[string]bool{"pass": true, "fail": true, "error": true, "not_applicable": true}

	for _, c := range sharingAndSecurityChecks() {
		t.Run(c.ID, func(t *testing.T) {
			result := c.Fn()
			if result.CheckID == "" {
				t.Error("CheckID is empty")
			}
			if result.CheckID != c.ID {
				t.Errorf("CheckID mismatch: check registered as %q but returned %q", c.ID, result.CheckID)
			}
			if !validStatuses[result.Status] {
				t.Errorf("invalid status: %q", result.Status)
			}
			if result.Message == "" {
				t.Error("Message is empty")
			}
			if result.Status == "pass" || result.Status == "fail" {
				if result.Evidence == nil {
					t.Error("Evidence is nil for pass/fail result")
				}
			}
		})
	}
}

func TestPlatformChecksIncludesSharing(t *testing.T) {
	all := platformChecks()
	// Original 8 + 15 new = 23 total
	if len(all) != 23 {
		t.Errorf("expected 23 total platform checks, got %d", len(all))
	}
}
