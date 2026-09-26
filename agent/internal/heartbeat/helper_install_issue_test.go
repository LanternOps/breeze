package heartbeat

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/helper"
)

// #6925: helperInstallIssue is omitted when there is no issue, so a healthy
// device (and any server predating the field) sees an unchanged payload, and
// carries the helper package's code when there is one.
func TestHeartbeatPayloadHelperInstallIssueWire(t *testing.T) {
	healthy, err := json.Marshal(HeartbeatPayload{Status: "ok", AgentVersion: "1.0.0"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(healthy), "helperInstallIssue") {
		t.Fatalf("healthy payload carries helperInstallIssue: %s", healthy)
	}

	stuck, err := json.Marshal(HeartbeatPayload{
		Status:             "ok",
		AgentVersion:       "1.0.0",
		HelperInstallIssue: helper.InstallIssueAwaitingServerOffer,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(stuck), `"helperInstallIssue":"awaiting_server_offer"`) {
		t.Fatalf("payload missing helperInstallIssue code: %s", stuck)
	}
}
