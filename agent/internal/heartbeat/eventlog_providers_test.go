package heartbeat

import (
	"bytes"
	"log/slog"
	"reflect"
	"strings"
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

func TestApplyEventLogApplicationProvidersWarnsOnNonArray(t *testing.T) {
	for _, tc := range []struct {
		name     string
		value    any
		wantType string
	}{
		{"string", "Wrong", "string"},
		{"null", nil, "<nil>"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			previous := log
			log = slog.New(slog.NewTextHandler(&logs, nil))
			t.Cleanup(func() { log = previous })
			h := &Heartbeat{eventLogCol: collectors.NewEventLogCollector()}
			h.eventLogCol.UpdateApplicationProviders([]string{"Existing"})
			h.applyEventLogConfig(map[string]any{"application_providers": tc.value})
			if got := h.eventLogCol.ApplicationProviders(); !reflect.DeepEqual(got, []string{"Existing"}) {
				t.Fatalf("providers=%v; want unchanged Existing", got)
			}
			for _, want := range []string{"level=WARN", "event log application_providers is not an array; keeping current list", "type=" + tc.wantType} {
				if !strings.Contains(logs.String(), want) {
					t.Errorf("logs=%q; want %q", logs.String(), want)
				}
			}
		})
	}
}

func TestApplyEventLogApplicationProvidersRejectsNonStrings(t *testing.T) {
	var logs bytes.Buffer
	previous := log
	log = slog.New(slog.NewTextHandler(&logs, nil))
	t.Cleanup(func() { log = previous })
	h := &Heartbeat{eventLogCol: collectors.NewEventLogCollector()}
	payload := map[string]any{"application_providers": []any{"UPS", "bad'name", 42, true, nil}}
	h.applyEventLogConfig(payload)
	if got := h.eventLogCol.ApplicationProviders(); !reflect.DeepEqual(got, []string{"UPS"}) {
		t.Fatalf("providers=%v; want only UPS", got)
	}
	if got, want := h.eventLogRejectedProviders, []string{"bad'name", "42", "true", "<nil>"}; !reflect.DeepEqual(got, want) {
		t.Errorf("rejected=%v; want %v", got, want)
	}
	for _, want := range []string{"level=WARN", "rejected event log application providers (invalid name or over the 20-provider limit)", "bad'name 42 true <nil>"} {
		if !strings.Contains(logs.String(), want) {
			t.Errorf("logs=%q; want %q", logs.String(), want)
		}
	}
	logs.Reset()
	h.applyEventLogConfig(payload)
	if strings.Contains(logs.String(), "level=WARN") {
		t.Errorf("unchanged rejected values warned again: %q", logs.String())
	}
}
