package monitoring

import (
	"encoding/json"
	"testing"
)

// TestWireEmptyConfigClearsRunningMonitor pins the agent half of the #2949
// contract. When no monitoring policy applies to a device any more (deleted,
// unassigned or deactivated), the API sends monitoring_settings with an EMPTY
// watch list instead of omitting the key. That only works if an agent that is
// already running watches stops the loop and drops every watch state when it
// receives that payload. This behavior has existed since monitoring first
// shipped, so agents already in the field clear correctly. The test keeps it
// from regressing.
func TestWireEmptyConfigClearsRunningMonitor(t *testing.T) {
	m := New(func(results []CheckResult) {})
	m.ApplyConfig(MonitorConfig{
		CheckIntervalSeconds: 300,
		Watches: []WatchConfig{
			{WatchType: WatchTypeService, Name: "__breeze_test_svc__"},
			{WatchType: WatchTypeProcess, Name: "__breeze_test_proc__"},
		},
	})
	t.Cleanup(m.Stop)

	m.mu.RLock()
	running := m.running
	m.mu.RUnlock()
	if !running {
		t.Fatal("precondition: monitor should be running with two watches")
	}

	// The exact body the API emits for "nothing applies", decoded the way the
	// heartbeat decodes configUpdate (JSON into map[string]any).
	var update map[string]any
	if err := json.Unmarshal([]byte(`{"monitoring_settings":{"check_interval_seconds":60,"watches":[]}}`), &update); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	cfg, ok := ParseMonitorConfig(update["monitoring_settings"])
	if !ok {
		t.Fatal("ParseMonitorConfig rejected the empty clear payload; the agent would ignore it and keep its watches")
	}
	m.ApplyConfig(cfg)

	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.running {
		t.Error("monitor still running after the empty clear payload")
	}
	if len(m.states) != 0 {
		t.Errorf("watch states not cleared: %d remain", len(m.states))
	}
	if len(m.config.Watches) != 0 {
		t.Errorf("config still carries %d watches", len(m.config.Watches))
	}
}
