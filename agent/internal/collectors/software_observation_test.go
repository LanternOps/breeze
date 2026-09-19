package collectors

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestBuildSoftwareObservationCompletenessAndGlobalBound(t *testing.T) {
	now := time.Date(2026, 8, 24, 12, 30, 0, 0, time.UTC)
	items := make([]SoftwareItem, collectorResultLimit+2)
	for i := range items {
		items[i] = SoftwareItem{Name: string(rune(i + 1)), Version: "1"}
	}

	tests := []struct {
		name        string
		sources     []softwareSourceResult
		want        SoftwareInventoryCompleteness
		wantCount   int
		wantTrunc   bool
		wantErrCode string
	}{
		{name: "complete with cross-source name-version dedupe", sources: []softwareSourceResult{{Source: "one", Items: []SoftwareItem{{Name: "a", Version: "1", Vendor: "first"}}}, {Source: "two", Items: []SoftwareItem{{Name: "a", Version: "1", Vendor: "second"}}}}, want: SoftwareInventoryComplete, wantCount: 1},
		{name: "partial source failure", sources: []softwareSourceResult{{Source: "one", Items: []SoftwareItem{{Name: "a"}}}, {Source: "two", FailureCode: SoftwareFailureCommandFailed}}, want: SoftwareInventoryPartial, wantCount: 1, wantErrCode: SoftwareFailureCommandFailed},
		{name: "all failed", sources: []softwareSourceResult{{Source: "one", FailureCode: SoftwareFailureSourceUnavailable}}, want: SoftwareInventoryFailed, wantErrCode: SoftwareFailureSourceUnavailable},
		{name: "truncated and deduped", sources: []softwareSourceResult{{Source: "one", Items: append(items, items[0])}}, want: SoftwareInventoryPartial, wantCount: collectorResultLimit, wantTrunc: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ids := []string{"2f1e9c33-ae52-4f07-8cee-fdb071e1dc21"}
			got := buildSoftwareObservation("9.8.7", tt.sources, func() time.Time { return now }, func() string { return ids[0] })
			if got.SchemaVersion != 2 || got.CollectorVersion != "9.8.7" || !got.ObservedAt.Equal(now) {
				t.Fatalf("metadata = %#v", got)
			}
			if _, err := uuid.Parse(got.ObservationID); err != nil {
				t.Fatalf("observation id is not RFC4122: %q: %v", got.ObservationID, err)
			}
			if got.Completeness != tt.want || got.ItemCount != tt.wantCount || got.ItemCount != len(got.Items) || got.Truncated != tt.wantTrunc {
				t.Fatalf("observation = %#v", got)
			}
			if tt.wantErrCode != "" && got.FailedSources[0].Code != tt.wantErrCode {
				t.Fatalf("failure code = %q, want %q", got.FailedSources[0].Code, tt.wantErrCode)
			}
		})
	}
}

func TestSanitizeSoftwareInventoryItemMatchesWireLimits(t *testing.T) {
	long := strings.Repeat("x", 9000)
	got := sanitizeSoftwareInventoryItem(SoftwareItem{
		Name: long, Version: long, Vendor: long, InstallDate: long,
		InstallLocation: long, UninstallString: long,
	})
	limits := map[string]struct {
		got string
		max int
	}{
		"name": {got.Name, 500}, "version": {got.Version, 100}, "vendor": {got.Vendor, 200},
		"installDate": {got.InstallDate, 64}, "installLocation": {got.InstallLocation, 4096},
		"uninstallString": {got.UninstallString, 8192},
	}
	for field, value := range limits {
		if len(value.got) > value.max || !strings.Contains(value.got, "[truncated]") {
			t.Errorf("%s length=%d value suffix=%q", field, len(value.got), value.got[max(0, len(value.got)-20):])
		}
	}
}

func TestCollectCompatibilityRejectsIncompleteObservation(t *testing.T) {
	c := NewSoftwareCollectorWithVersion("1.2.3")
	c.collectObservation = func() (SoftwareInventoryObservationV2, error) {
		return SoftwareInventoryObservationV2{
			Completeness: SoftwareInventoryPartial,
			Truncated:    true,
			Items:        []SoftwareItem{{Name: "diagnostic item"}},
		}, nil
	}

	items, err := c.Collect()
	if len(items) != 1 {
		t.Fatalf("items = %#v", items)
	}
	var incomplete *SoftwareInventoryIncompleteError
	if !errors.As(err, &incomplete) {
		t.Fatalf("error = %T %v, want SoftwareInventoryIncompleteError", err, err)
	}
}

func TestNewObservationIDsAreUnique(t *testing.T) {
	c := NewSoftwareCollectorWithVersion("1.2.3")
	a := buildSoftwareObservation(c.collectorVersion, []softwareSourceResult{{Source: "one"}}, c.now, c.newObservationID)
	b := buildSoftwareObservation(c.collectorVersion, []softwareSourceResult{{Source: "one"}}, c.now, c.newObservationID)
	if a.ObservationID == b.ObservationID {
		t.Fatalf("observation IDs repeated: %q", a.ObservationID)
	}
}
