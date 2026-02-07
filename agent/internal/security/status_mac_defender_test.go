package security

import "testing"

func TestParseMacDefenderHealth(t *testing.T) {
	input := `{
		"app_version": "101.24012.0003",
		"real_time_protection_enabled": true,
		"definitions_version": "1.405.22.0",
		"definitions_updated_minutes_ago": 15,
		"definitions_status": "up_to_date",
		"last_quick_scan": "2026-02-07T10:11:12Z",
		"last_full_scan": "2026-02-06T01:02:03Z"
	}`

	status, product, err := parseMacDefenderHealth(input)
	if err != nil {
		t.Fatalf("parseMacDefenderHealth returned error: %v", err)
	}

	if !status.Enabled {
		t.Fatalf("expected status.Enabled to be true")
	}
	if !status.RealTimeProtection {
		t.Fatalf("expected status.RealTimeProtection to be true")
	}
	if status.ProviderVersion != "101.24012.0003" {
		t.Fatalf("unexpected provider version: %q", status.ProviderVersion)
	}
	if status.DefinitionsVersion != "1.405.22.0" {
		t.Fatalf("unexpected definitions version: %q", status.DefinitionsVersion)
	}
	if status.LastQuickScan != "2026-02-07T10:11:12Z" {
		t.Fatalf("unexpected quick scan timestamp: %q", status.LastQuickScan)
	}
	if status.LastFullScan != "2026-02-06T01:02:03Z" {
		t.Fatalf("unexpected full scan timestamp: %q", status.LastFullScan)
	}
	if status.DefinitionsUpdatedAt == "" {
		t.Fatalf("expected definitions updated timestamp to be populated")
	}

	if product.Provider != "windows_defender" {
		t.Fatalf("unexpected provider: %q", product.Provider)
	}
	if !product.RealTimeProtection {
		t.Fatalf("expected product.RealTimeProtection to be true")
	}
	if !product.DefinitionsUpToDate {
		t.Fatalf("expected product.DefinitionsUpToDate to be true")
	}
}
