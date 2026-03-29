package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func TestMSSQLHandlersRegistered(t *testing.T) {
	cmds := []string{
		tools.CmdMSSQLDiscover,
		tools.CmdMSSQLBackup,
		tools.CmdMSSQLRestore,
		tools.CmdMSSQLVerify,
	}
	for _, cmd := range cmds {
		if _, ok := handlerRegistry[cmd]; !ok {
			t.Errorf("handler not registered for %q", cmd)
		}
	}
}

func TestMSSQLHandlerConstants(t *testing.T) {
	tests := []struct {
		name     string
		constant string
		expected string
	}{
		{"CmdMSSQLDiscover", tools.CmdMSSQLDiscover, "mssql_discover"},
		{"CmdMSSQLBackup", tools.CmdMSSQLBackup, "mssql_backup"},
		{"CmdMSSQLRestore", tools.CmdMSSQLRestore, "mssql_restore"},
		{"CmdMSSQLVerify", tools.CmdMSSQLVerify, "mssql_verify"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.constant != tt.expected {
				t.Fatalf("expected %q, got %q", tt.expected, tt.constant)
			}
		})
	}
}
