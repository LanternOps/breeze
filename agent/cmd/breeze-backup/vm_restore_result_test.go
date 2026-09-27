package main

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/hyperv"
)

// A failed VM restore must reach the server as a failed command that still
// carries its counts, so the restore job records how many files were lost.
func TestMarshalResult_FailedVMRestoreCarriesCounts(t *testing.T) {
	tests := []struct {
		name  string
		value any
		check func(t *testing.T, body map[string]any)
	}{
		{
			name: "vm restore from backup",
			value: &hyperv.VMRestoreFromBackupResult{
				VMName: "brzlab-h3-asvm", Status: "failed",
				FilesRestored: 0, FilesFailed: 4,
				FailedFiles: []string{`C:\brzlab\markers\m1.txt`},
				Error:       "4 of 4 files could not be restored (0 restored)",
			},
			check: func(t *testing.T, body map[string]any) {
				if body["status"] != "failed" || body["filesFailed"] != float64(4) || body["filesRestored"] != float64(0) {
					t.Fatalf("body = %v", body)
				}
			},
		},
		{
			name:  "instant boot",
			value: &hyperv.InstantBootResult{VMName: "brzlab-h4-iboot", Status: "failed", Error: "failed to restore 1 of 3 boot-critical files"},
			check: func(t *testing.T, body map[string]any) {
				if body["status"] != "failed" || body["vmName"] != "brzlab-h4-iboot" {
					t.Fatalf("body = %v", body)
				}
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := marshalResult(tt.value, errors.New("vmrestore: 4 of 4 files could not be restored"))
			if res.Success {
				t.Fatal("a failed restore was reported as a successful command")
			}
			if res.Stderr == "" {
				t.Fatal("failure reason missing")
			}
			var body map[string]any
			if err := json.Unmarshal([]byte(res.Stdout), &body); err != nil {
				t.Fatalf("failed result carries no body (%q): %v", res.Stdout, err)
			}
			tt.check(t, body)
		})
	}
}

// Other commands keep the generic contract: a failure carries no body.
func TestMarshalResult_OtherFailuresCarryNoBody(t *testing.T) {
	res := marshalResult(map[string]any{"x": 1}, errors.New("boom"))
	if res.Success || res.Stdout != "" || res.Stderr != "boom" {
		t.Fatalf("result = %+v", res)
	}
	var nilRestore *hyperv.VMRestoreFromBackupResult
	if res := marshalResult(nilRestore, errors.New("boom")); res.Stdout != "" {
		t.Fatalf("nil result produced a body: %q", res.Stdout)
	}
}
