package collectors

import (
	"testing"
	"time"
)

func TestNewReliabilityCollectorInitialLookback(t *testing.T) {
	start := time.Now()
	collector := NewReliabilityCollector()
	if collector == nil || collector.eventLogCol == nil {
		t.Fatalf("collector or eventLogCol is nil")
	}

	minExpected := start.Add(-reliabilityInitialLookback - 5*time.Second)
	maxExpected := start.Add(-reliabilityInitialLookback + 5*time.Second)
	actual := collector.eventLogCol.lastCollectTime

	if actual.Before(minExpected) || actual.After(maxExpected) {
		t.Fatalf("unexpected lastCollectTime: got %s expected within [%s, %s]", actual, minExpected, maxExpected)
	}
}
