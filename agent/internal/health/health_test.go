package health

import (
	"sync"
	"testing"
)

func TestNewMonitorOverallReturnsUnknown(t *testing.T) {
	m := NewMonitor()
	if got := m.Overall(); got != Unknown {
		t.Fatalf("Overall() on empty monitor = %q, want %q", got, Unknown)
	}
}

func TestSummaryOnEmptyMonitor(t *testing.T) {
	m := NewMonitor()
	s := m.Summary()
	if s["status"] != "unknown" {
		t.Fatalf("Summary status = %v, want unknown", s["status"])
	}
	components, _ := s["components"].(map[string]string)
	if len(components) != 0 {
		t.Fatalf("Summary components = %v, want empty", components)
	}
}

func TestOverallReturnsWorstStatus(t *testing.T) {
	m := NewMonitor()
	m.Update("a", Healthy, "")
	m.Update("b", Degraded, "slow")
	m.Update("c", Healthy, "")

	if got := m.Overall(); got != Degraded {
		t.Fatalf("Overall() = %q, want %q", got, Degraded)
	}
}

func TestOverallUnhealthyWorseThanDegraded(t *testing.T) {
	m := NewMonitor()
	m.Update("a", Degraded, "")
	m.Update("b", Unhealthy, "down")

	if got := m.Overall(); got != Unhealthy {
		t.Fatalf("Overall() = %q, want %q", got, Unhealthy)
	}
}

func TestOverallUnknownIsWorstStatus(t *testing.T) {
	m := NewMonitor()
	m.Update("a", Unhealthy, "")
	m.Update("b", Unknown, "")

	if got := m.Overall(); got != Unknown {
		t.Fatalf("Overall() = %q, want %q", got, Unknown)
	}
}

func TestStatusIsValid(t *testing.T) {
	valid := []Status{Healthy, Degraded, Unhealthy, Unknown}
	for _, s := range valid {
		if !s.IsValid() {
			t.Errorf("IsValid(%q) = false, want true", s)
		}
	}

	invalid := []Status{Status("garbage"), Status(""), Status("ok")}
	for _, s := range invalid {
		if s.IsValid() {
			t.Errorf("IsValid(%q) = true, want false", s)
		}
	}
}

func TestUpdateCoercesInvalidStatus(t *testing.T) {
	m := NewMonitor()
	m.Update("test", Status("invalid"), "bad value")

	c, ok := m.Get("test")
	if !ok {
		t.Fatal("component not found after Update")
	}
	if c.Status != Unhealthy {
		t.Fatalf("Status = %q, want %q (coerced from invalid)", c.Status, Unhealthy)
	}
}

func TestSummaryAtomicity(t *testing.T) {
	m := NewMonitor()
	m.Update("comp1", Healthy, "")

	var wg sync.WaitGroup
	// Concurrent updates
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if i%2 == 0 {
				m.Update("comp1", Degraded, "test")
			} else {
				m.Update("comp1", Healthy, "")
			}
		}(i)
	}

	// Concurrent reads
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s := m.Summary()
			status, _ := s["status"].(string)
			components, _ := s["components"].(map[string]string)
			compStatus := components["comp1"]
			// Atomic consistency: overall should match the worst component
			if status != compStatus {
				// With only one component, overall must match comp1
				t.Errorf("summary inconsistency: overall=%q comp1=%q", status, compStatus)
			}
		}()
	}

	wg.Wait()
}

func TestGetReturnsCheckAndBool(t *testing.T) {
	m := NewMonitor()

	_, ok := m.Get("nonexistent")
	if ok {
		t.Fatal("Get should return false for nonexistent component")
	}

	m.Update("existing", Healthy, "fine")
	c, ok := m.Get("existing")
	if !ok {
		t.Fatal("Get should return true for existing component")
	}
	if c.Status != Healthy {
		t.Fatalf("Status = %q, want %q", c.Status, Healthy)
	}
}

func TestAllReturnsSnapshot(t *testing.T) {
	m := NewMonitor()
	m.Update("a", Healthy, "")
	m.Update("b", Degraded, "slow")

	all := m.All()
	if len(all) != 2 {
		t.Fatalf("All() returned %d checks, want 2", len(all))
	}
}
