package tools

import (
	"os"
	"testing"
)

func TestProcessManager_ListProcesses(t *testing.T) {
	pm := NewProcessManager()
	
	processes, err := pm.ListProcesses()
	if err != nil {
		t.Fatalf("ListProcesses failed: %v", err)
	}
	
	if len(processes) == 0 {
		t.Fatal("Expected at least one process")
	}
	
	// Verify we can find our own process
	myPid := os.Getpid()
	found := false
	for _, p := range processes {
		if p.PID == myPid {
			found = true
			if p.Name == "" {
				t.Error("Process name should not be empty")
			}
			t.Logf("Found self: PID=%d, Name=%s, Status=%s, CPU=%.2f%%, Mem=%.2fMB", 
				p.PID, p.Name, p.Status, p.CPUPercent, p.MemoryMB)
			break
		}
	}
	
	if !found {
		t.Errorf("Could not find own process (PID %d) in process list", myPid)
	}
	
	t.Logf("Total processes found: %d", len(processes))
}

func TestProcessManager_GetProcessDetails(t *testing.T) {
	pm := NewProcessManager()
	
	myPid := os.Getpid()
	proc, err := pm.GetProcessDetails(myPid)
	if err != nil {
		t.Fatalf("GetProcessDetails failed: %v", err)
	}
	
	if proc.PID != myPid {
		t.Errorf("Expected PID %d, got %d", myPid, proc.PID)
	}
	
	if proc.Name == "" {
		t.Error("Process name should not be empty")
	}
	
	t.Logf("Process details: PID=%d, Name=%s, Status=%s, User=%s, PPID=%d, StartTime=%s",
		proc.PID, proc.Name, proc.Status, proc.User, proc.ParentPID, proc.StartTime)
}

func TestProcessManager_GetProcessDetails_NotFound(t *testing.T) {
	pm := NewProcessManager()
	
	// Use an invalid PID that shouldn't exist
	_, err := pm.GetProcessDetails(-1)
	if err == nil {
		t.Error("Expected error for invalid PID")
	}
	
	// Use a PID that's unlikely to exist (very high number)
	_, err = pm.GetProcessDetails(999999999)
	if err == nil {
		t.Error("Expected error for non-existent PID")
	}
}

func TestProcessManager_KillProcess_NotFound(t *testing.T) {
	pm := NewProcessManager()
	
	// Try to kill a non-existent process
	err := pm.KillProcess(999999999)
	if err == nil {
		t.Error("Expected error when killing non-existent process")
	}
}
