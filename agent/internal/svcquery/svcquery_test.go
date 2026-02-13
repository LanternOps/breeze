package svcquery

import (
	"testing"
)

func TestServiceStatusConstants(t *testing.T) {
	if StatusRunning != ServiceStatus("running") {
		t.Errorf("expected running, got %s", StatusRunning)
	}
	if StatusStopped != ServiceStatus("stopped") {
		t.Errorf("expected stopped, got %s", StatusStopped)
	}
	if StatusDisabled != ServiceStatus("disabled") {
		t.Errorf("expected disabled, got %s", StatusDisabled)
	}
	if StatusUnknown != ServiceStatus("unknown") {
		t.Errorf("expected unknown, got %s", StatusUnknown)
	}
}

func TestServiceInfoIsActive(t *testing.T) {
	active := ServiceInfo{Name: "test", Status: StatusRunning}
	if !active.IsActive() {
		t.Error("running service should be active")
	}
	stopped := ServiceInfo{Name: "test", Status: StatusStopped}
	if stopped.IsActive() {
		t.Error("stopped service should not be active")
	}
}
