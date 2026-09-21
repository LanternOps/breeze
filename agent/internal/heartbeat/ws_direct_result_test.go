package heartbeat

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/websocket"
)

// TestIsWSDirectOnlyCommand pins the exact membership of the WS-direct-only
// set (#5414). Membership is NOT "it is a backup command": mssql_backup and
// hyperv_backup are deliberately absent because routes/backup/mssql.ts and
// hyperv.ts dispatch them through executeCommand -> commandQueue, which DOES
// insert a device_commands row, so their HTTP result submission is a real
// ack that must keep working. Only backup_run has a single dispatch site
// (jobs/backupWorker.ts) and never gets a row.
func TestIsWSDirectOnlyCommand(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		cmdType string
		want    bool
	}{
		{"backup_run is WS-direct only", tools.CmdBackupRun, true},
		{"mssql_backup is also queued with a row", tools.CmdMSSQLBackup, false},
		{"hyperv_backup is also queued with a row", tools.CmdHypervBackup, false},
		{"backup_restore is queued with a row", tools.CmdBackupRestore, false},
		{"backup_verify is queued with a row", tools.CmdBackupVerify, false},
		{"backup_stop is queued with a row", tools.CmdBackupStop, false},
		{"script execution is unaffected", tools.CmdScriptCancel, false},
		{"unknown type is unaffected", "definitely_not_a_command", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := isWSDirectOnlyCommand(tt.cmdType); got != tt.want {
				t.Fatalf("isWSDirectOnlyCommand(%q) = %v, want %v", tt.cmdType, got, tt.want)
			}
		})
	}
}

// TestHandleCommandHTTPResultSubmission proves the behavior the predicate
// gates: a WS-dispatched backup_run must not POST to the HTTP result route
// (there is no device_commands row, so the POST can only ever 404 — #5414),
// while a comparable non-backup command still must.
//
// MUST NOT call t.Parallel(): mutates handlerRegistry.
func TestHandleCommandHTTPResultSubmission(t *testing.T) {
	tests := []struct {
		name       string
		cmdType    string
		wantSubmit bool
	}{
		{"backup_run skips the doomed HTTP submission", tools.CmdBackupRun, false},
		{"mssql_backup still submits its HTTP result", tools.CmdMSSQLBackup, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var submissions atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				submissions.Add(1)
				w.WriteHeader(http.StatusOK)
			}))
			defer server.Close()

			orig, hadOrig := handlerRegistry[tt.cmdType]
			handlerRegistry[tt.cmdType] = func(_ *Heartbeat, _ Command) tools.CommandResult {
				return tools.CommandResult{Status: "completed", Stdout: `{"started":true}`}
			}
			t.Cleanup(func() {
				if hadOrig {
					handlerRegistry[tt.cmdType] = orig
				} else {
					delete(handlerRegistry, tt.cmdType)
				}
			})

			h := &Heartbeat{
				stopChan: make(chan struct{}),
				config: &config.Config{
					ServerURL: server.URL,
					AgentID:   "agent-5414",
					AuthToken: "token-5414",
				},
				client: server.Client(),
			}
			h.accepting.Store(true)

			result := h.HandleCommand(websocket.Command{ID: "11111111-2222-3333-4444-555555555555", Type: tt.cmdType})
			if result.Status != "completed" {
				t.Fatalf("WS result status = %q, want completed", result.Status)
			}

			// The submission is fired from a goroutine; give it a bounded
			// window to land rather than racing it.
			deadline := time.Now().Add(2 * time.Second)
			for time.Now().Before(deadline) && submissions.Load() == 0 {
				time.Sleep(10 * time.Millisecond)
			}

			got := submissions.Load() > 0
			if got != tt.wantSubmit {
				t.Fatalf("HTTP result submitted = %v (count %d), want %v", got, submissions.Load(), tt.wantSubmit)
			}
		})
	}
}
