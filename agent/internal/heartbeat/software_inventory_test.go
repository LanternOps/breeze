package heartbeat

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/config"
)

func TestSendSoftwareInventoryUploadsV2IncompleteEvidenceWithRunningVersion(t *testing.T) {
	received := make(chan collectors.SoftwareInventoryObservationV2, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/api/v1/agents/agent-1/software" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		var report collectors.SoftwareInventoryObservationV2
		if err := json.NewDecoder(r.Body).Decode(&report); err != nil {
			t.Errorf("decode: %v", err)
		}
		received <- report
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	h := NewWithVersion(&config.Config{AgentID: "agent-1", AuthToken: "token", ServerURL: server.URL}, "6.7.8", nil, nil)
	h.softwareObservationFn = func() (collectors.SoftwareInventoryObservationV2, error) {
		return collectors.SoftwareInventoryObservationV2{
			SchemaVersion: 2, ObservationID: "89c5b6c4-e185-4e24-8467-dc17c82b8233",
			CollectorVersion: "6.7.8", ObservedAt: time.Date(2026, 8, 24, 1, 2, 3, 0, time.UTC),
			Completeness:    collectors.SoftwareInventoryPartial,
			ExpectedSources: []string{"one", "two"}, SucceededSources: []string{"one"},
			FailedSources: []collectors.SoftwareSourceFailure{{Source: "two", Code: collectors.SoftwareFailureCommandFailed}},
			Items:         []collectors.SoftwareItem{{Name: "diagnostic"}}, ItemCount: 1,
		}, nil
	}
	h.sendSoftwareInventory()

	select {
	case got := <-received:
		if got.SchemaVersion != 2 || got.CollectorVersion != "6.7.8" || got.Completeness != collectors.SoftwareInventoryPartial || got.ItemCount != 1 {
			t.Fatalf("report=%#v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("software observation was not uploaded")
	}
}
