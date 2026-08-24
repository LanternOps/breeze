package health

import (
	"encoding/json"
	"sync"
	"testing"
	"time"
)

func TestNewMonitorOverallReturnsUnknown(t *testing.T) {
	m := NewMonitor()
	if got := m.Overall(); got != Unknown {
		t.Fatalf("Overall() on empty monitor = %q, want %q", got, Unknown)
	}
}

func TestSnapshotOnEmptyMonitor(t *testing.T) {
	m := NewMonitor()
	observedAt := time.Date(2026, 8, 24, 12, 0, 0, 123456789, time.FixedZone("test", -6*60*60))
	s := m.Snapshot(SnapshotMetadata{
		DeviceID:     "550e8400-e29b-41d4-a716-446655440000",
		AgentVersion: "1.2.3",
		ObservedAt:   observedAt,
	})
	if s.SchemaVersion != 1 {
		t.Fatalf("Snapshot schemaVersion = %d, want 1", s.SchemaVersion)
	}
	if s.Overall != "unknown" {
		t.Fatalf("Snapshot overall = %v, want unknown", s.Overall)
	}
	if len(s.Components) != 0 {
		t.Fatalf("Snapshot components = %v, want empty", s.Components)
	}
	if s.MetricsAvailable != nil {
		t.Fatalf("Snapshot metricsAvailable = %v, want nil", s.MetricsAvailable)
	}
	if s.DeviceID != "550e8400-e29b-41d4-a716-446655440000" || s.AgentVersion != "1.2.3" {
		t.Fatalf("Snapshot identity = (%q, %q), want configured identity", s.DeviceID, s.AgentVersion)
	}
	if !s.ObservedAt.Equal(observedAt.UTC()) || s.ObservedAt.Location() != time.UTC {
		t.Fatalf("Snapshot observedAt = %s (%s), want %s UTC", s.ObservedAt, s.ObservedAt.Location(), observedAt.UTC())
	}
}

func TestSnapshotMapsEveryHealthStatusAndReason(t *testing.T) {
	tests := []struct {
		name       string
		status     Status
		want       AgentHealthState
		message    string
		wantReason string
	}{
		{name: "healthy", status: Healthy, want: AgentHealthHealthy},
		{name: "degraded", status: Degraded, want: AgentHealthWarning, message: "slow", wantReason: "slow"},
		{name: "unhealthy", status: Unhealthy, want: AgentHealthError, message: "down", wantReason: "down"},
		{name: "unknown", status: Unknown, want: AgentHealthUnknown, message: "not checked", wantReason: "not checked"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := NewMonitor()
			m.Update("component", tt.status, tt.message)
			got := m.Snapshot(SnapshotMetadata{ObservedAt: time.Now()})
			if got.Overall != tt.want {
				t.Fatalf("overall = %q, want %q", got.Overall, tt.want)
			}
			component := got.Components["component"]
			if component.State != tt.want || component.Reason != tt.wantReason {
				t.Fatalf("component = %#v, want state=%q reason=%q", component, tt.want, tt.wantReason)
			}
		})
	}
}

func TestSnapshotJSONPreservesNullableMetricsAndOmitsEmptyOptionalIdentityAndReason(t *testing.T) {
	m := NewMonitor()
	m.Update("metrics", Healthy, "")
	got := m.Snapshot(SnapshotMetadata{
		AgentVersion: "1.2.3",
		ObservedAt:   time.Date(2026, 8, 24, 12, 0, 0, 123456789, time.UTC),
	})
	body, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}

	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["metricsAvailable"] != nil {
		t.Fatalf("metricsAvailable = %#v, want JSON null", decoded["metricsAvailable"])
	}
	if _, ok := decoded["deviceId"]; ok {
		t.Fatalf("deviceId should be omitted when empty: %s", body)
	}
	components := decoded["components"].(map[string]any)
	metrics := components["metrics"].(map[string]any)
	if _, ok := metrics["reason"]; ok {
		t.Fatalf("empty reason should be omitted: %s", body)
	}
	if got.ObservedAt.Format(time.RFC3339Nano) != "2026-08-24T12:00:00.123456789Z" {
		t.Fatalf("observedAt = %s, want RFC3339Nano UTC", got.ObservedAt.Format(time.RFC3339Nano))
	}
}

func TestSnapshotCopiesMonitorState(t *testing.T) {
	m := NewMonitor()
	m.Update("metrics", Degraded, "first")
	snapshot := m.Snapshot(SnapshotMetadata{ObservedAt: time.Now()})

	snapshot.Components["metrics"] = AgentHealthComponent{State: AgentHealthHealthy}
	m.Update("metrics", Unhealthy, "second")

	check, ok := m.Get("metrics")
	if !ok || check.Status != Unhealthy || check.Message != "second" {
		t.Fatalf("snapshot mutation changed monitor state: %#v, %v", check, ok)
	}
	if snapshot.Overall != AgentHealthWarning {
		t.Fatalf("later monitor update changed returned snapshot overall = %q", snapshot.Overall)
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

func TestSnapshotAtomicity(t *testing.T) {
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
			s := m.Snapshot(SnapshotMetadata{ObservedAt: time.Now()})
			compStatus := s.Components["comp1"].State
			// Atomic consistency: overall should match the worst component
			if s.Overall != compStatus {
				// With only one component, overall must match comp1
				t.Errorf("snapshot inconsistency: overall=%q comp1=%q", s.Overall, compStatus)
			}
		}()
	}

	wg.Wait()
}

func TestSnapshotMetricsAvailabilityCopiesBothBooleanValues(t *testing.T) {
	m := NewMonitor()
	for _, want := range []bool{true, false} {
		want := want
		got := m.Snapshot(SnapshotMetadata{MetricsAvailable: &want, ObservedAt: time.Now()})
		if got.MetricsAvailable == nil || *got.MetricsAvailable != want {
			t.Fatalf("metricsAvailable = %v, want %v", got.MetricsAvailable, want)
		}
		want = !want
		if *got.MetricsAvailable == want {
			t.Fatal("snapshot retained caller's mutable bool pointer")
		}
	}
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
