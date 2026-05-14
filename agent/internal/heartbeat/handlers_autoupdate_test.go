package heartbeat

import (
	"encoding/json"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func TestHandleSetAutoUpdateChangeToTrue(t *testing.T) {
	h := &Heartbeat{
		config: &config.Config{
			AutoUpdate: false,
		},
	}

	result := handleSetAutoUpdate(h, Command{
		Type: tools.CmdSetAutoUpdate,
		Payload: map[string]any{
			"enabled": true,
		},
	})

	// In-memory config must be updated
	if !h.config.AutoUpdate {
		t.Fatal("expected h.config.AutoUpdate to be true after setting enabled=true")
	}

	// Status may be "completed" (if config persists) or "failed" (test environment)
	// but the in-memory state should be updated
	if result.Status != "completed" && result.Status != "failed" {
		t.Fatalf("unexpected result status: %s", result.Status)
	}
}

func TestHandleSetAutoUpdateChangeToFalse(t *testing.T) {
	h := &Heartbeat{
		config: &config.Config{
			AutoUpdate: true,
		},
	}

	result := handleSetAutoUpdate(h, Command{
		Type: tools.CmdSetAutoUpdate,
		Payload: map[string]any{
			"enabled": false,
		},
	})

	// In-memory config must be updated
	if h.config.AutoUpdate {
		t.Fatal("expected h.config.AutoUpdate to be false after setting enabled=false")
	}

	if result.Status != "completed" && result.Status != "failed" {
		t.Fatalf("unexpected result status: %s", result.Status)
	}
}

func TestHandleSetAutoUpdateMissingPayload(t *testing.T) {
	h := &Heartbeat{
		config: &config.Config{
			AutoUpdate: true,
		},
	}

	// When enabled key is missing, GetPayloadBool defaults to false
	_ = handleSetAutoUpdate(h, Command{
		Type:    tools.CmdSetAutoUpdate,
		Payload: map[string]any{},
	})

	// Should default to false when not provided
	if h.config.AutoUpdate {
		t.Fatal("expected h.config.AutoUpdate to be false when enabled is missing")
	}
}

func TestHandleSetAutoUpdateResponsePayload(t *testing.T) {
	h := &Heartbeat{
		config: &config.Config{
			AutoUpdate: false,
		},
	}

	result := handleSetAutoUpdate(h, Command{
		Type: tools.CmdSetAutoUpdate,
		Payload: map[string]any{
			"enabled": true,
		},
	})

	// When successful, result data is in Stdout as JSON
	if result.Status == "completed" {
		var data map[string]any
		if err := json.Unmarshal([]byte(result.Stdout), &data); err != nil {
			t.Fatalf("failed to unmarshal result: %v", err)
		}
		enabled, ok := data["enabled"]
		if !ok || enabled != true {
			t.Fatal("expected enabled=true in result data")
		}
	}
}
