package mgmtdetect

import (
	"testing"
)

func TestCollectPostureReturnsResult(t *testing.T) {
	posture := CollectPosture()

	if posture.CollectedAt.IsZero() {
		t.Error("CollectedAt should not be zero")
	}
	if posture.ScanDurationMs < 0 {
		t.Error("ScanDurationMs should not be negative")
	}
	if posture.Categories == nil {
		t.Error("Categories should not be nil")
	}
	if posture.Identity.Source == "" {
		t.Error("Identity.Source should not be empty")
	}
	t.Logf("Posture scan completed in %dms with %d errors", posture.ScanDurationMs, len(posture.Errors))
	for cat, dets := range posture.Categories {
		t.Logf("  %s: %d detections", cat, len(dets))
		for _, d := range dets {
			t.Logf("    - %s [%s]", d.Name, d.Status)
		}
	}
}
