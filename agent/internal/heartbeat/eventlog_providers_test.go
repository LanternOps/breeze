package heartbeat

import (
	"reflect"
	"testing"

	"github.com/breeze-rmm/agent/internal/collectors"
)

func TestApplyEventLogApplicationProviders(t *testing.T) {
	for _, tc := range []struct {
		name    string
		payload map[string]any
		want    []string
	}{
		{"present", map[string]any{"application_providers": []any{" Dell UPS Local Node Manager ", "bad'name", 42}}, []string{"Dell UPS Local Node Manager"}},
		{"camel case", map[string]any{"applicationProviders": []any{"MSSQL$SQLEXPRESS"}}, []string{"MSSQL$SQLEXPRESS"}},
		{"empty clears", map[string]any{"application_providers": []any{}}, nil},
		{"snake empty wins", map[string]any{"application_providers": []any{}, "applicationProviders": []any{"Wrong"}}, nil},
		{"absent preserves", map[string]any{"minimum_level": "error"}, []string{"Existing"}},
		{"non array ignored", map[string]any{"application_providers": "Wrong"}, []string{"Existing"}},
		{"null ignored", map[string]any{"application_providers": nil}, []string{"Existing"}},
		{"typed slice", map[string]any{"application_providers": []string{"UPS"}}, []string{"UPS"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := &Heartbeat{eventLogCol: collectors.NewEventLogCollector()}
			h.eventLogCol.UpdateApplicationProviders([]string{"Existing"})
			h.applyEventLogConfig(tc.payload)
			if got := h.eventLogCol.ApplicationProviders(); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("providers=%v want=%v", got, tc.want)
			}
		})
	}
}
